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

const ENTITY_ID = '00000000-0000-0000-0000-000000610001';
const VALID_EDGE_ID = '00000000-0000-0000-0000-000000610101';
const INVALID_EDGE_ID = '00000000-0000-0000-0000-000000610102';
const SOURCE_A_ID = '00000000-0000-0000-0000-000000610201';
const SOURCE_B_ID = '00000000-0000-0000-0000-000000610202';
const STORY_A_ID = '00000000-0000-0000-0000-000000610301';
const STORY_B_ID = '00000000-0000-0000-0000-000000610302';

let tmpDir: string;
let pgAvailable = false;
let enabledConfigPath: string;
let disabledConfigPath: string;
let contradictionsDisabledConfigPath: string;

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

function jsonLiteral(value: Record<string, unknown>): string {
	return `${sqlString(JSON.stringify(value))}::jsonb`;
}

function writeAnalyzeConfig(options?: { enabled?: boolean; contradictions?: boolean }): string {
	const base = readFileSync(EXAMPLE_CONFIG, 'utf-8');
	const devModeEnabled = base.replace(/^dev_mode:\s*false$/m, 'dev_mode: true');
	const replacement = [
		'analysis:',
		`  enabled: ${options?.enabled ?? true}`,
		`  contradictions: ${options?.contradictions ?? true}`,
		'  reliability: true',
		'  evidence_chains: true',
		'  spatio_temporal: true',
		'  cluster_window_days: 30',
		'',
		'# --- Sparse Graph Thresholds ---',
	].join('\n');

	const updated = devModeEnabled.replace(/analysis:\n[\s\S]*?\n# --- Sparse Graph Thresholds ---/, replacement);
	const configPath = join(tmpDir, `analyze-${Date.now()}-${Math.random().toString(16).slice(2)}.yaml`);
	writeFileSync(configPath, updated, 'utf-8');
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

function seedStory(args: { id: string; sourceId: string; title: string; pageStart: number; pageEnd: number }): void {
	db.runSql(
		[
			'INSERT INTO stories (id, source_id, title, subtitle, language, category, page_start, page_end, gcs_markdown_uri, gcs_metadata_uri, chunk_count, extraction_confidence, status, metadata)',
			`VALUES (${sqlString(args.id)}, ${sqlString(args.sourceId)}, ${sqlString(args.title)}, NULL, 'en', 'article', ${args.pageStart}, ${args.pageEnd}, ${sqlString(`gs://test/segments/${args.id}.md`)}, ${sqlString(`gs://test/segments/${args.id}.json`)}, 0, 0.9, 'graphed', '{}'::jsonb)`,
		].join(' '),
	);
}

function seedEntity(): void {
	db.runSql(
		[
			'INSERT INTO entities (id, canonical_id, name, type, attributes, taxonomy_status)',
			`VALUES (${sqlString(ENTITY_ID)}, NULL, 'Alice Adler', 'person', '{}'::jsonb, 'auto')`,
		].join(' '),
	);
}

function seedContradictionEdge(args: {
	edgeId: string;
	storyIdA: string;
	storyIdB: string;
	valueA: string;
	valueB: string;
	storyId?: string;
}): void {
	db.runSql(
		[
			'INSERT INTO entity_edges (id, source_entity_id, target_entity_id, relationship, attributes, confidence, story_id, edge_type, analysis)',
			`VALUES (${sqlString(args.edgeId)}, ${sqlString(ENTITY_ID)}, ${sqlString(ENTITY_ID)}, 'contradiction_status', ${jsonLiteral(
				{
					attribute: 'status',
					valueA: args.valueA,
					valueB: args.valueB,
					storyIdA: args.storyIdA,
					storyIdB: args.storyIdB,
				},
			)}, NULL, ${sqlString(args.storyId ?? args.storyIdA)}, 'POTENTIAL_CONTRADICTION', NULL)`,
		].join(' '),
	);
}

function seedValidFixture(edgeId = VALID_EDGE_ID): void {
	seedSource({ id: SOURCE_A_ID, filename: 'source-a.pdf' });
	seedSource({ id: SOURCE_B_ID, filename: 'source-b.pdf' });
	seedStory({ id: STORY_A_ID, sourceId: SOURCE_A_ID, title: 'Claim A Story', pageStart: 1, pageEnd: 1 });
	seedStory({ id: STORY_B_ID, sourceId: SOURCE_B_ID, title: 'Claim B Story', pageStart: 2, pageEnd: 2 });
	seedEntity();
	seedContradictionEdge({
		edgeId,
		storyIdA: STORY_A_ID,
		storyIdB: STORY_B_ID,
		valueA: 'active',
		valueB: 'inactive',
	});
}

function edgeType(edgeId: string): string {
	return db.runSql(`SELECT edge_type FROM entity_edges WHERE id = ${sqlString(edgeId)};`);
}

function edgeAnalysis(edgeId: string): Record<string, unknown> | null {
	const raw = db.runSqlSafe(`SELECT analysis::text FROM entity_edges WHERE id = ${sqlString(edgeId)};`);
	if (!raw || raw === 'null') {
		return null;
	}
	return JSON.parse(raw);
}

describe('Spec 61 — Contradiction Resolution', () => {
	beforeAll(() => {
		tmpDir = mkdtempSync(join(tmpdir(), 'mulder-qa-61-'));
		enabledConfigPath = writeAnalyzeConfig({ enabled: true, contradictions: true });
		disabledConfigPath = writeAnalyzeConfig({ enabled: false, contradictions: true });
		contradictionsDisabledConfigPath = writeAnalyzeConfig({ enabled: true, contradictions: false });

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

	it('QA-01: contradiction analysis resolves pending edges into final verdicts', () => {
		if (!pgAvailable) return;
		seedValidFixture();

		const result = runCli(['analyze', '--contradictions'], { env: { MULDER_CONFIG: enabledConfigPath } });
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toContain('Analyze complete');
		expect(edgeType(VALID_EDGE_ID)).toBe('CONFIRMED_CONTRADICTION');

		const analysis = edgeAnalysis(VALID_EDGE_ID);
		expect(analysis).toBeTruthy();
		expect(String(analysis?.explanation ?? '')).not.toHaveLength(0);
	});

	it('QA-02: re-running the step is idempotent after all pending contradictions are resolved', () => {
		if (!pgAvailable) return;
		seedValidFixture();

		const first = runCli(['analyze', '--contradictions'], { env: { MULDER_CONFIG: enabledConfigPath } });
		expect(first.exitCode).toBe(0);
		const firstType = edgeType(VALID_EDGE_ID);
		const firstAnalysis = edgeAnalysis(VALID_EDGE_ID);

		const second = runCli(['analyze', '--contradictions'], { env: { MULDER_CONFIG: enabledConfigPath } });
		expect(second.exitCode).toBe(0);
		expect(second.stderr).toContain('no pending contradiction edges');
		expect(edgeType(VALID_EDGE_ID)).toBe(firstType);
		expect(edgeAnalysis(VALID_EDGE_ID)).toEqual(firstAnalysis);
	});

	it('QA-03: no-op runs succeed cleanly when there is nothing to resolve', () => {
		if (!pgAvailable) return;

		const result = runCli(['analyze', '--contradictions'], { env: { MULDER_CONFIG: enabledConfigPath } });
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toContain('no pending contradiction edges');
		expect(db.runSql("SELECT COUNT(*) FROM entity_edges WHERE edge_type = 'POTENTIAL_CONTRADICTION';")).toBe('0');
	});

	it('QA-04: disabled contradiction analysis fails before any LLM work', () => {
		if (!pgAvailable) return;
		seedValidFixture();

		const result = runCli(['analyze', '--contradictions'], { env: { MULDER_CONFIG: disabledConfigPath } });
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain('ANALYZE_DISABLED');
		expect(edgeType(VALID_EDGE_ID)).toBe('POTENTIAL_CONTRADICTION');
		expect(edgeAnalysis(VALID_EDGE_ID)).toBeNull();

		const result2 = runCli(['analyze', '--contradictions'], {
			env: { MULDER_CONFIG: contradictionsDisabledConfigPath },
		});
		expect(result2.exitCode).not.toBe(0);
		expect(result2.stderr).toContain('ANALYZE_DISABLED');
		expect(edgeType(VALID_EDGE_ID)).toBe('POTENTIAL_CONTRADICTION');
	});

	it('QA-05: missing contradiction context fails without partial updates', () => {
		if (!pgAvailable) return;
		seedSource({ id: SOURCE_A_ID, filename: 'missing-context.pdf' });
		seedStory({ id: STORY_A_ID, sourceId: SOURCE_A_ID, title: 'Only Story', pageStart: 1, pageEnd: 1 });
		seedEntity();
		seedContradictionEdge({
			edgeId: VALID_EDGE_ID,
			storyIdA: STORY_A_ID,
			storyIdB: STORY_B_ID,
			valueA: 'active',
			valueB: 'inactive',
		});

		const result = runCli(['analyze', '--contradictions'], { env: { MULDER_CONFIG: enabledConfigPath } });
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain('ANALYZE_CONTEXT_MISSING');
		expect(edgeType(VALID_EDGE_ID)).toBe('POTENTIAL_CONTRADICTION');
		expect(edgeAnalysis(VALID_EDGE_ID)).toBeNull();
	});

	it('QA-06: mixed batches preserve successful verdicts and report partial failure', () => {
		if (!pgAvailable) return;
		seedValidFixture();
		seedContradictionEdge({
			edgeId: INVALID_EDGE_ID,
			storyIdA: STORY_A_ID,
			storyIdB: '00000000-0000-0000-0000-000000619999',
			valueA: 'onsite',
			valueB: 'remote',
			storyId: STORY_B_ID,
		});

		const result = runCli(['analyze', '--contradictions'], { env: { MULDER_CONFIG: enabledConfigPath } });
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toContain('Analyze partial');
		expect(result.stderr).toContain('ANALYZE_CONTEXT_MISSING');
		expect(edgeType(VALID_EDGE_ID)).toBe('CONFIRMED_CONTRADICTION');
		expect(edgeType(INVALID_EDGE_ID)).toBe('POTENTIAL_CONTRADICTION');
	});

	it('CLI-01: --contradictions resolves pending contradiction edges and prints a summary table', () => {
		if (!pgAvailable) return;
		seedValidFixture();

		const result = runCli(['analyze', '--contradictions'], { env: { MULDER_CONFIG: enabledConfigPath } });
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain('Edge ID');
		expect(result.stdout).toContain('confirmed');
		expect(result.stderr).toContain('Analyze complete');
	});

	it('CLI-02: running --contradictions twice reports zero processed contradictions on the second run', () => {
		if (!pgAvailable) return;
		seedValidFixture();

		expect(runCli(['analyze', '--contradictions'], { env: { MULDER_CONFIG: enabledConfigPath } }).exitCode).toBe(0);
		const result = runCli(['analyze', '--contradictions'], { env: { MULDER_CONFIG: enabledConfigPath } });
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toContain('no pending contradiction edges');
	});

	it('CLI-03: --contradictions --json exits non-zero because JSON output is not supported', () => {
		const result = runCli(['analyze', '--contradictions', '--json'], { env: { MULDER_CONFIG: enabledConfigPath } });
		expect(result.exitCode).not.toBe(0);
		expect(`${result.stdout}\n${result.stderr}`).toMatch(/unknown option|unexpected option/i);
	});

	it('CLI-04: --contradictions --full exits non-zero because --full belongs to M6-G7', () => {
		const result = runCli(['analyze', '--contradictions', '--full'], { env: { MULDER_CONFIG: enabledConfigPath } });
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

	it('CLI-07: --reliability now succeeds because source reliability scoring is implemented', () => {
		if (!pgAvailable) return;
		seedValidFixture();

		const result = runCli(['analyze', '--reliability'], { env: { MULDER_CONFIG: enabledConfigPath } });
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toContain('Analyze complete');
	});

	it('CLI-08: --evidence-chains exits non-zero because evidence chains belong to M6-G5', () => {
		const result = runCli(['analyze', '--evidence-chains'], { env: { MULDER_CONFIG: enabledConfigPath } });
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain('M6-G5');
	});

	it('CLI-09: --spatio-temporal exits non-zero because clustering belongs to M6-G6', () => {
		const result = runCli(['analyze', '--spatio-temporal'], { env: { MULDER_CONFIG: enabledConfigPath } });
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain('M6-G6');
	});
});

describe('CLI Smoke Tests: analyze', () => {
	it('SMOKE-01: mulder analyze --help exits 0 and shows the available selectors', () => {
		const result = runCli(['analyze', '--help'], { env: { MULDER_CONFIG: enabledConfigPath } });
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain('Usage:');
		expect(result.stdout).toContain('--contradictions');
	});

	it('SMOKE-02: mulder analyze --contradictions --reliability exits non-zero without crashing', () => {
		const result = runCli(['analyze', '--contradictions', '--reliability'], {
			env: { MULDER_CONFIG: enabledConfigPath },
		});
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain('one selector at a time');
	});

	it('SMOKE-03: mulder analyze --contradictions --spatio-temporal exits non-zero without crashing', () => {
		const result = runCli(['analyze', '--contradictions', '--spatio-temporal'], {
			env: { MULDER_CONFIG: enabledConfigPath },
		});
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain('M6-G6');
	});
});
