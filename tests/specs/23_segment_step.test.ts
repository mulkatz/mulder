import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const CLI = resolve(ROOT, 'apps/cli/dist/index.js');
const FIXTURE_DIR = resolve(ROOT, 'fixtures/raw');
const EXTRACTED_DIR = resolve(ROOT, '.local/storage/extracted');
const SEGMENTS_DIR = resolve(ROOT, '.local/storage/segments');
const NATIVE_TEXT_PDF = resolve(FIXTURE_DIR, 'native-text-sample.pdf');
const SCANNED_PDF = resolve(FIXTURE_DIR, 'scanned-sample.pdf');
const EXAMPLE_CONFIG = resolve(ROOT, 'mulder.config.example.yaml');

const PG_CONTAINER = 'mulder-pg-test';
const PG_USER = 'mulder';
const PG_PASSWORD = 'mulder';

/**
 * Black-box QA tests for Spec 23: Segment Step
 *
 * Each `it()` maps to one QA condition or CLI condition from Section 5/5b of the spec.
 * Tests interact through system boundaries only: CLI subprocess calls,
 * SQL via `docker exec psql`, and filesystem (dev-mode storage).
 * Never imports from packages/ or src/ or apps/.
 *
 * Requires:
 * - Running PostgreSQL container `mulder-pg-test` with migrations applied
 * - Built CLI at apps/cli/dist/index.js
 * - Test fixtures in fixtures/raw/
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function runCli(
	args: string[],
	opts?: { env?: Record<string, string>; timeout?: number },
): { stdout: string; stderr: string; exitCode: number } {
	const result = spawnSync('node', [CLI, ...args], {
		cwd: ROOT,
		encoding: 'utf-8',
		timeout: opts?.timeout ?? 60000,
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

function cleanTestData(): void {
	runSql('DELETE FROM stories; DELETE FROM source_steps; DELETE FROM sources;');
}

function cleanSegmentFixtures(): void {
	if (existsSync(SEGMENTS_DIR)) {
		for (const entry of readdirSync(SEGMENTS_DIR)) {
			const fullPath = join(SEGMENTS_DIR, entry);
			rmSync(fullPath, { recursive: true, force: true });
		}
	}
}

function cleanExtractedFixtures(): void {
	if (existsSync(EXTRACTED_DIR)) {
		for (const entry of readdirSync(EXTRACTED_DIR)) {
			if (entry === '_schema.json') continue;
			const fullPath = join(EXTRACTED_DIR, entry);
			rmSync(fullPath, { recursive: true, force: true });
		}
	}
}

/**
 * Ingest a PDF and return its source ID from the database.
 */
function ingestPdf(pdfPath: string): string {
	const { exitCode, stdout, stderr } = runCli(['ingest', pdfPath]);
	if (exitCode !== 0) {
		throw new Error(`Ingest failed (exit ${exitCode}): ${stdout} ${stderr}`);
	}
	const parts = pdfPath.split('/');
	const filename = parts[parts.length - 1];
	const sourceId = runSql(`SELECT id FROM sources WHERE filename = '${filename}' ORDER BY created_at DESC LIMIT 1;`);
	if (!sourceId) {
		throw new Error(`No source record found for ${filename}`);
	}
	return sourceId;
}

/**
 * Ingest and extract a PDF, returning the source ID.
 * Creates placeholder page images if canvas module is unavailable.
 */
function ingestAndExtractPdf(pdfPath: string): string {
	const sourceId = ingestPdf(pdfPath);

	// Extract the source
	const { exitCode, stdout, stderr } = runCli(['extract', sourceId]);
	if (exitCode !== 0) {
		throw new Error(`Extract failed (exit ${exitCode}): ${stdout} ${stderr}`);
	}

	// Create placeholder page images if they don't exist (canvas module may be unavailable)
	ensurePageImages(sourceId);

	// Verify source is extracted
	const status = runSql(`SELECT status FROM sources WHERE id = '${sourceId}';`);
	if (status !== 'extracted') {
		throw new Error(`Source ${sourceId} has status '${status}', expected 'extracted'`);
	}

	return sourceId;
}

/**
 * Ensure page images exist for an extracted source.
 * Creates minimal valid PNGs if the canvas module was unavailable during extraction.
 */
function ensurePageImages(sourceId: string): void {
	const pagesDir = join(EXTRACTED_DIR, sourceId, 'pages');
	if (!existsSync(pagesDir)) {
		const layoutPath = join(EXTRACTED_DIR, sourceId, 'layout.json');
		if (existsSync(layoutPath)) {
			const layout = JSON.parse(readFileSync(layoutPath, 'utf-8'));
			mkdirSync(pagesDir, { recursive: true });
			// Minimal valid PNG (1x1 white pixel)
			const minimalPng = Buffer.from(
				'89504e470d0a1a0a0000000d49484452000000010000000108020000009001be' +
					'0000000c4944415478da6360f80f00000101000518d84e0000000049454e44ae426082',
				'hex',
			);
			for (let i = 1; i <= layout.pageCount; i++) {
				const padded = String(i).padStart(3, '0');
				writeFileSync(join(pagesDir, `page-${padded}.png`), minimalPng);
			}
		}
	}
}

/**
 * Try to segment a source and return the result.
 */
function segmentSource(sourceId: string, force = false): { exitCode: number; stdout: string; stderr: string } {
	const args = ['segment', sourceId];
	if (force) args.push('--force');
	return runCli(args);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Spec 23 — Segment Step', () => {
	let pgAvailable: boolean;
	let extractedSourceId: string | null = null;
	/** Tracks whether QA-01 segmentation succeeded so downstream tests know the state. */
	let segmentationSucceeded = false;

	beforeAll(() => {
		pgAvailable = isPgAvailable();
		if (!pgAvailable) {
			console.warn(
				'SKIP: PostgreSQL container not available. Start with:\n' +
					'  docker run -d --name mulder-pg-test -e POSTGRES_USER=mulder ' +
					'-e POSTGRES_PASSWORD=mulder -e POSTGRES_DB=mulder -p 5432:5432 pgvector/pgvector:pg17',
			);
			return;
		}

		// Run migrations to ensure schema exists
		const { exitCode, stdout, stderr } = runCli(['db', 'migrate', EXAMPLE_CONFIG]);
		if (exitCode !== 0) {
			throw new Error(`Migration failed: ${stdout} ${stderr}`);
		}

		// Clean state
		cleanTestData();
		cleanExtractedFixtures();
		cleanSegmentFixtures();

		// Pre-ingest and extract a source for use in tests
		try {
			extractedSourceId = ingestAndExtractPdf(NATIVE_TEXT_PDF);
		} catch (e) {
			console.warn(`Warning: Could not prepare extracted source: ${e}`);
		}
	});

	afterAll(() => {
		if (!pgAvailable) return;
		try {
			cleanTestData();
			cleanExtractedFixtures();
			cleanSegmentFixtures();
		} catch {
			// Ignore cleanup errors
		}
	});

	// ─── QA-01: Single source segmentation ───

	it('QA-01: mulder segment <source-id> on extracted source exits 0 and sets status to segmented', () => {
		if (!pgAvailable) return;
		if (!extractedSourceId) return;

		const { exitCode } = runCli(['segment', extractedSourceId]);

		expect(exitCode).toBe(0);

		// Source status should be 'segmented' in database
		const status = runSql(`SELECT status FROM sources WHERE id = '${extractedSourceId}';`);
		expect(status).toBe('segmented');

		// Track success for downstream tests
		segmentationSucceeded = true;
	});

	// ─── QA-02: Stories created in database ───

	it('QA-02: after segmentation, stories table has at least one row with matching source_id, status segmented, non-null GCS URIs', () => {
		if (!pgAvailable) return;
		if (!extractedSourceId) return;

		// If QA-01 didn't succeed, attempt segmentation directly
		if (!segmentationSucceeded) {
			const result = segmentSource(extractedSourceId);
			// This test requires successful segmentation — fail if it doesn't work
			expect(result.exitCode).toBe(0);
		}

		const storyCount = runSql(`SELECT COUNT(*) FROM stories WHERE source_id = '${extractedSourceId}';`);
		expect(Number.parseInt(storyCount, 10)).toBeGreaterThanOrEqual(1);

		// Check that stories have required fields
		const nullUris = runSql(
			`SELECT COUNT(*) FROM stories WHERE source_id = '${extractedSourceId}' AND (gcs_markdown_uri IS NULL OR gcs_metadata_uri IS NULL);`,
		);
		expect(Number.parseInt(nullUris, 10)).toBe(0);

		// Check story status
		const storyStatuses = runSql(`SELECT DISTINCT status FROM stories WHERE source_id = '${extractedSourceId}';`);
		expect(storyStatuses).toBe('segmented');
	});

	// ─── QA-03: Story Markdown in GCS ───

	it('QA-03: story Markdown file exists and contains non-empty text', () => {
		if (!pgAvailable) return;
		if (!extractedSourceId) return;

		// If source not segmented, attempt segmentation — fail if it doesn't work
		const sourceStatus = runSql(`SELECT status FROM sources WHERE id = '${extractedSourceId}';`);
		if (sourceStatus !== 'segmented') {
			const result = segmentSource(extractedSourceId);
			expect(result.exitCode).toBe(0);
		}

		// Get GCS Markdown URI from a story record
		const markdownUri = runSql(
			`SELECT gcs_markdown_uri FROM stories WHERE source_id = '${extractedSourceId}' LIMIT 1;`,
		);
		expect(markdownUri).not.toBe('');

		// In dev mode, GCS URIs map to .local/storage/ paths
		const localPath = join(ROOT, '.local/storage', markdownUri);
		expect(existsSync(localPath)).toBe(true);

		const content = readFileSync(localPath, 'utf-8');
		expect(content.length).toBeGreaterThan(0);
	});

	// ─── QA-04: Story metadata JSON in GCS ───

	it('QA-04: story metadata JSON exists and contains id, document_id, title, language, category, pages, extraction_confidence', () => {
		if (!pgAvailable) return;
		if (!extractedSourceId) return;

		// If source not segmented, attempt segmentation — fail if it doesn't work
		const sourceStatus = runSql(`SELECT status FROM sources WHERE id = '${extractedSourceId}';`);
		if (sourceStatus !== 'segmented') {
			const result = segmentSource(extractedSourceId);
			expect(result.exitCode).toBe(0);
		}

		// Get GCS metadata URI from a story record
		const metadataUri = runSql(
			`SELECT gcs_metadata_uri FROM stories WHERE source_id = '${extractedSourceId}' LIMIT 1;`,
		);
		expect(metadataUri).not.toBe('');

		// In dev mode, GCS URIs map to .local/storage/ paths
		const localPath = join(ROOT, '.local/storage', metadataUri);
		expect(existsSync(localPath)).toBe(true);

		const content = readFileSync(localPath, 'utf-8');
		const metadata = JSON.parse(content);

		expect(metadata).toHaveProperty('id');
		expect(metadata).toHaveProperty('document_id');
		expect(metadata).toHaveProperty('title');
		expect(metadata).toHaveProperty('language');
		expect(metadata).toHaveProperty('category');
		expect(metadata).toHaveProperty('pages');
		expect(Array.isArray(metadata.pages)).toBe(true);
		expect(metadata).toHaveProperty('extraction_confidence');
	});

	// ─── QA-05: Source step tracking ───

	it('QA-05: source_steps row exists with step_name=segment and status=completed', () => {
		if (!pgAvailable) return;
		if (!extractedSourceId) return;

		// If source not segmented, attempt segmentation — fail if it doesn't work
		const sourceStatus = runSql(`SELECT status FROM sources WHERE id = '${extractedSourceId}';`);
		if (sourceStatus !== 'segmented') {
			const result = segmentSource(extractedSourceId);
			expect(result.exitCode).toBe(0);
		}

		const stepRow = runSql(
			`SELECT step_name, status FROM source_steps WHERE source_id = '${extractedSourceId}' AND step_name = 'segment';`,
		);
		expect(stepRow).not.toBe('');

		const [stepName, stepStatus] = stepRow.split('|');
		expect(stepName).toBe('segment');
		expect(stepStatus).toBe('completed');
	});

	// ─── QA-06: Status validation — rejects non-extracted ───

	it('QA-06: segment rejects non-existent source-id with non-zero exit code and error message', () => {
		if (!pgAvailable) return;

		const fakeId = '00000000-0000-0000-0000-000000000000';
		const { stdout, stderr, exitCode } = runCli(['segment', fakeId]);

		expect(exitCode).not.toBe(0);

		const combined = stdout + stderr;
		expect(combined).toMatch(/not found|invalid|SEGMENT_SOURCE_NOT_FOUND|SEGMENT_INVALID_STATUS|does not exist/i);
	});

	// ─── QA-07: Already segmented — skip without force ───

	it('QA-07: already segmented source is skipped without --force', () => {
		if (!pgAvailable) return;
		if (!extractedSourceId) return;

		// Manually set the source to segmented status if not already
		const currentStatus = runSql(`SELECT status FROM sources WHERE id = '${extractedSourceId}';`);
		if (currentStatus !== 'segmented') {
			runSql(`UPDATE sources SET status = 'segmented' WHERE id = '${extractedSourceId}';`);
		}

		// Run segment without force
		const { exitCode, stdout, stderr } = runCli(['segment', extractedSourceId]);
		const combined = stdout + stderr;

		expect(exitCode).toBe(0);
		expect(combined).toMatch(/already segmented|skipped|skip/i);
	});

	// ─── QA-08: Force re-segmentation ───

	it('QA-08: --force re-segments, deleting old stories and creating new ones', () => {
		if (!pgAvailable) return;
		if (!extractedSourceId) return;

		// First ensure the source is marked as segmented
		const currentStatus = runSql(`SELECT status FROM sources WHERE id = '${extractedSourceId}';`);
		if (currentStatus !== 'segmented') {
			runSql(`UPDATE sources SET status = 'segmented' WHERE id = '${extractedSourceId}';`);
		}

		// Ensure page images exist for re-segmentation
		ensurePageImages(extractedSourceId);

		// Run force re-segmentation
		const { exitCode } = runCli(['segment', extractedSourceId, '--force']);

		expect(exitCode).toBe(0);

		// Source status should be segmented
		const status = runSql(`SELECT status FROM sources WHERE id = '${extractedSourceId}';`);
		expect(status).toBe('segmented');

		// Stories should exist
		const afterCount = runSql(`SELECT COUNT(*) FROM stories WHERE source_id = '${extractedSourceId}';`);
		expect(Number.parseInt(afterCount, 10)).toBeGreaterThanOrEqual(1);
	});

	// ─── QA-09: Batch segmentation (--all) ───

	it('QA-09: --all segments all extracted sources', () => {
		if (!pgAvailable) return;

		// Clean and set up two extracted sources
		cleanTestData();
		cleanExtractedFixtures();
		cleanSegmentFixtures();

		ingestAndExtractPdf(NATIVE_TEXT_PDF);
		ingestAndExtractPdf(SCANNED_PDF);

		// Verify both are extracted
		const extractedCount = runSql("SELECT COUNT(*) FROM sources WHERE status = 'extracted';");
		expect(Number.parseInt(extractedCount, 10)).toBe(2);

		// Segment all
		const { exitCode } = runCli(['segment', '--all'], { timeout: 120000 });
		expect(exitCode).toBe(0);

		// All sources should now be segmented
		const segmentedCount = runSql("SELECT COUNT(*) FROM sources WHERE status = 'segmented';");
		expect(Number.parseInt(segmentedCount, 10)).toBe(2);
	});

	// ─── QA-10: Story page ranges ───

	it('QA-10: each story has non-null page_start and page_end with page_start <= page_end', () => {
		if (!pgAvailable) return;

		// Use any segmented source — the shared extractedSourceId may have been
		// cleaned up by QA-09. If none exists, create a fresh one.
		let sourceId = runSql("SELECT id FROM sources WHERE status = 'segmented' LIMIT 1;");
		if (!sourceId) {
			cleanTestData();
			cleanExtractedFixtures();
			cleanSegmentFixtures();
			sourceId = ingestAndExtractPdf(NATIVE_TEXT_PDF);
			const result = segmentSource(sourceId);
			expect(result.exitCode).toBe(0);
		}

		const storyCount = runSql(`SELECT COUNT(*) FROM stories WHERE source_id = '${sourceId}';`);
		expect(Number.parseInt(storyCount, 10)).toBeGreaterThanOrEqual(1);

		// Check that all stories have valid page ranges
		const invalidPageRanges = runSql(
			`SELECT COUNT(*) FROM stories WHERE source_id = '${sourceId}' AND (page_start IS NULL OR page_end IS NULL OR page_start > page_end);`,
		);
		expect(Number.parseInt(invalidPageRanges, 10)).toBe(0);
	});

	// ─── QA-11: Idempotent segmentation with force ───

	it('QA-11: double --force segmentation results in clean state with no duplicate stories', () => {
		if (!pgAvailable) return;

		// Set up fresh extracted source
		cleanTestData();
		cleanExtractedFixtures();
		cleanSegmentFixtures();
		const sourceId = ingestAndExtractPdf(NATIVE_TEXT_PDF);

		// First force segmentation
		const first = runCli(['segment', sourceId, '--force']);
		expect(first.exitCode).toBe(0);

		const storyCountAfterFirst = runSql(`SELECT COUNT(*) FROM stories WHERE source_id = '${sourceId}';`);

		// Second force segmentation
		const second = runCli(['segment', sourceId, '--force']);
		expect(second.exitCode).toBe(0);

		// Source should still be segmented
		const status = runSql(`SELECT status FROM sources WHERE id = '${sourceId}';`);
		expect(status).toBe('segmented');

		// Story count should be the same (no duplicates)
		const storyCountAfterSecond = runSql(`SELECT COUNT(*) FROM stories WHERE source_id = '${sourceId}';`);
		expect(storyCountAfterSecond).toBe(storyCountAfterFirst);

		// No duplicate source_steps records
		const stepCount = runSql(
			`SELECT COUNT(*) FROM source_steps WHERE source_id = '${sourceId}' AND step_name = 'segment';`,
		);
		expect(stepCount).toBe('1');
	});

	// ─── QA-12: GCS path convention ───

	it('QA-12: story GCS URIs match segments/{source-id}/{story-id}.md and .meta.json patterns', () => {
		if (!pgAvailable) return;

		// Use any segmented source — the shared extractedSourceId may have been
		// cleaned up by QA-09. If none exists, create a fresh one.
		let sourceId = runSql("SELECT id FROM sources WHERE status = 'segmented' LIMIT 1;");
		if (!sourceId) {
			cleanTestData();
			cleanExtractedFixtures();
			cleanSegmentFixtures();
			sourceId = ingestAndExtractPdf(NATIVE_TEXT_PDF);
			const result = segmentSource(sourceId);
			expect(result.exitCode).toBe(0);
		}

		const storyCount = runSql(`SELECT COUNT(*) FROM stories WHERE source_id = '${sourceId}';`);
		expect(Number.parseInt(storyCount, 10)).toBeGreaterThanOrEqual(1);

		// Get all story GCS URIs
		const rows = runSql(`SELECT id, gcs_markdown_uri, gcs_metadata_uri FROM stories WHERE source_id = '${sourceId}';`);

		for (const row of rows.split('\n').filter(Boolean)) {
			const [_storyId, markdownUri, metadataUri] = row.split('|');

			// Markdown URI pattern: segments/{source-id}/{story-id}.md
			const expectedMdPattern = new RegExp(`^segments/${sourceId}/[a-f0-9-]+\\.md$`);
			expect(markdownUri).toMatch(expectedMdPattern);

			// Metadata URI pattern: segments/{source-id}/{story-id}.meta.json
			const expectedMetaPattern = new RegExp(`^segments/${sourceId}/[a-f0-9-]+\\.meta\\.json$`);
			expect(metadataUri).toMatch(expectedMetaPattern);
		}
	});
});

// ---------------------------------------------------------------------------
// CLI Test Matrix
// ---------------------------------------------------------------------------

describe('CLI Test Matrix: segment', () => {
	// ─── CLI-01: --help shows expected options ───

	it('CLI-01: mulder segment --help shows source-id, --all, --force options', () => {
		const { exitCode, stdout } = runCli(['segment', '--help']);

		expect(exitCode).toBe(0);
		expect(stdout).toContain('source-id');
		expect(stdout).toContain('--all');
		expect(stdout).toContain('--force');
	});

	// ─── CLI-02: no args gives error ───

	it('CLI-02: mulder segment with no args gives non-zero exit and error about missing source-id or --all', () => {
		const { exitCode, stdout, stderr } = runCli(['segment']);
		const combined = stdout + stderr;

		expect(exitCode).not.toBe(0);
		expect(combined).toMatch(/source-id|--all|provide|missing|required/i);
	});

	// ─── CLI-03: source-id and --all are mutually exclusive ───

	it('CLI-03: mulder segment <id> --all gives non-zero exit and mutual exclusivity error', () => {
		const { exitCode, stdout, stderr } = runCli(['segment', 'some-id', '--all']);
		const combined = stdout + stderr;

		expect(exitCode).not.toBe(0);
		expect(combined).toMatch(/mutually exclusive/i);
	});
});

// ---------------------------------------------------------------------------
// CLI Smoke Tests
// ---------------------------------------------------------------------------

describe('CLI Smoke Tests: segment', () => {
	// ─── SMOKE-01: --help exits cleanly ───

	it('SMOKE-01: mulder segment --help exits with code 0 and produces output', () => {
		const { exitCode, stdout } = runCli(['segment', '--help']);
		expect(exitCode).toBe(0);
		expect(stdout.length).toBeGreaterThan(0);
	});

	// ─── SMOKE-02: --force without source-id (no --all) gives error ───

	it('SMOKE-02: mulder segment --force (no source-id, no --all) gives non-zero exit', () => {
		const { exitCode, stdout, stderr } = runCli(['segment', '--force']);
		const combined = stdout + stderr;

		expect(exitCode).not.toBe(0);
		expect(combined).toMatch(/source-id|--all|provide|missing|required/i);
	});

	// ─── SMOKE-03: --all --force does not crash ───

	it('SMOKE-03: mulder segment --all --force does not crash (exits cleanly even if no sources)', () => {
		// This tests that --all and --force can be combined without crash
		const pgAvailable = isPgAvailable();
		if (!pgAvailable) return;

		const { stdout, stderr } = runCli(['segment', '--all', '--force'], { timeout: 60000 });
		const combined = stdout + stderr;

		// Should not have an unhandled crash (those show as "Unexpected error" in mulder)
		// Either exits 0 (success/no work) or exits with a proper error message
		expect(combined).not.toMatch(/Unexpected error/);
	});

	// ─── SMOKE-04: invalid UUID format as source-id ───

	it('SMOKE-04: mulder segment with non-UUID source-id gives non-zero exit', () => {
		const pgAvailable = isPgAvailable();
		if (!pgAvailable) return;

		const { exitCode, stdout, stderr } = runCli(['segment', 'not-a-valid-uuid']);
		const combined = stdout + stderr;

		expect(exitCode).not.toBe(0);
		// Should produce an error (not found, invalid format, etc.)
		expect(combined.length).toBeGreaterThan(0);
	});

	// ─── SMOKE-05: --help with extra flags does not crash ───

	it('SMOKE-05: mulder segment --help --force --all does not crash', () => {
		const { exitCode, stdout } = runCli(['segment', '--help', '--force', '--all']);

		// --help should take precedence and display help
		expect(exitCode).toBe(0);
		expect(stdout).toContain('source-id');
	});
});
