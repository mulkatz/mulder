import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as db from '../lib/db.js';
import { ensureSchema, truncateMulderTables } from '../lib/schema.js';

const ROOT = resolve(import.meta.dirname, '../..');
const CLI = resolve(ROOT, 'apps/cli/dist/index.js');
const EXAMPLE_CONFIG = resolve(ROOT, 'mulder.config.example.yaml');

const SOURCE_A_ID = '00000000-0000-0000-0000-000000620101';
const SOURCE_B_ID = '00000000-0000-0000-0000-000000620102';
const SOURCE_C_ID = '00000000-0000-0000-0000-000000620103';
const STORY_A_ID = '00000000-0000-0000-0000-000000620201';
const STORY_B_ID = '00000000-0000-0000-0000-000000620202';
const STORY_C_ID = '00000000-0000-0000-0000-000000620203';
const ENTITY_SHARED_AB = '00000000-0000-0000-0000-000000620301';
const ENTITY_SHARED_BC = '00000000-0000-0000-0000-000000620302';
const ENTITY_ISOLATED = '00000000-0000-0000-0000-000000620303';

let tmpDir: string;
let pgAvailable = false;
let enabledConfigPath: string;
let disabledConfigPath: string;
let reliabilityDisabledConfigPath: string;
let sparseThresholdConfigPath: string;

function runCli(
	args: string[],
	opts?: { env?: Record<string, string>; timeout?: number },
): { stdout: string; stderr: string; exitCode: number } {
	const result = spawnSync('node', [CLI, ...args], {
		cwd: ROOT,
		encoding: 'utf-8',
		timeout: opts?.timeout ?? 60_000,
		stdio: ['pipe', 'pipe', 'pipe'],
		env: {
			...process.env,
			PGPASSWORD: db.TEST_PG_PASSWORD,
			MULDER_LOG_LEVEL: 'silent',
			...opts?.env,
		},
	});

	return {
		stdout: result.stdout ?? '',
		stderr: result.stderr ?? '',
		exitCode: result.status ?? 1,
	};
}

function sqlString(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

function writeAnalyzeConfig(options?: { enabled?: boolean; reliability?: boolean; threshold?: number }): string {
	const base = readFileSync(EXAMPLE_CONFIG, 'utf-8');
	const devModeEnabled = base.replace(/^dev_mode:\s*false$/m, 'dev_mode: true');
	const analysisReplacement = [
		'analysis:',
		`  enabled: ${options?.enabled ?? true}`,
		'  contradictions: true',
		`  reliability: ${options?.reliability ?? true}`,
		'  evidence_chains: true',
		'  spatio_temporal: true',
		'  cluster_window_days: 30',
		'',
		'# --- Sparse Graph Thresholds ---',
	].join('\n');

	const withAnalysis = devModeEnabled.replace(
		/analysis:\n[\s\S]*?\n# --- Sparse Graph Thresholds ---/,
		analysisReplacement,
	);
	const threshold = options?.threshold ?? 50;
	const withThreshold = withAnalysis.replace(/source_reliability:\s*\d+/, `source_reliability: ${threshold}`);
	const configPath = join(tmpDir, `analyze-62-${Date.now()}-${Math.random().toString(16).slice(2)}.yaml`);
	writeFileSync(configPath, withThreshold, 'utf-8');
	return configPath;
}

function cleanTestData(): void {
	truncateMulderTables();
}

function seedSource(args: { id: string; filename: string }): void {
	db.runSql(
		[
			'INSERT INTO sources (id, filename, storage_path, file_hash, has_native_text, native_text_ratio, status, metadata)',
			`VALUES (${sqlString(args.id)}, ${sqlString(args.filename)}, ${sqlString(`gs://test/raw/${args.filename}`)}, ${sqlString(`${args.id}-hash`)}, true, 1.0, 'graphed', '{}'::jsonb)`,
		].join(' '),
	);
}

function seedStory(args: { id: string; sourceId: string; title: string }): void {
	db.runSql(
		[
			'INSERT INTO stories (id, source_id, title, subtitle, language, category, page_start, page_end, gcs_markdown_uri, gcs_metadata_uri, chunk_count, extraction_confidence, status, metadata)',
			`VALUES (${sqlString(args.id)}, ${sqlString(args.sourceId)}, ${sqlString(args.title)}, NULL, 'en', 'article', 1, 1, ${sqlString(`gs://test/segments/${args.id}.md`)}, ${sqlString(`gs://test/segments/${args.id}.json`)}, 0, 0.9, 'graphed', '{}'::jsonb)`,
		].join(' '),
	);
}

function seedEntity(args: { id: string; name: string }): void {
	db.runSql(
		[
			'INSERT INTO entities (id, canonical_id, name, type, attributes, taxonomy_status)',
			`VALUES (${sqlString(args.id)}, NULL, ${sqlString(args.name)}, 'person', '{}'::jsonb, 'auto')`,
		].join(' '),
	);
}

function linkStoryEntity(storyId: string, entityId: string): void {
	db.runSql(
		`INSERT INTO story_entities (story_id, entity_id, confidence, mention_count) VALUES (${sqlString(storyId)}, ${sqlString(entityId)}, 0.9, 1)`,
	);
}

function unlinkStoryEntity(storyId: string, entityId: string): void {
	db.runSql(`DELETE FROM story_entities WHERE story_id = ${sqlString(storyId)} AND entity_id = ${sqlString(entityId)}`);
}

function setReliabilityScore(sourceId: string, score: number): void {
	db.runSql(`UPDATE sources SET reliability_score = ${score} WHERE id = ${sqlString(sourceId)}`);
}

function seedConnectedFixture(): void {
	seedSource({ id: SOURCE_A_ID, filename: 'source-a.pdf' });
	seedSource({ id: SOURCE_B_ID, filename: 'source-b.pdf' });
	seedSource({ id: SOURCE_C_ID, filename: 'source-c.pdf' });
	seedStory({ id: STORY_A_ID, sourceId: SOURCE_A_ID, title: 'Story A' });
	seedStory({ id: STORY_B_ID, sourceId: SOURCE_B_ID, title: 'Story B' });
	seedStory({ id: STORY_C_ID, sourceId: SOURCE_C_ID, title: 'Story C' });
	seedEntity({ id: ENTITY_SHARED_AB, name: 'Shared AB' });
	seedEntity({ id: ENTITY_SHARED_BC, name: 'Shared BC' });

	linkStoryEntity(STORY_A_ID, ENTITY_SHARED_AB);
	linkStoryEntity(STORY_B_ID, ENTITY_SHARED_AB);
	linkStoryEntity(STORY_B_ID, ENTITY_SHARED_BC);
	linkStoryEntity(STORY_C_ID, ENTITY_SHARED_BC);
}

function seedIsolatedFixture(): void {
	seedSource({ id: SOURCE_A_ID, filename: 'isolated-a.pdf' });
	seedSource({ id: SOURCE_B_ID, filename: 'isolated-b.pdf' });
	seedStory({ id: STORY_A_ID, sourceId: SOURCE_A_ID, title: 'Isolated A' });
	seedStory({ id: STORY_B_ID, sourceId: SOURCE_B_ID, title: 'Isolated B' });
	seedEntity({ id: ENTITY_ISOLATED, name: 'Only A' });
	seedEntity({ id: ENTITY_SHARED_AB, name: 'Only B' });
	linkStoryEntity(STORY_A_ID, ENTITY_ISOLATED);
	linkStoryEntity(STORY_B_ID, ENTITY_SHARED_AB);
}

function getReliabilityScores(): Array<{ id: string; score: string | null }> {
	const raw = db.runSql(
		`SELECT COALESCE(json_agg(row_to_json(scores) ORDER BY id)::text, '[]')
		 FROM (
		   SELECT id, reliability_score::text AS score
		   FROM sources
		   WHERE id IN (${sqlString(SOURCE_A_ID)}, ${sqlString(SOURCE_B_ID)}, ${sqlString(SOURCE_C_ID)})
		 ) scores;`,
	);
	return JSON.parse(raw);
}

describe('Spec 62 — Source Reliability Scoring', () => {
	beforeAll(() => {
		tmpDir = mkdtempSync(join(tmpdir(), 'mulder-qa-62-'));
		enabledConfigPath = writeAnalyzeConfig({ enabled: true, reliability: true, threshold: 50 });
		disabledConfigPath = writeAnalyzeConfig({ enabled: false, reliability: true, threshold: 50 });
		reliabilityDisabledConfigPath = writeAnalyzeConfig({ enabled: true, reliability: false, threshold: 50 });
		sparseThresholdConfigPath = writeAnalyzeConfig({ enabled: true, reliability: true, threshold: 5 });

		pgAvailable = db.isPgAvailable();
		if (!pgAvailable) {
			console.warn('SKIP: PostgreSQL not reachable at PGHOST/PGPORT.');
			return;
		}

		ensureSchema();
		cleanTestData();
	}, 120_000);

	beforeEach(() => {
		if (!pgAvailable) return;
		cleanTestData();
	});

	afterAll(() => {
		if (pgAvailable) {
			cleanTestData();
		}
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it('QA-01: reliability analysis scores graph-connected sources and persists results', () => {
		if (!pgAvailable) return;
		seedConnectedFixture();

		const result = runCli(['analyze', '--reliability'], { env: { MULDER_CONFIG: enabledConfigPath } });
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain('Source ID');
		expect(result.stderr).toContain('Analyze complete');

		const scores = getReliabilityScores();
		const populatedScores = scores.filter((entry) => entry.score !== null);
		expect(populatedScores).toHaveLength(3);
		for (const entry of populatedScores) {
			const numericScore = Number(entry.score);
			expect(numericScore).toBeGreaterThanOrEqual(0);
			expect(numericScore).toBeLessThanOrEqual(1);
		}
		expect(Number(scores.find((entry) => entry.id === SOURCE_B_ID)?.score ?? 0)).toBeGreaterThan(
			Number(scores.find((entry) => entry.id === SOURCE_A_ID)?.score ?? 0),
		);
	});

	it('QA-02: re-running reliability analysis is idempotent for unchanged corpus data', () => {
		if (!pgAvailable) return;
		seedConnectedFixture();

		const first = runCli(['analyze', '--reliability'], { env: { MULDER_CONFIG: enabledConfigPath } });
		expect(first.exitCode).toBe(0);
		const firstScores = getReliabilityScores();

		const second = runCli(['analyze', '--reliability'], { env: { MULDER_CONFIG: enabledConfigPath } });
		expect(second.exitCode).toBe(0);
		expect(getReliabilityScores()).toEqual(firstScores);
	});

	it('QA-03: sparse corpora succeed with a degradation warning', () => {
		if (!pgAvailable) return;
		seedConnectedFixture();

		const result = runCli(['analyze', '--reliability'], { env: { MULDER_CONFIG: sparseThresholdConfigPath } });
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toContain('below meaningful reliability threshold');
		expect(getReliabilityScores().filter((entry) => entry.score !== null)).toHaveLength(3);
	});

	it('QA-04: disabled reliability analysis fails before writing scores', () => {
		if (!pgAvailable) return;
		seedConnectedFixture();

		const result = runCli(['analyze', '--reliability'], { env: { MULDER_CONFIG: disabledConfigPath } });
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain('ANALYZE_DISABLED');
		expect(getReliabilityScores().filter((entry) => entry.score !== null)).toHaveLength(0);

		const result2 = runCli(['analyze', '--reliability'], {
			env: { MULDER_CONFIG: reliabilityDisabledConfigPath },
		});
		expect(result2.exitCode).not.toBe(0);
		expect(result2.stderr).toContain('ANALYZE_DISABLED');
		expect(getReliabilityScores().filter((entry) => entry.score !== null)).toHaveLength(0);
	});

	it('QA-05: no-op runs succeed when no source graph can be formed', () => {
		if (!pgAvailable) return;
		seedIsolatedFixture();
		setReliabilityScore(SOURCE_A_ID, 0.42);

		const result = runCli(['analyze', '--reliability'], { env: { MULDER_CONFIG: enabledConfigPath } });
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toContain('no graph-connected sources found');
		expect(getReliabilityScores()).toEqual([
			{ id: SOURCE_A_ID, score: '0.42' },
			{ id: SOURCE_B_ID, score: null },
		]);
	});

	it('CLI-01: --reliability scores eligible sources and prints a reliability table', () => {
		if (!pgAvailable) return;
		seedConnectedFixture();

		const result = runCli(['analyze', '--reliability'], { env: { MULDER_CONFIG: enabledConfigPath } });
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain('Source ID');
		expect(result.stdout).toContain('source-b.pdf');
		expect(result.stderr).toContain('Analyze complete');
	});

	it('CLI-02: running --reliability twice preserves the first run scores', () => {
		if (!pgAvailable) return;
		seedConnectedFixture();

		expect(runCli(['analyze', '--reliability'], { env: { MULDER_CONFIG: enabledConfigPath } }).exitCode).toBe(0);
		const before = getReliabilityScores();
		const result = runCli(['analyze', '--reliability'], { env: { MULDER_CONFIG: enabledConfigPath } });
		expect(result.exitCode).toBe(0);
		expect(getReliabilityScores()).toEqual(before);
	});

	it('REGRESSION-01: rerun clears stale scores for sources that are no longer graph-connected', () => {
		if (!pgAvailable) return;
		seedConnectedFixture();

		expect(runCli(['analyze', '--reliability'], { env: { MULDER_CONFIG: enabledConfigPath } }).exitCode).toBe(0);
		expect(Number(getReliabilityScores().find((entry) => entry.id === SOURCE_C_ID)?.score ?? 0)).toBeGreaterThan(0);

		unlinkStoryEntity(STORY_B_ID, ENTITY_SHARED_BC);
		unlinkStoryEntity(STORY_C_ID, ENTITY_SHARED_BC);

		const result = runCli(['analyze', '--reliability'], { env: { MULDER_CONFIG: enabledConfigPath } });
		expect(result.exitCode).toBe(0);

		const scores = getReliabilityScores();
		expect(scores.find((entry) => entry.id === SOURCE_A_ID)?.score).not.toBeNull();
		expect(scores.find((entry) => entry.id === SOURCE_B_ID)?.score).not.toBeNull();
		expect(scores.find((entry) => entry.id === SOURCE_C_ID)?.score).toBeNull();
	});

	it('CLI-03: --contradictions --reliability exits non-zero because multi-selector analyze is not implemented yet', () => {
		const result = runCli(['analyze', '--contradictions', '--reliability'], {
			env: { MULDER_CONFIG: enabledConfigPath },
		});
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain('one selector at a time');
	});

	it('CLI-04: --reliability --full exits non-zero because --full belongs to M6-G7', () => {
		const result = runCli(['analyze', '--reliability', '--full'], {
			env: { MULDER_CONFIG: enabledConfigPath },
		});
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain('M6-G7');
	});

	it('CLI-05: no args exits non-zero and asks for an analysis selector', () => {
		const result = runCli(['analyze'], { env: { MULDER_CONFIG: enabledConfigPath } });
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain('--contradictions');
	});

	it('CLI-06: --full exits non-zero because the full Analyze orchestrator is not implemented yet', () => {
		const result = runCli(['analyze', '--full'], { env: { MULDER_CONFIG: enabledConfigPath } });
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain('M6-G7');
	});

	it('CLI-07: --evidence-chains exits non-zero when no thesis input is configured', () => {
		const result = runCli(['analyze', '--evidence-chains'], { env: { MULDER_CONFIG: enabledConfigPath } });
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain('ANALYZE_THESIS_INPUT_MISSING');
		expect(result.stderr).toContain('At least one thesis query');
	});

	it('CLI-08: --spatio-temporal now succeeds as a no-op when no clusterable events exist', () => {
		if (!pgAvailable) return;

		const result = runCli(['analyze', '--spatio-temporal'], { env: { MULDER_CONFIG: enabledConfigPath } });
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toContain('no clusterable events found');
	});
});

describe('CLI Smoke Tests: analyze reliability', () => {
	it('SMOKE-01: mulder analyze --help exits 0 and shows the reliability selector', () => {
		const result = runCli(['analyze', '--help'], { env: { MULDER_CONFIG: enabledConfigPath } });
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain('Usage:');
		expect(result.stdout).toContain('--reliability');
	});

	it('SMOKE-02: mulder analyze --contradictions --reliability exits non-zero without crashing', () => {
		const result = runCli(['analyze', '--contradictions', '--reliability'], {
			env: { MULDER_CONFIG: enabledConfigPath },
		});
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain('one selector at a time');
	});

	it('SMOKE-03: mulder analyze --reliability --spatio-temporal exits non-zero with selector validation', () => {
		const result = runCli(['analyze', '--reliability', '--spatio-temporal'], {
			env: { MULDER_CONFIG: enabledConfigPath },
		});
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain('one selector at a time');
	});
});
