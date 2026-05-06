import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const CLI = resolve(ROOT, 'apps/cli/dist/index.js');
const BASELINE_PATH = resolve(ROOT, 'eval/metrics/baseline.json');
const GOLDEN_DIRS = [
	resolve(ROOT, 'eval/golden/extraction'),
	resolve(ROOT, 'eval/golden/segmentation'),
	resolve(ROOT, 'eval/golden/entities'),
	resolve(ROOT, 'eval/golden/quality-routing'),
	resolve(ROOT, 'eval/golden/assertions'),
];
const FIXTURE_DIRS = [
	resolve(ROOT, 'fixtures/extracted'),
	resolve(ROOT, 'fixtures/segments'),
	resolve(ROOT, 'fixtures/entities'),
	resolve(ROOT, 'fixtures/quality-routing'),
	resolve(ROOT, 'fixtures/assertions'),
];

/**
 * Black-box QA tests for Spec 77: Eval CLI + Reporter.
 *
 * Tests interact only through subprocesses and filesystem checks.
 * No imports from apps/, packages/, or src/.
 */

const infraReady =
	existsSync(CLI) &&
	existsSync(BASELINE_PATH) &&
	GOLDEN_DIRS.every((dir) => existsSync(dir)) &&
	FIXTURE_DIRS.every((dir) => existsSync(dir));

function buildEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		NODE_ENV: 'test',
		MULDER_LOG_LEVEL: 'silent',
		...extra,
	};

	for (const key of [
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

function runCli(
	args: string[],
	opts?: { env?: Record<string, string>; timeoutMs?: number },
): { stdout: string; stderr: string; exitCode: number } {
	const result = spawnSync('node', [CLI, ...args], {
		cwd: ROOT,
		encoding: 'utf-8',
		timeout: opts?.timeoutMs ?? 60_000,
		stdio: ['pipe', 'pipe', 'pipe'],
		env: buildEnv(opts?.env),
	});

	return {
		stdout: result.stdout ?? '',
		stderr: result.stderr ?? '',
		exitCode: result.status ?? 1,
	};
}

function parseJsonOutput(stdout: string): unknown {
	const trimmed = stdout.trim();
	if (!trimmed) {
		throw new Error('CLI returned empty stdout');
	}

	try {
		return JSON.parse(trimmed);
	} catch {
		const firstBrace = trimmed.indexOf('{');
		const lastBrace = trimmed.lastIndexOf('}');
		if (firstBrace < 0 || lastBrace <= firstBrace) {
			throw new Error(`stdout did not contain parseable JSON: ${trimmed}`);
		}

		return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
	}
}

function expectOnlyResultsKeys(parsed: { results?: Record<string, unknown> }, keys: string[]): void {
	expect(parsed.results).toBeDefined();
	expect(Object.keys(parsed.results ?? {}).sort()).toEqual(keys.slice().sort());
}

function expectReportSections(stdout: string, sections: string[]): void {
	const text = stdout.toLowerCase();
	for (const section of sections) {
		expect(text).toContain(section.toLowerCase());
	}
}

function backupFile(path: string, backupDir: string): string {
	mkdirSync(backupDir, { recursive: true });
	const backupPath = join(backupDir, path.replaceAll('/', '__'));
	copyFileSync(path, backupPath);
	return backupPath;
}

describe('Spec 77: Eval CLI + Reporter', () => {
	let tempDir = '';

	beforeAll(() => {
		expect(infraReady, `Missing required infra for spec 77: CLI=${CLI}, baseline=${BASELINE_PATH}`).toBe(true);
		if (!infraReady) {
			return;
		}
		tempDir = resolve(ROOT, '.tmp-spec-77');
		mkdirSync(tempDir, { recursive: true });
	});

	afterAll(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	describe('QA contract', () => {
		it('QA-01: full eval runs locally', () => {
			const { exitCode, stdout } = runCli(['eval']);

			expect(exitCode).toBe(0);
			expectReportSections(stdout, [
				'Extraction Quality',
				'Segmentation Quality',
				'Entity Extraction',
				'Quality Routing',
				'Assertion Classification',
			]);
		});

		it('QA-02: single-step extract run is scoped', () => {
			const { exitCode, stdout } = runCli(['eval', '--step', 'extract', '--json']);

			expect(exitCode).toBe(0);
			const parsed = parseJsonOutput(stdout) as {
				results?: Record<string, unknown>;
			};
			expectOnlyResultsKeys(parsed, ['extraction']);
		});

		it('QA-03: single-step segment run is scoped', () => {
			const { exitCode, stdout } = runCli(['eval', '--step', 'segment', '--json']);

			expect(exitCode).toBe(0);
			const parsed = parseJsonOutput(stdout) as {
				results?: Record<string, unknown>;
			};
			expectOnlyResultsKeys(parsed, ['segmentation']);
		});

		it('QA-04: single-step enrich run is scoped', () => {
			const { exitCode, stdout } = runCli(['eval', '--step', 'enrich', '--json']);

			expect(exitCode).toBe(0);
			const parsed = parseJsonOutput(stdout) as {
				results?: Record<string, unknown>;
			};
			expectOnlyResultsKeys(parsed, ['entities']);
		});

		it('QA-05: baseline comparison works', () => {
			const { exitCode, stdout } = runCli(['eval', '--compare', 'baseline', '--json']);

			expect(exitCode).toBe(0);
			const parsed = parseJsonOutput(stdout) as {
				comparison?: { against?: string; suites?: Record<string, unknown> };
			};
			expect(parsed.comparison?.against).toBe('baseline');
			expect(parsed.comparison?.suites).toBeDefined();
			expect(Object.keys(parsed.comparison?.suites ?? {}).length).toBeGreaterThan(0);
		});

		it('QA-06: invalid step is rejected', () => {
			const { exitCode, stderr, stdout } = runCli(['eval', '--step', 'bogus']);

			expect(exitCode).not.toBe(0);
			expect((stdout + stderr).toLowerCase()).toMatch(/extract|segment|enrich/);
		});

		it('QA-07: missing baseline is rejected for compare mode', () => {
			const backupPath = backupFile(BASELINE_PATH, tempDir);
			rmSync(BASELINE_PATH);
			try {
				const { exitCode, stderr, stdout } = runCli(['eval', '--compare', 'baseline']);

				expect(exitCode).not.toBe(0);
				expect((stdout + stderr).toLowerCase()).toMatch(/baseline/);
				expect((stdout + stderr).toLowerCase()).toMatch(/missing|not found|absent|no such/);
			} finally {
				copyFileSync(backupPath, BASELINE_PATH);
			}
		});

		it('QA-08: invalid baseline JSON is rejected', () => {
			const backupPath = backupFile(BASELINE_PATH, tempDir);
			writeFileSync(BASELINE_PATH, '{ invalid json', 'utf-8');
			try {
				const { exitCode, stderr, stdout } = runCli(['eval', '--compare', 'baseline']);

				expect(exitCode).not.toBe(0);
				expect((stdout + stderr).toLowerCase()).toMatch(/json|parse|unexpected/i);
			} finally {
				copyFileSync(backupPath, BASELINE_PATH);
			}
		});

		it('QA-09: baseline update rewrites only selected suites', () => {
			const backupPath = backupFile(BASELINE_PATH, tempDir);
			const original = JSON.parse(readFileSync(BASELINE_PATH, 'utf-8')) as Record<string, unknown>;

			try {
				const { exitCode, stdout } = runCli(['eval', '--step', 'extract', '--update-baseline', '--json']);

				expect(exitCode).toBe(0);
				const parsed = parseJsonOutput(stdout) as {
					baselineUpdated?: boolean;
					results?: Record<string, unknown>;
				};
				expect(parsed.baselineUpdated).toBe(true);
				expectOnlyResultsKeys(parsed, ['extraction']);

				const updated = JSON.parse(readFileSync(BASELINE_PATH, 'utf-8')) as Record<string, unknown>;
				expect(updated.extraction).toBeDefined();
				expect(updated.extraction).not.toEqual(original.extraction);

				for (const key of Object.keys(original)) {
					if (key === 'extraction') continue;
					expect(updated[key]).toEqual(original[key]);
				}
			} finally {
				copyFileSync(backupPath, BASELINE_PATH);
			}
		});

		it('QA-10: command is fixture-only', () => {
			const { exitCode, stdout, stderr } = runCli(['eval', '--step', 'extract'], {
				env: {
					GOOGLE_APPLICATION_CREDENTIALS: '',
					GOOGLE_CLOUD_PROJECT: '',
					GCLOUD_PROJECT: '',
					GCP_PROJECT: '',
					CLOUDSDK_CORE_PROJECT: '',
				},
			});

			expect(exitCode).toBe(0);
			expect((stdout + stderr).toLowerCase()).toContain('extraction');
		});
	});

	describe('CLI matrix', () => {
		it('CLI-01: mulder eval', () => {
			const { exitCode, stdout } = runCli(['eval']);

			expect(exitCode).toBe(0);
			expectReportSections(stdout, [
				'Extraction Quality',
				'Segmentation Quality',
				'Entity Extraction',
				'Quality Routing',
				'Assertion Classification',
			]);
		});

		it('CLI-02: mulder eval --step extract', () => {
			const { exitCode, stdout } = runCli(['eval', '--step', 'extract']);

			expect(exitCode).toBe(0);
			expectReportSections(stdout, ['Extraction Quality']);
			expect(stdout.toLowerCase()).not.toContain('segmentation quality');
			expect(stdout.toLowerCase()).not.toContain('entity extraction');
		});

		it('CLI-03: mulder eval --step segment', () => {
			const { exitCode, stdout } = runCli(['eval', '--step', 'segment']);

			expect(exitCode).toBe(0);
			expectReportSections(stdout, ['Segmentation Quality']);
			expect(stdout.toLowerCase()).not.toContain('extraction quality');
		});

		it('CLI-04: mulder eval --step enrich', () => {
			const { exitCode, stdout } = runCli(['eval', '--step', 'enrich']);

			expect(exitCode).toBe(0);
			expectReportSections(stdout, ['Entity Extraction']);
			expect(stdout.toLowerCase()).not.toContain('segmentation quality');
		});

		it('CLI-05: mulder eval --compare baseline', () => {
			const { exitCode, stdout } = runCli(['eval', '--compare', 'baseline']);

			expect(exitCode).toBe(0);
			expect(stdout.toLowerCase()).toContain('baseline');
			expect(stdout.toLowerCase()).toContain('extraction');
		});

		it('CLI-06: mulder eval --step extract --compare baseline --json', () => {
			const { exitCode, stdout } = runCli(['eval', '--step', 'extract', '--compare', 'baseline', '--json']);

			expect(exitCode).toBe(0);
			const parsed = parseJsonOutput(stdout) as {
				results?: Record<string, unknown>;
				comparison?: { against?: string; suites?: Record<string, unknown> };
			};
			expectOnlyResultsKeys(parsed, ['extraction']);
			expect(parsed.comparison?.against).toBe('baseline');
			expect(Object.keys(parsed.comparison?.suites ?? {})).toEqual(['extraction']);
		});

		it('CLI-07: mulder eval --update-baseline --step extract --json', () => {
			const backupPath = backupFile(BASELINE_PATH, tempDir);
			try {
				const { exitCode, stdout } = runCli(['eval', '--update-baseline', '--step', 'extract', '--json']);

				expect(exitCode).toBe(0);
				const parsed = parseJsonOutput(stdout) as { baselineUpdated?: boolean };
				expect(parsed.baselineUpdated).toBe(true);
				expect(JSON.parse(readFileSync(BASELINE_PATH, 'utf-8'))).toBeDefined();
			} finally {
				copyFileSync(backupPath, BASELINE_PATH);
			}
		});

		it('CLI-08: mulder eval --step bogus', () => {
			const { exitCode, stderr, stdout } = runCli(['eval', '--step', 'bogus']);

			expect(exitCode).not.toBe(0);
			expect((stdout + stderr).toLowerCase()).toMatch(/extract|segment|enrich/);
		});

		it('CLI-09: mulder eval --compare unsupported', () => {
			const { exitCode, stderr, stdout } = runCli(['eval', '--compare', 'unsupported']);

			expect(exitCode).not.toBe(0);
			expect((stdout + stderr).toLowerCase()).toMatch(/baseline/);
		});

		it('CLI-10: mulder eval --compare baseline with missing baseline file', () => {
			const backupPath = backupFile(BASELINE_PATH, tempDir);
			rmSync(BASELINE_PATH);
			try {
				const { exitCode, stderr, stdout } = runCli(['eval', '--compare', 'baseline']);

				expect(exitCode).not.toBe(0);
				expect((stdout + stderr).toLowerCase()).toMatch(/baseline/);
				expect((stdout + stderr).toLowerCase()).toMatch(/missing|not found|absent|no such/);
			} finally {
				copyFileSync(backupPath, BASELINE_PATH);
			}
		});
	});

	describe('Discovery smoke', () => {
		it('smoke: eval --help exposes the documented surface', () => {
			const { exitCode, stdout } = runCli(['eval', '--help']);

			expect(exitCode).toBe(0);
			expect(stdout).toContain('--step');
			expect(stdout).toContain('--compare');
			expect(stdout).toContain('--update-baseline');
			expect(stdout).toContain('--json');
		});

		it('smoke: eval --json returns parseable JSON for the full run', () => {
			const { exitCode, stdout } = runCli(['eval', '--json']);

			expect(exitCode).toBe(0);
			const parsed = parseJsonOutput(stdout) as { results?: Record<string, unknown> };
			expectOnlyResultsKeys(parsed, ['assertions', 'entities', 'extraction', 'qualityRouting', 'segmentation']);
		});

		it('smoke: eval --step extract --compare baseline --json stays scoped to the selected suite', () => {
			const { exitCode, stdout } = runCli(['eval', '--step', 'extract', '--compare', 'baseline', '--json']);

			expect(exitCode).toBe(0);
			const parsed = parseJsonOutput(stdout) as {
				results?: Record<string, unknown>;
				comparison?: { suites?: Record<string, unknown> };
			};
			expectOnlyResultsKeys(parsed, ['extraction']);
			expect(Object.keys(parsed.comparison?.suites ?? {})).toEqual(['extraction']);
		});
	});
});
