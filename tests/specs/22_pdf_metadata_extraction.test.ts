import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const CLI = resolve(ROOT, 'apps/cli/dist/index.js');
const FIXTURE_DIR = resolve(ROOT, 'fixtures/raw');
const NATIVE_TEXT_PDF = resolve(FIXTURE_DIR, 'native-text-sample.pdf');
const SCANNED_PDF = resolve(FIXTURE_DIR, 'scanned-sample.pdf');

const PG_CONTAINER = 'mulder-pg-test';
const PG_USER = 'mulder';
const PG_PASSWORD = 'mulder';

let tmpDir: string;
let pgAvailable: boolean;

/**
 * Black-box QA tests for Issue #44: Lightweight PDF Metadata Extraction
 *
 * Validates that the ingest step extracts PDF metadata without decompressing
 * page content, gates page count before full parse, stores metadata in JSONB,
 * and handles corrupt/encrypted PDFs gracefully.
 *
 * Tests interact through system boundaries only: CLI subprocess, SQL via
 * docker exec psql, and filesystem. Never imports from packages/ or apps/.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function runCli(
	args: string[],
	opts?: { env?: Record<string, string>; timeout?: number; cwd?: string },
): { stdout: string; stderr: string; exitCode: number } {
	const result = spawnSync('node', [CLI, ...args], {
		cwd: opts?.cwd ?? ROOT,
		encoding: 'utf-8',
		timeout: opts?.timeout ?? 30000,
		stdio: ['pipe', 'pipe', 'pipe'],
		env: { ...process.env, PGPASSWORD: PG_PASSWORD, ...opts?.env },
	});
	return {
		stdout: result.stdout ?? '',
		stderr: result.stderr ?? '',
		exitCode: result.status ?? 1,
	};
}

function runSql(sql: string): string {
	const result = spawnSync(
		'docker',
		['exec', PG_CONTAINER, 'psql', '-U', PG_USER, '-d', 'mulder', '-t', '-A', '-c', sql],
		{ encoding: 'utf-8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] },
	);
	if (result.status !== 0) {
		throw new Error(`psql failed (exit ${result.status}): ${result.stderr}`);
	}
	return (result.stdout ?? '').trim();
}

function isPgAvailable(): boolean {
	try {
		const result = spawnSync('docker', ['exec', PG_CONTAINER, 'pg_isready', '-U', PG_USER], {
			encoding: 'utf-8',
			timeout: 5000,
		});
		return result.status === 0;
	} catch {
		return false;
	}
}

function cleanSourceData(): void {
	runSql('DELETE FROM source_steps; DELETE FROM sources;');
}

function writeTestConfig(overrides?: { max_pages?: number }): string {
	const maxPages = overrides?.max_pages ?? 2000;
	const configContent = `
project:
  name: "mulder-ufo-archive"
  description: "test"
  supported_locales: ["en"]

gcp:
  project_id: "mulder-platform"
  region: "europe-west1"
  cloud_sql:
    instance_name: "mulder-db"
    database: "mulder"
    tier: "db-custom-2-8192"
    host: "localhost"
    port: 5432
    user: "mulder"
  storage:
    bucket: "mulder-bucket"
  document_ai:
    processor_id: "66cbfd75679f38a8"

dev_mode: true

ingestion:
  max_pages: ${maxPages}

ontology:
  entity_types:
    - name: "person"
      description: "A test entity"
      attributes:
        - name: "role"
          type: "string"
  relationships: []
`;
	const configPath = join(tmpDir, 'mulder.config.yaml');
	writeFileSync(configPath, configContent);
	return configPath;
}

/**
 * Creates a minimal valid PDF with a specified number of pages.
 * Uses the bare minimum PDF structure: header, pages tree, page objects,
 * xref table, and trailer. No content streams — just structural objects.
 */
function createMinimalPdf(pageCount: number): Buffer {
	// Build PDF objects
	const objects: string[] = [];

	// Object 1: Catalog
	objects.push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj');

	// Object 2: Pages tree root
	const kidsRefs = Array.from({ length: pageCount }, (_, i) => `${i + 3} 0 R`).join(' ');
	objects.push(`2 0 obj\n<< /Type /Pages /Kids [ ${kidsRefs} ] /Count ${pageCount} >>\nendobj`);

	// Page objects (3, 4, 5, ...)
	for (let i = 0; i < pageCount; i++) {
		objects.push(`${i + 3} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [ 0 0 612 792 ] >>\nendobj`);
	}

	// Build the PDF content
	let content = '%PDF-1.4\n';
	const offsets: number[] = [];

	for (const obj of objects) {
		offsets.push(Buffer.byteLength(content, 'latin1'));
		content += `${obj}\n`;
	}

	// Cross-reference table
	const xrefOffset = Buffer.byteLength(content, 'latin1');
	const totalObjects = objects.length + 1; // +1 for the free entry at 0
	content += `xref\n0 ${totalObjects}\n`;
	content += '0000000000 65535 f \n';
	for (const offset of offsets) {
		content += `${String(offset).padStart(10, '0')} 00000 n \n`;
	}

	content += `trailer\n<< /Size ${totalObjects} /Root 1 0 R >>\n`;
	content += `startxref\n${xrefOffset}\n%%EOF\n`;

	return Buffer.from(content, 'latin1');
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeAll(() => {
	tmpDir = mkdtempSync(join(tmpdir(), 'mulder-qa-44-'));
	pgAvailable = isPgAvailable();
	if (pgAvailable) {
		// Ensure migrations are applied — the schema may have been destroyed by
		// other specs (e.g., spec 12's docker compose down -v) during the full suite.
		const configPath = writeTestConfig();
		runCli(['db', 'migrate', configPath], { cwd: tmpDir });
	}
});

afterAll(() => {
	if (tmpDir) {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Issue #44: Lightweight PDF Metadata Extraction', () => {
	// ─── QA-01: Page count extracted without decompressing page content ───

	it('QA-01: extractPdfMetadata reads page count from fixture PDFs correctly', () => {
		// Given: A known 3-page PDF (native-text-sample.pdf) and a 1-page PDF (scanned-sample.pdf)
		// When: We ingest them in dry-run mode (which triggers metadata extraction)
		// Then: The page count in the output matches the known truth

		writeTestConfig();

		// native-text-sample.pdf is known to have 3 pages
		const result3 = runCli(['ingest', NATIVE_TEXT_PDF, '--dry-run'], { cwd: tmpDir });
		expect(result3.exitCode).toBe(0);
		// The CLI output table shows page count
		expect(result3.stdout).toContain('3');

		// scanned-sample.pdf is known to have 1 page
		const result1 = runCli(['ingest', SCANNED_PDF, '--dry-run'], { cwd: tmpDir });
		expect(result1.exitCode).toBe(0);
		expect(result1.stdout).toContain('1');
	});

	// ─── QA-02: Page count gate rejects before pdf-parse ───

	it('QA-02: ingest rejects PDFs exceeding max_pages before full parse', () => {
		// Given: A config with max_pages: 2, and a 3-page PDF
		// When: We ingest the 3-page PDF
		// Then: Ingest fails with INGEST_TOO_MANY_PAGES error

		writeTestConfig({ max_pages: 2 });

		const result = runCli(['ingest', NATIVE_TEXT_PDF, '--dry-run'], { cwd: tmpDir });
		expect(result.exitCode).not.toBe(0);

		const combined = result.stdout + result.stderr;
		expect(combined).toContain('INGEST_TOO_MANY_PAGES');
		// Should mention the actual page count (3) and the limit (2)
		expect(combined).toMatch(/3.*pages|pages.*3/i);
	});

	// ─── QA-03: PDF metadata stored in sources.metadata JSONB ───

	it('QA-03: PDF metadata fields stored in sources.metadata JSONB after ingest', () => {
		if (!pgAvailable) return;
		// Given: A valid PDF with known metadata (created by pdf-lib)
		// When: The PDF is ingested (non-dry-run, with DB)
		// Then: The sources.metadata JSONB contains pdf_version, creator, creation_date etc.

		cleanSourceData();
		writeTestConfig();

		const result = runCli(['ingest', NATIVE_TEXT_PDF], { cwd: tmpDir });
		expect(result.exitCode).toBe(0);

		// Query the metadata JSONB column
		const metadataRaw = runSql("SELECT metadata::text FROM sources WHERE filename = 'native-text-sample.pdf';");
		expect(metadataRaw).not.toBe('');

		const metadata = JSON.parse(metadataRaw);

		// pdf-lib created PDFs have these fields
		expect(metadata.pdf_version).toBe('1.7');
		expect(metadata.producer).toContain('pdf-lib');
		expect(metadata.creator).toContain('pdf-lib');
		expect(metadata.creation_date).toBeDefined();

		cleanSourceData();
	});

	// ─── QA-04: Corrupt/truncated PDFs handled gracefully ───

	it('QA-04: corrupt PDF does not crash — returns partial metadata gracefully', () => {
		// Given: A truncated/corrupt PDF file (valid header but garbage content)
		// When: We ingest it in dry-run mode
		// Then: The process does not crash. It may fail with a validation error
		//       but should NOT produce an unhandled exception or segfault.

		const corruptPdf = join(tmpDir, 'corrupt.pdf');
		// Valid PDF header followed by garbage
		writeFileSync(corruptPdf, Buffer.from('%PDF-1.4\n%garbage\n%%EOF\n'));

		writeTestConfig();

		const result = runCli(['ingest', corruptPdf, '--dry-run'], { cwd: tmpDir });

		// The key assertion: the process exits cleanly (not a crash/segfault)
		// Exit code may be 0 (treated as 0-page PDF) or 1 (validation error) — both are acceptable
		expect(result.exitCode).toBeLessThanOrEqual(1);

		// Should NOT contain unhandled promise rejection or stack trace of an unexpected crash
		expect(result.stderr).not.toContain('UnhandledPromiseRejection');
		expect(result.stderr).not.toContain('SIGSEGV');
	});

	// ─── QA-05: Works in CI (no system dependency) ───

	it('QA-05: metadata extraction works without system dependencies', () => {
		// Given: A valid PDF
		// When: We ingest it in dry-run mode (no external tools like pdfinfo required)
		// Then: The page count is correctly extracted using only Node.js built-in modules + npm packages

		writeTestConfig();

		const result = runCli(['ingest', NATIVE_TEXT_PDF, '--dry-run'], { cwd: tmpDir });
		expect(result.exitCode).toBe(0);
		// If we got a valid result, no system dependency was needed
		expect(result.stdout).toContain('native-text-sample.pdf');
	});

	// ─── QA-06: Page count gate works with synthetic PDFs ───

	it('QA-06: page count gate rejects a synthetic PDF with many pages', () => {
		// Given: A synthetic minimal PDF with 100 pages, and max_pages config of 50
		// When: We ingest it
		// Then: It is rejected with INGEST_TOO_MANY_PAGES

		const manyPagesPdf = join(tmpDir, 'many-pages.pdf');
		writeFileSync(manyPagesPdf, createMinimalPdf(100));

		writeTestConfig({ max_pages: 50 });

		const result = runCli(['ingest', manyPagesPdf, '--dry-run'], { cwd: tmpDir });
		expect(result.exitCode).not.toBe(0);

		const combined = result.stdout + result.stderr;
		expect(combined).toContain('INGEST_TOO_MANY_PAGES');
	});

	it('QA-07: page count gate passes a synthetic PDF within limits', () => {
		// Given: A synthetic minimal PDF with 5 pages, and max_pages config of 50
		// When: We ingest it in dry-run mode
		// Then: It passes validation (exit code 0)

		const smallPdf = join(tmpDir, 'small.pdf');
		writeFileSync(smallPdf, createMinimalPdf(5));

		writeTestConfig({ max_pages: 50 });

		const result = runCli(['ingest', smallPdf, '--dry-run'], { cwd: tmpDir });
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain('small.pdf');
	});

	// ─── QA-08: Biome lint passes ───

	it('QA-08: biome lint passes on all source files', () => {
		const result = spawnSync('npx', ['biome', 'check', '.'], {
			cwd: ROOT,
			encoding: 'utf-8',
			timeout: 30000,
		});
		const output = (result.stdout ?? '') + (result.stderr ?? '');
		const errorCount = output.match(/Found (\d+) error/);
		const errors = errorCount ? Number.parseInt(errorCount[1], 10) : 0;
		expect(errors).toBe(0);
	});
});
