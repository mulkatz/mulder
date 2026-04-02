import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const GOLDEN_DIR = resolve(ROOT, 'eval/golden/extraction');
const EXTRACTED_DIR = resolve(ROOT, 'fixtures/extracted');
const BASELINE_PATH = resolve(ROOT, 'eval/metrics/baseline.json');
const EVAL_DIST = resolve(ROOT, 'packages/eval/dist/index.js');

/**
 * Black-box QA tests for Spec 21: Golden Test Set — Extraction
 *
 * Each `it()` maps to one QA condition from Section 5 of the spec.
 * Tests interact through system boundaries only: filesystem inspection
 * and subprocess calls against the built eval package dist.
 * Never imports from packages/, src/, or apps/.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Execute a JS expression in a subprocess that imports the eval package dist.
 * Returns the JSON-parsed stdout. This is the black-box boundary for
 * testing the eval package's public API without importing it.
 */
function evalExpr(expression: string): unknown {
	const script = `
		import * as evalPkg from ${JSON.stringify(`file://${EVAL_DIST}`)};
		const result = ${expression};
		process.stdout.write(JSON.stringify(result));
	`;
	const result = execFileSync('node', ['--input-type=module', '-e', script], {
		cwd: ROOT,
		encoding: 'utf-8',
		timeout: 30000,
		env: { ...process.env, NODE_ENV: 'test' },
	});
	return JSON.parse(result);
}

/**
 * Execute an async JS expression in a subprocess that imports the eval package dist.
 * Returns the JSON-parsed stdout.
 */
function evalExprAsync(expression: string): unknown {
	const script = `
		import * as evalPkg from ${JSON.stringify(`file://${EVAL_DIST}`)};
		const result = await (async () => { return ${expression}; })();
		process.stdout.write(JSON.stringify(result));
	`;
	const result = execFileSync('node', ['--input-type=module', '-e', script], {
		cwd: ROOT,
		encoding: 'utf-8',
		timeout: 30000,
		env: { ...process.env, NODE_ENV: 'test' },
	});
	return JSON.parse(result);
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('Spec 21 — Golden Test Set: Extraction', () => {
	// ─── QA-01: Golden directory exists with >= 5 JSON files ───

	it('QA-01: eval/golden/extraction/ exists with >= 5 JSON files', () => {
		expect(existsSync(GOLDEN_DIR)).toBe(true);

		const files = readdirSync(GOLDEN_DIR).filter((f) => f.endsWith('.json'));
		expect(files.length).toBeGreaterThanOrEqual(5);
	});

	// ─── QA-02: Golden files contain all required fields ───

	it('QA-02: every golden JSON file has required fields: sourceSlug, pageNumber, difficulty, languages, expectedText, annotation', () => {
		const files = readdirSync(GOLDEN_DIR).filter((f) => f.endsWith('.json'));
		expect(files.length).toBeGreaterThan(0);

		for (const file of files) {
			const content = JSON.parse(readFileSync(join(GOLDEN_DIR, file), 'utf-8'));

			// Required top-level fields
			expect(content).toHaveProperty('sourceSlug');
			expect(typeof content.sourceSlug).toBe('string');
			expect(content.sourceSlug.length).toBeGreaterThan(0);

			expect(content).toHaveProperty('pageNumber');
			expect(typeof content.pageNumber).toBe('number');
			expect(content.pageNumber).toBeGreaterThanOrEqual(1);

			expect(content).toHaveProperty('difficulty');
			expect(['simple', 'moderate', 'complex']).toContain(content.difficulty);

			expect(content).toHaveProperty('languages');
			expect(Array.isArray(content.languages)).toBe(true);
			expect(content.languages.length).toBeGreaterThan(0);

			expect(content).toHaveProperty('expectedText');
			expect(typeof content.expectedText).toBe('string');
			expect(content.expectedText.length).toBeGreaterThan(0);

			expect(content).toHaveProperty('annotation');
			expect(typeof content.annotation).toBe('object');
			expect(content.annotation).toHaveProperty('author');
			expect(content.annotation).toHaveProperty('date');
		}
	});

	// ─── QA-03: Fixture layout files exist for every golden page ───

	it('QA-03: every golden page has a matching layout.json in fixtures/extracted/{slug}/', () => {
		const files = readdirSync(GOLDEN_DIR).filter((f) => f.endsWith('.json'));

		for (const file of files) {
			const content = JSON.parse(readFileSync(join(GOLDEN_DIR, file), 'utf-8'));
			const slug = content.sourceSlug;

			const layoutPath = join(EXTRACTED_DIR, slug, 'layout.json');
			expect(
				existsSync(layoutPath),
				`Missing layout.json for golden page slug="${slug}" (expected at ${layoutPath})`,
			).toBe(true);

			// Verify the layout.json is valid JSON
			const layout = JSON.parse(readFileSync(layoutPath, 'utf-8'));
			expect(layout).toBeDefined();
		}
	});

	// ─── QA-04: CER computation is correct ───

	it('QA-04: computeCER("hello world", "helo wrld") returns expected edit distance ratio', () => {
		const cer = evalExpr('evalPkg.computeCER("hello world", "helo wrld")') as number;

		// "hello world" (11 chars) vs "helo wrld" (9 chars)
		// Levenshtein distance = 2 (delete 'l' from 'hello', delete 'o' from 'world')
		// CER = 2 / 11 = 0.1818...
		expect(typeof cer).toBe('number');
		expect(cer).toBeGreaterThan(0);
		expect(cer).toBeLessThan(1);

		// The exact value depends on normalization, but it should be approximately 0.18
		// We verify it's in a reasonable range for 2 edits on ~11 chars
		expect(cer).toBeGreaterThanOrEqual(0.1);
		expect(cer).toBeLessThanOrEqual(0.3);
	});

	// ─── QA-05: WER computation is correct ───

	it('QA-05: computeWER("the quick brown fox", "the quik brown") returns expected word error rate', () => {
		const wer = evalExpr(
			'evalPkg.computeWER("the quick brown fox", "the quik brown")',
		) as number;

		// "the quick brown fox" = 4 words
		// "the quik brown" = 3 words
		// Word-level Levenshtein: "the" matches, "quick" -> "quik" (substitution), "brown" matches, "fox" deleted
		// Distance = 2 (1 substitution + 1 deletion), WER = 2/4 = 0.5
		expect(typeof wer).toBe('number');
		expect(wer).toBeGreaterThan(0);
		expect(wer).toBeLessThanOrEqual(1);

		// Should be approximately 0.5 (2 errors out of 4 words)
		expect(wer).toBeGreaterThanOrEqual(0.3);
		expect(wer).toBeLessThanOrEqual(0.7);
	});

	// ─── QA-06: Perfect match returns zero ───

	it('QA-06: computeCER and computeWER return 0.0 for identical strings', () => {
		const testText = 'The quick brown fox jumps over the lazy dog';

		const cer = evalExpr(
			`evalPkg.computeCER(${JSON.stringify(testText)}, ${JSON.stringify(testText)})`,
		) as number;
		const wer = evalExpr(
			`evalPkg.computeWER(${JSON.stringify(testText)}, ${JSON.stringify(testText)})`,
		) as number;

		expect(cer).toBe(0);
		expect(wer).toBe(0);
	});

	// ─── QA-07: Eval runner produces results ───

	it('QA-07: runExtractionEval() returns ExtractionEvalResult with one entry per golden page and correct summary', () => {
		const result = evalExprAsync(
			`evalPkg.runExtractionEval(${JSON.stringify(GOLDEN_DIR)}, ${JSON.stringify(EXTRACTED_DIR)})`,
		) as {
			timestamp: string;
			pages: Array<{
				sourceSlug: string;
				pageNumber: number;
				difficulty: string;
				cer: number;
				wer: number;
				charCount: number;
				wordCount: number;
			}>;
			summary: {
				totalPages: number;
				avgCer: number;
				avgWer: number;
				maxCer: number;
				maxWer: number;
				byDifficulty: Record<string, { avgCer: number; avgWer: number; count: number }>;
			};
		};

		// Must have a timestamp
		expect(result.timestamp).toBeDefined();
		expect(typeof result.timestamp).toBe('string');

		// Must have pages array with one entry per golden page
		const goldenFiles = readdirSync(GOLDEN_DIR).filter((f) => f.endsWith('.json'));
		expect(result.pages.length).toBe(goldenFiles.length);

		// Each page result must have required fields
		for (const page of result.pages) {
			expect(typeof page.sourceSlug).toBe('string');
			expect(typeof page.pageNumber).toBe('number');
			expect(typeof page.difficulty).toBe('string');
			expect(typeof page.cer).toBe('number');
			expect(typeof page.wer).toBe('number');
			expect(typeof page.charCount).toBe('number');
			expect(typeof page.wordCount).toBe('number');
			// CER and WER should be between 0 and 1
			expect(page.cer).toBeGreaterThanOrEqual(0);
			expect(page.cer).toBeLessThanOrEqual(1);
			expect(page.wer).toBeGreaterThanOrEqual(0);
			expect(page.wer).toBeLessThanOrEqual(1);
		}

		// Summary must have correct structure
		expect(result.summary.totalPages).toBe(goldenFiles.length);
		expect(result.summary.totalPages).toBeGreaterThanOrEqual(5);
		expect(typeof result.summary.avgCer).toBe('number');
		expect(typeof result.summary.avgWer).toBe('number');
		expect(typeof result.summary.maxCer).toBe('number');
		expect(typeof result.summary.maxWer).toBe('number');
		expect(typeof result.summary.byDifficulty).toBe('object');

		// Max should be >= avg
		expect(result.summary.maxCer).toBeGreaterThanOrEqual(result.summary.avgCer);
		expect(result.summary.maxWer).toBeGreaterThanOrEqual(result.summary.avgWer);
	});

	// ─── QA-08: Baseline file exists and is valid ───

	it('QA-08: eval/metrics/baseline.json is valid JSON matching ExtractionEvalResult with totalPages >= 5', () => {
		expect(existsSync(BASELINE_PATH)).toBe(true);

		const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf-8'));

		// Must match ExtractionEvalResult schema
		expect(baseline).toHaveProperty('timestamp');
		expect(typeof baseline.timestamp).toBe('string');

		expect(baseline).toHaveProperty('pages');
		expect(Array.isArray(baseline.pages)).toBe(true);

		expect(baseline).toHaveProperty('summary');
		expect(typeof baseline.summary).toBe('object');

		// summary.totalPages >= 5
		expect(baseline.summary.totalPages).toBeGreaterThanOrEqual(5);

		// Verify summary structure
		expect(typeof baseline.summary.avgCer).toBe('number');
		expect(typeof baseline.summary.avgWer).toBe('number');
		expect(typeof baseline.summary.maxCer).toBe('number');
		expect(typeof baseline.summary.maxWer).toBe('number');
		expect(typeof baseline.summary.byDifficulty).toBe('object');

		// Each page in the baseline should have proper fields
		for (const page of baseline.pages) {
			expect(typeof page.sourceSlug).toBe('string');
			expect(typeof page.pageNumber).toBe('number');
			expect(typeof page.difficulty).toBe('string');
			expect(typeof page.cer).toBe('number');
			expect(typeof page.wer).toBe('number');
		}
	});

	// ─── QA-09: Eval package builds ───

	it('QA-09: pnpm turbo run build --filter=@mulder/eval succeeds with no errors', () => {
		const result = spawnSync('pnpm', ['turbo', 'run', 'build', '--filter=@mulder/eval'], {
			cwd: ROOT,
			encoding: 'utf-8',
			timeout: 120000,
			stdio: ['pipe', 'pipe', 'pipe'],
		});

		expect(result.status).toBe(0);
	}, 120000);

	// ─── QA-10: Difficulty coverage ───

	it('QA-10: golden set has at least 1 simple, 1 moderate, and 1 complex page', () => {
		const files = readdirSync(GOLDEN_DIR).filter((f) => f.endsWith('.json'));
		const difficulties = new Set<string>();

		for (const file of files) {
			const content = JSON.parse(readFileSync(join(GOLDEN_DIR, file), 'utf-8'));
			difficulties.add(content.difficulty);
		}

		expect(difficulties.has('simple')).toBe(true);
		expect(difficulties.has('moderate')).toBe(true);
		expect(difficulties.has('complex')).toBe(true);
	});
});
