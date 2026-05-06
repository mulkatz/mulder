import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const EVAL_DIST = resolve(ROOT, 'packages/eval/dist/index.js');
const CLI = resolve(ROOT, 'apps/cli/dist/index.js');
const QUALITY_GOLDEN_DIR = resolve(ROOT, 'eval/golden/quality-routing');
const ASSERTION_GOLDEN_DIR = resolve(ROOT, 'eval/golden/assertions');
const QUALITY_FIXTURE_DIR = resolve(ROOT, 'fixtures/quality-routing');
const ASSERTION_FIXTURE_DIR = resolve(ROOT, 'fixtures/assertions');
const BASELINE_PATH = resolve(ROOT, 'eval/metrics/baseline.json');

const infraReady =
	existsSync(EVAL_DIST) &&
	existsSync(CLI) &&
	existsSync(BASELINE_PATH) &&
	existsSync(QUALITY_GOLDEN_DIR) &&
	existsSync(ASSERTION_GOLDEN_DIR) &&
	existsSync(QUALITY_FIXTURE_DIR) &&
	existsSync(ASSERTION_FIXTURE_DIR);

function buildEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		NODE_ENV: 'test',
		MULDER_LOG_LEVEL: 'silent',
		...extra,
	};

	for (const key of [
		'DATABASE_URL',
		'GOOGLE_APPLICATION_CREDENTIALS',
		'GOOGLE_CLOUD_PROJECT',
		'GCLOUD_PROJECT',
		'GCP_PROJECT',
		'CLOUDSDK_CORE_PROJECT',
		'VERTEX_AI_PROJECT',
		'VERTEX_AI_LOCATION',
	]) {
		delete env[key];
	}

	return env;
}

function evalExpr(expression: string): unknown {
	const script = `
		import * as evalPkg from ${JSON.stringify(`file://${EVAL_DIST}`)};
		const result = ${expression};
		process.stdout.write(JSON.stringify(result));
	`;
	const result = execFileSync('node', ['--input-type=module', '-e', script], {
		cwd: ROOT,
		encoding: 'utf-8',
		timeout: 30_000,
		env: buildEnv(),
	});
	return JSON.parse(result);
}

function runCli(args: string[]): { stdout: string; stderr: string; exitCode: number } {
	const result = spawnSync('node', [CLI, ...args], {
		cwd: ROOT,
		encoding: 'utf-8',
		timeout: 60_000,
		stdio: ['pipe', 'pipe', 'pipe'],
		env: buildEnv(),
	});

	return {
		stdout: result.stdout ?? '',
		stderr: result.stderr ?? '',
		exitCode: result.status ?? 1,
	};
}

function parseJsonOutput(stdout: string): { results?: Record<string, unknown>; comparison?: Record<string, unknown> } {
	const trimmed = stdout.trim();
	if (!trimmed) {
		throw new Error('CLI returned empty stdout');
	}

	return JSON.parse(trimmed) as { results?: Record<string, unknown>; comparison?: Record<string, unknown> };
}

function readJson(path: string): Record<string, unknown> {
	return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
}

function expectOnlyResultKeys(stdout: string, keys: string[]): void {
	const parsed = parseJsonOutput(stdout);
	expect(Object.keys(parsed.results ?? {}).sort()).toEqual(keys.slice().sort());
}

describe('Spec 106: Golden tests for quality routing and assertion classification', () => {
	let tempDir = '';

	beforeAll(() => {
		expect(infraReady, 'Spec 106 requires built eval and CLI dist artifacts plus checked-in fixtures').toBe(true);
		tempDir = mkdtempSync(join(tmpdir(), 'mulder-spec-106-'));
	});

	afterAll(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it('QA-01: quality-routing goldens cover every required quality and route', () => {
		const files = readdirSync(QUALITY_GOLDEN_DIR).filter((file) => file.endsWith('.json'));
		expect(files.length).toBeGreaterThanOrEqual(4);

		const cases = files.map((file) => readJson(join(QUALITY_GOLDEN_DIR, file)));
		const expected = cases.map((entry) => (entry.expected ?? {}) as Record<string, unknown>);

		expect(new Set(expected.map((entry) => entry.overallQuality))).toEqual(
			new Set(['high', 'medium', 'low', 'unusable']),
		);
		for (const route of ['standard', 'enhanced_ocr', 'visual_extraction', 'skip']) {
			expect(
				expected.some((entry) => entry.recommendedPath === route),
				`missing route ${route}`,
			).toBe(true);
		}
		for (const entry of expected) {
			expect(typeof entry.processable).toBe('boolean');
			expect(entry.qualityMetadata).toBeDefined();
			expect(entry.signals).toBeDefined();
		}
	});

	it('QA-02: assertion goldens cover labels and complete confidence metadata', () => {
		const files = readdirSync(ASSERTION_GOLDEN_DIR).filter((file) => file.endsWith('.json'));
		expect(files.length).toBeGreaterThanOrEqual(3);

		const cases = files.map((file) => readJson(join(ASSERTION_GOLDEN_DIR, file)));
		const expected = cases.map((entry) => (entry.expected ?? {}) as Record<string, unknown>);

		expect(new Set(expected.map((entry) => entry.assertionType))).toEqual(
			new Set(['observation', 'interpretation', 'hypothesis']),
		);
		for (const entry of expected) {
			const confidence = entry.confidenceMetadata as Record<string, unknown>;
			for (const key of [
				'witness_count',
				'measurement_based',
				'contemporaneous',
				'corroborated',
				'peer_reviewed',
				'author_is_interpreter',
			]) {
				expect(confidence, `missing confidence key ${key}`).toHaveProperty(key);
			}
		}
	});

	it('QA-03 and QA-04: public runners validate, score, and pass checked-in fixtures deterministically', () => {
		const first = evalExpr(`({
			quality: evalPkg.runQualityRoutingEval(${JSON.stringify(QUALITY_GOLDEN_DIR)}, ${JSON.stringify(QUALITY_FIXTURE_DIR)}),
			assertions: evalPkg.runAssertionClassificationEval(${JSON.stringify(ASSERTION_GOLDEN_DIR)}, ${JSON.stringify(ASSERTION_FIXTURE_DIR)})
		})`) as {
			quality: { summary: { failedCases: number; coverage: { byQuality: Record<string, number> } } };
			assertions: { summary: { failedCases: number; coverage: { byAssertionType: Record<string, number> } } };
		};
		const second = evalExpr(`({
			quality: evalPkg.runQualityRoutingEval(${JSON.stringify(QUALITY_GOLDEN_DIR)}, ${JSON.stringify(QUALITY_FIXTURE_DIR)}),
			assertions: evalPkg.runAssertionClassificationEval(${JSON.stringify(ASSERTION_GOLDEN_DIR)}, ${JSON.stringify(ASSERTION_FIXTURE_DIR)})
		})`);

		expect(first).toEqual(second);
		expect(first.quality.summary.failedCases).toBe(0);
		expect(first.assertions.summary.failedCases).toBe(0);
		expect(Object.keys(first.quality.summary.coverage.byQuality).sort()).toEqual(['high', 'low', 'medium', 'unusable']);
		expect(Object.keys(first.assertions.summary.coverage.byAssertionType).sort()).toEqual([
			'hypothesis',
			'interpretation',
			'observation',
		]);
	});

	it('QA-05: runners report route and assertion mismatches without live services', () => {
		const qualityFixtures = join(tempDir, 'quality-fixtures');
		const assertionFixtures = join(tempDir, 'assertion-fixtures');
		cpSync(QUALITY_FIXTURE_DIR, qualityFixtures, { recursive: true });
		cpSync(ASSERTION_FIXTURE_DIR, assertionFixtures, { recursive: true });

		const qualityPath = join(qualityFixtures, 'medium-enhanced-ocr.json');
		const qualityFixture = readJson(qualityPath);
		(qualityFixture.assessment as Record<string, unknown>).recommendedPath = 'standard';
		writeFileSync(qualityPath, `${JSON.stringify(qualityFixture, null, 2)}\n`);

		const assertionPath = join(assertionFixtures, 'interpretation-correlation.json');
		const assertionFixture = readJson(assertionPath);
		(assertionFixture.assertion as Record<string, unknown>).assertion_type = 'observation';
		writeFileSync(assertionPath, `${JSON.stringify(assertionFixture, null, 2)}\n`);

		const result = evalExpr(`({
			quality: evalPkg.runQualityRoutingEval(${JSON.stringify(QUALITY_GOLDEN_DIR)}, ${JSON.stringify(qualityFixtures)}),
			assertions: evalPkg.runAssertionClassificationEval(${JSON.stringify(ASSERTION_GOLDEN_DIR)}, ${JSON.stringify(assertionFixtures)})
		})`) as {
			quality: { summary: { failedCases: number }; cases: Array<{ mismatches: Array<{ field: string }> }> };
			assertions: { summary: { failedCases: number }; cases: Array<{ mismatches: Array<{ field: string }> }> };
		};

		expect(result.quality.summary.failedCases).toBe(1);
		expect(result.quality.cases.flatMap((entry) => entry.mismatches.map((mismatch) => mismatch.field))).toContain(
			'recommendedPath',
		);
		expect(result.assertions.summary.failedCases).toBe(1);
		expect(result.assertions.cases.flatMap((entry) => entry.mismatches.map((mismatch) => mismatch.field))).toContain(
			'assertionType',
		);
	});

	it('validates malformed temp goldens with eval errors', () => {
		const badQualityDir = join(tempDir, 'bad-quality');
		const badAssertionDir = join(tempDir, 'bad-assertion');
		cpSync(QUALITY_GOLDEN_DIR, badQualityDir, { recursive: true });
		cpSync(ASSERTION_GOLDEN_DIR, badAssertionDir, { recursive: true });
		writeFileSync(join(badQualityDir, 'bad.json'), JSON.stringify({ caseId: 'bad' }));
		writeFileSync(join(badAssertionDir, 'bad.json'), JSON.stringify({ caseId: 'bad' }));

		const result = evalExpr(`({
			quality: (() => {
				try { evalPkg.loadQualityRoutingGoldenSet(${JSON.stringify(badQualityDir)}); return null; }
				catch (error) { return { name: error.name, code: error.code }; }
			})(),
			assertions: (() => {
				try { evalPkg.loadAssertionGoldenSet(${JSON.stringify(badAssertionDir)}); return null; }
				catch (error) { return { name: error.name, code: error.code }; }
			})()
		})`) as { quality: { name: string; code: string }; assertions: { name: string; code: string } };

		expect(result.quality.name).toBe('MulderEvalError');
		expect(result.quality.code).toBe('EVAL_GOLDEN_INVALID');
		expect(result.assertions.name).toBe('MulderEvalError');
		expect(result.assertions.code).toBe('EVAL_GOLDEN_INVALID');
	});

	it('QA-06 and QA-07: eval CLI selects quality/assertions and full eval includes all suites', () => {
		const quality = runCli(['eval', '--step', 'quality', '--json']);
		expect(quality.exitCode).toBe(0);
		expectOnlyResultKeys(quality.stdout, ['qualityRouting']);

		const assertions = runCli(['eval', '--step', 'assertions', '--json']);
		expect(assertions.exitCode).toBe(0);
		expectOnlyResultKeys(assertions.stdout, ['assertions']);

		const full = runCli(['eval', '--json']);
		expect(full.exitCode).toBe(0);
		expectOnlyResultKeys(full.stdout, ['assertions', 'entities', 'extraction', 'qualityRouting', 'segmentation']);
	});

	it('QA-08: baseline comparison supports the new suite keys and rejects invalid steps with updated help text', () => {
		const quality = runCli(['eval', '--step', 'quality', '--compare', 'baseline', '--json']);
		expect(quality.exitCode).toBe(0);
		expect(Object.keys((parseJsonOutput(quality.stdout).comparison?.suites as Record<string, unknown>) ?? {})).toEqual([
			'qualityRouting',
		]);

		const assertions = runCli(['eval', '--step', 'assertions', '--compare', 'baseline', '--json']);
		expect(assertions.exitCode).toBe(0);
		expect(
			Object.keys((parseJsonOutput(assertions.stdout).comparison?.suites as Record<string, unknown>) ?? {}),
		).toEqual(['assertions']);

		const bogus = runCli(['eval', '--step', 'bogus']);
		expect(bogus.exitCode).not.toBe(0);
		expect((bogus.stdout + bogus.stderr).toLowerCase()).toMatch(/quality|assertions/);
	});

	it('QA-09: new fixture-backed CLI suites succeed without cloud or database environment variables', () => {
		const quality = runCli(['eval', '--step', 'quality', '--json']);
		const assertions = runCli(['eval', '--step', 'assertions', '--json']);

		expect(quality.exitCode).toBe(0);
		expect(assertions.exitCode).toBe(0);
		expectOnlyResultKeys(quality.stdout, ['qualityRouting']);
		expectOnlyResultKeys(assertions.stdout, ['assertions']);
	});
});
