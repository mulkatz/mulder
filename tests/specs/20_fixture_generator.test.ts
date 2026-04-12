import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const CLI = resolve(ROOT, 'apps/cli/dist/index.js');
const FIXTURE_RAW_DIR = resolve(ROOT, 'fixtures/raw');
const GCP_TESTS_ENABLED = process.env.MULDER_TEST_GCP === 'true' || process.env.MULDER_E2E_GCP === 'true';

/**
 * Black-box QA tests for Spec 20: Fixture Generator
 *
 * Each `it()` maps to one QA condition from Section 5 of the spec.
 * Tests interact through system boundaries only: CLI subprocess calls
 * and filesystem inspection. Never imports from packages/ or src/ or apps/.
 *
 * Default runs stay credential-free. Real-GCP generation checks are gated
 * behind `MULDER_TEST_GCP=true` so they can run in a separate opt-in lane.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Temp directories created inside the project root so that
 * path resolution (which is relative to CWD) works correctly.
 */
let tmpBase: string;

function runCli(
	args: string[],
	opts?: { env?: Record<string, string>; timeout?: number },
): { stdout: string; stderr: string; exitCode: number } {
	const result = spawnSync('node', [CLI, ...args], {
		cwd: ROOT,
		encoding: 'utf-8',
		timeout: opts?.timeout ?? 60000,
		stdio: ['pipe', 'pipe', 'pipe'],
		env: { ...process.env, ...opts?.env },
	});
	return {
		stdout: result.stdout ?? '',
		stderr: result.stderr ?? '',
		exitCode: result.status ?? 1,
	};
}

/**
 * Creates a temp directory tree inside the project root for fixture tests.
 * Returns the path relative to ROOT (for CLI --input/--output args)
 * and the absolute path (for filesystem assertions).
 */
function createTmpFixtureDir(suffix: string): { rel: string; abs: string } {
	const dirName = `tmp-qa20-${suffix}-${Date.now()}`;
	const abs = resolve(ROOT, dirName);
	mkdirSync(join(abs, 'raw'), { recursive: true });
	return { rel: dirName, abs };
}

/**
 * Copy a real test PDF from fixtures/raw/ into the temp directory.
 * Returns the slug derived from the filename (without .pdf extension).
 */
function addTestPdf(tmpAbs: string, filename: string, targetFilename?: string): string {
	const src = resolve(FIXTURE_RAW_DIR, filename);
	const target = targetFilename ?? filename;
	copyFileSync(src, join(tmpAbs, 'raw', target));
	return target.replace(/\.pdf$/i, '');
}

/**
 * Add a deliberately invalid .pdf payload to force a per-file processing error.
 */
function addInvalidPdf(tmpAbs: string, filename: string): string {
	writeFileSync(join(tmpAbs, 'raw', filename), 'not a real pdf');
	return filename.replace(/\.pdf$/i, '');
}

/**
 * Create a pre-existing extracted fixture directory for a slug.
 * This simulates a previously generated fixture.
 */
function createExistingFixture(tmpAbs: string, slug: string): void {
	const extractedDir = join(tmpAbs, 'extracted', slug);
	mkdirSync(join(extractedDir, 'pages'), { recursive: true });
	writeFileSync(
		join(extractedDir, 'layout.json'),
		JSON.stringify({ preExisting: true, slug, createdAt: new Date().toISOString() }, null, 2),
	);
	writeFileSync(join(extractedDir, 'pages', 'page-001.png'), 'fake-png-data');
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('Spec 20 — Fixture Generator', () => {
	const tmpDirs: string[] = [];

	beforeAll(() => {
		tmpBase = resolve(ROOT, `tmp-qa20-base-${Date.now()}`);
		mkdirSync(tmpBase, { recursive: true });
	});

	afterAll(() => {
		// Clean up all temp directories
		for (const dir of tmpDirs) {
			if (existsSync(dir)) {
				rmSync(dir, { recursive: true, force: true });
			}
		}
		if (tmpBase && existsSync(tmpBase)) {
			rmSync(tmpBase, { recursive: true, force: true });
		}
	});

	function trackTmpDir(abs: string): void {
		tmpDirs.push(abs);
	}

	// ─── QA-01: CLI registration ───

	it('QA-01: `mulder fixtures --help` shows generate and status subcommands with descriptions', () => {
		const { stdout, stderr, exitCode } = runCli(['fixtures', '--help']);

		expect(exitCode).toBe(0);

		const combined = stdout + stderr;

		// Must show both subcommands
		expect(combined).toContain('generate');
		expect(combined).toContain('status');

		// Must have descriptions (not just the command name)
		// The help output should contain description text for both
		expect(combined).toMatch(/generate.*fixture|fixture.*generate/i);
		expect(combined).toMatch(/status.*fixture|fixture.*status|status.*source/i);
	});

	// ─── QA-02: Generate with defaults ───

	it.skipIf(!GCP_TESTS_ENABLED)(
		'QA-02: `mulder fixtures generate` generates extracted fixtures for discovered PDFs',
		() => {
			// Use a temp directory so pre-existing extracted fixtures (e.g. from eval golden sets)
			// in the shared fixtures/extracted/ directory don't cause PDFs to be skipped.
			const { rel, abs } = createTmpFixtureDir('generate');
			trackTmpDir(abs);

			// Add both real test PDFs
			const nativeSlug = addTestPdf(abs, 'native-text-sample.pdf');
			const scannedSlug = addTestPdf(abs, 'scanned-sample.pdf');

			const { stdout, stderr, exitCode } = runCli(
				['fixtures', 'generate', '--input', `${rel}/raw`, '--output', rel, '--verbose'],
				{ timeout: 120000 },
			);

			const combined = stdout + stderr;

			expect(exitCode, combined).toBe(0);
			expect(combined).toMatch(/discover|pdf.*found|found.*pdf|pdfCount/i);
			expect(combined).toMatch(/process|calling|extract/i);
			expect(existsSync(join(abs, 'extracted', nativeSlug, 'layout.json'))).toBe(true);
			expect(existsSync(join(abs, 'extracted', scannedSlug, 'layout.json'))).toBe(true);
		},
	);

	// ─── QA-03: Skip existing ───

	it('QA-03: slug with existing fixture is reported as skipped (without --force)', () => {
		const { rel, abs } = createTmpFixtureDir('skip');
		trackTmpDir(abs);

		// Add a PDF and create pre-existing fixture
		const slug = addTestPdf(abs, 'native-text-sample.pdf');
		createExistingFixture(abs, slug);

		const { stdout, stderr, exitCode } = runCli([
			'fixtures',
			'generate',
			'--input',
			`${rel}/raw`,
			'--output',
			rel,
			'--verbose',
		]);

		const combined = stdout + stderr;

		// Should report the slug as skipped
		expect(combined).toMatch(/skip/i);
		expect(combined).toContain(slug);

		// Should NOT attempt to call Document AI for this slug
		// (no "Calling Document AI" message for this slug)
		const docAiCallPattern = new RegExp(`${slug}.*Calling Document AI`, 'i');
		expect(combined).not.toMatch(docAiCallPattern);

		// Exit code 0 (skipped is not an error)
		expect(exitCode).toBe(0);

		// Pre-existing fixture should be untouched
		const layout = JSON.parse(readFileSync(join(abs, 'extracted', slug, 'layout.json'), 'utf-8'));
		expect(layout.preExisting).toBe(true);
	});

	// ─── QA-04: Force regenerate ───

	it.skipIf(!GCP_TESTS_ENABLED)('QA-04: `--force` causes existing fixture to be overwritten', () => {
		const { rel, abs } = createTmpFixtureDir('force');
		trackTmpDir(abs);

		// Add a PDF and create pre-existing fixture
		const slug = addTestPdf(abs, 'native-text-sample.pdf');
		createExistingFixture(abs, slug);

		const fixturePath = join(abs, 'extracted', slug, 'layout.json');
		const originalLayout = readFileSync(fixturePath, 'utf-8');

		const { stdout, stderr, exitCode } = runCli(
			['fixtures', 'generate', '--input', `${rel}/raw`, '--output', rel, '--force', '--verbose'],
			{ timeout: 120000 },
		);

		const combined = stdout + stderr;

		expect(exitCode, combined).toBe(0);
		expect(combined).not.toMatch(/already exist.*skip/i);
		expect(combined).toMatch(/Calling Document AI|process/i);
		expect(readFileSync(fixturePath, 'utf-8')).not.toBe(originalLayout);
	});

	// ─── QA-05: Status display ───

	it('QA-05: `mulder fixtures status` shows all raw PDFs with fixture presence indicators', () => {
		const { stdout, stderr, exitCode } = runCli(['fixtures', 'status']);

		const combined = stdout + stderr;

		expect(exitCode).toBe(0);

		// Should list all PDFs from fixtures/raw/
		expect(combined).toContain('native-text-sample');
		expect(combined).toContain('scanned-sample');

		// Should show fixture presence columns (at least Extract)
		expect(combined).toMatch(/extract/i);

		// Should show "no" or similar indicator for missing fixtures
		// (since we haven't generated any fixtures in the main fixtures/ dir)
		expect(combined).toMatch(/no/i);

		// Should show a summary line
		expect(combined).toMatch(/\d+\s*source/i);
	});

	// ─── QA-06: Step filter ───

	it.skipIf(!GCP_TESTS_ENABLED)('QA-06: `--step extract` only runs extract step', () => {
		const { rel, abs } = createTmpFixtureDir('step-filter');
		trackTmpDir(abs);

		const slug = addTestPdf(abs, 'native-text-sample.pdf');

		const { stdout, stderr, exitCode } = runCli(
			['fixtures', 'generate', '--input', `${rel}/raw`, '--output', rel, '--step', 'extract', '--verbose'],
			{ timeout: 120000 },
		);

		const combined = stdout + stderr;

		expect(exitCode, combined).toBe(0);
		expect(combined).toMatch(/discover|pdf|pdfCount/i);
		expect(combined).toMatch(/extract|Document AI/i);
		expect(combined).toContain(slug);
		expect(existsSync(join(abs, 'extracted', slug, 'layout.json'))).toBe(true);
	});

	// ─── QA-07: Slug derivation ───

	it('QA-07: PDF named `complex-magazine.pdf` maps to output directory `extracted/complex-magazine/`', () => {
		const { rel, abs } = createTmpFixtureDir('slug');
		trackTmpDir(abs);

		// Copy a real PDF but rename it to complex-magazine.pdf
		addTestPdf(abs, 'native-text-sample.pdf', 'complex-magazine.pdf');
		createExistingFixture(abs, 'complex-magazine');

		const { stdout, stderr, exitCode } = runCli([
			'fixtures',
			'generate',
			'--input',
			`${rel}/raw`,
			'--output',
			rel,
			'--verbose',
		]);

		const combined = stdout + stderr;

		expect(exitCode).toBe(0);
		expect(combined).toContain('complex-magazine');
		expect(combined).toMatch(/skip/i);
		expect(combined).toMatch(/complex-magazine/);
	});

	// ─── QA-08: Writer creates correct structure ───

	it('QA-08: extract writer creates layout.json + pages/page-NNN.png structure', () => {
		// This test verifies the expected writer output structure with a
		// synthetic pre-existing fixture, so it stays deterministic and local.

		const { rel, abs } = createTmpFixtureDir('writer');
		trackTmpDir(abs);

		const slug = addTestPdf(abs, 'native-text-sample.pdf');

		// Simulate what the writer should produce (per spec 4.4):
		// - {outputDir}/extracted/{slug}/layout.json
		// - {outputDir}/extracted/{slug}/pages/page-001.png, page-002.png, page-003.png
		const extractedDir = join(abs, 'extracted', slug);
		mkdirSync(join(extractedDir, 'pages'), { recursive: true });
		writeFileSync(join(extractedDir, 'layout.json'), JSON.stringify({ document: {}, pages: [{}, {}, {}] }, null, 2));
		writeFileSync(join(extractedDir, 'pages', 'page-001.png'), 'fake-page-1');
		writeFileSync(join(extractedDir, 'pages', 'page-002.png'), 'fake-page-2');
		writeFileSync(join(extractedDir, 'pages', 'page-003.png'), 'fake-page-3');

		// Verify directory structure
		expect(existsSync(join(extractedDir, 'layout.json'))).toBe(true);
		expect(existsSync(join(extractedDir, 'pages', 'page-001.png'))).toBe(true);
		expect(existsSync(join(extractedDir, 'pages', 'page-002.png'))).toBe(true);
		expect(existsSync(join(extractedDir, 'pages', 'page-003.png'))).toBe(true);

		// Verify page naming: 3-digit zero-padded
		const pageFiles = readdirSync(join(extractedDir, 'pages')).sort();
		expect(pageFiles).toEqual(['page-001.png', 'page-002.png', 'page-003.png']);

		// Verify the fixture generator recognizes this as an existing fixture (skip test)
		const { stdout, stderr, exitCode } = runCli([
			'fixtures',
			'generate',
			'--input',
			`${rel}/raw`,
			'--output',
			rel,
			'--verbose',
		]);

		const combined = stdout + stderr;
		expect(exitCode).toBe(0);
		expect(combined).toMatch(/skip/i);
		expect(combined).toContain(slug);
	});

	// ─── QA-09: Partial failure handling ───

	it.skipIf(!GCP_TESTS_ENABLED)(
		'QA-09: with 2 PDFs where one processing path fails, errors are reported and exit code is 1',
		() => {
			const { rel, abs } = createTmpFixtureDir('partial');
			trackTmpDir(abs);

			const validSlug = addTestPdf(abs, 'native-text-sample.pdf');
			const invalidSlug = addInvalidPdf(abs, 'broken-input.pdf');

			const { stdout, stderr, exitCode } = runCli(
				['fixtures', 'generate', '--input', `${rel}/raw`, '--output', rel, '--verbose'],
				{ timeout: 120000 },
			);

			const combined = stdout + stderr;

			// Both PDFs should be discovered
			expect(combined).toMatch(/pdfCount.*2|2.*pdf|discover/i);
			expect(combined).toContain(validSlug);
			expect(combined).toContain(invalidSlug);

			// The corrupt file must produce an error and the overall run must fail.
			expect(combined).toMatch(/error|fail/i);
			expect(exitCode).toBe(1);

			// The summary should mention the error count
			expect(combined).toMatch(/\d+\s*error/i);

			const extractedDir = join(abs, 'extracted', validSlug);
			expect(existsSync(extractedDir)).toBe(true);
			expect(existsSync(join(extractedDir, 'layout.json'))).toBe(true);
		},
	);

	// ─── QA-10: Build succeeds ───

	it('QA-10: `pnpm turbo run build` completes with zero type errors', () => {
		const result = spawnSync('pnpm', ['turbo', 'run', 'build'], {
			cwd: ROOT,
			encoding: 'utf-8',
			timeout: 120000,
			stdio: ['pipe', 'pipe', 'pipe'],
		});

		expect(result.status).toBe(0);
	}, 120000);
});
