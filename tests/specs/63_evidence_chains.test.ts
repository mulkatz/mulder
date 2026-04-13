import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as db from '../lib/db.js';
import { ensureSchema } from '../lib/schema.js';

const ROOT = resolve(import.meta.dirname, '../..');
const CLI = resolve(ROOT, 'apps/cli/dist/index.js');
const EXAMPLE_CONFIG = resolve(ROOT, 'mulder.config.example.yaml');

const THESIS_PRIMARY = 'Acme activity in Berlin';
const THESIS_SECONDARY = 'Berlin activity in Acme';
const THESIS_UNRESOLVED = 'Unknown thesis';

const SOURCE_ACME_ID = '00000000-0000-0000-0000-000000630001';
const SOURCE_BERLIN_ID = '00000000-0000-0000-0000-000000630002';
const STORY_ACME_ID = '00000000-0000-0000-0000-000000630101';
const STORY_BERLIN_ID = '00000000-0000-0000-0000-000000630102';
const ENTITY_ACME_ID = '00000000-0000-0000-0000-000000630201';
const ENTITY_BERLIN_ID = '00000000-0000-0000-0000-000000630202';
const ENTITY_DENIED_ID = '00000000-0000-0000-0000-000000630203';
const EDGE_SUPPORT_ID = '00000000-0000-0000-0000-000000630401';
const EDGE_CONTRADICTION_ID = '00000000-0000-0000-0000-000000630402';

type EvidenceChainRow = {
	thesis: string;
	path: string;
	strength: string;
	supports: boolean;
	computed_at: string;
};

let tmpDir: string;
let pgAvailable = false;
let enabledSingleThesisConfigPath: string;
let enabledDualThesisConfigPath: string;
let enabledEmptyThesisConfigPath: string;
let sparseThresholdConfigPath: string;
let disabledConfigPath: string;
let featureDisabledConfigPath: string;

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

function writeAnalyzeConfig(options?: {
	enabled?: boolean;
	evidenceChains?: boolean;
	evidenceTheses?: string[];
	threshold?: number;
}): string {
	const base = readFileSync(EXAMPLE_CONFIG, 'utf-8');
	const devModeEnabled = base.replace(/^dev_mode:\s*false$/m, 'dev_mode: true');
	const theses = options?.evidenceTheses ?? [THESIS_PRIMARY];
	const thesisBlock =
		theses.length > 0
			? ['  evidence_theses:', ...theses.map((thesis) => `    - ${JSON.stringify(thesis)}`)].join('\n')
			: '  evidence_theses: []';

	const analysisReplacement = [
		'analysis:',
		`  enabled: ${options?.enabled ?? true}`,
		'  contradictions: true',
		'  reliability: true',
		`  evidence_chains: ${options?.evidenceChains ?? true}`,
		thesisBlock,
		'  spatio_temporal: true',
		'  cluster_window_days: 30',
		'',
		'# --- Sparse Graph Thresholds ---',
	].join('\n');

	const withAnalysis = devModeEnabled.replace(
		/analysis:\n[\s\S]*?\n# --- Sparse Graph Thresholds ---/,
		analysisReplacement,
	);
	const withThreshold =
		withAnalysis.replace(/corroboration_meaningful:\s*\d+/, `corroboration_meaningful: ${options?.threshold ?? 2}`);
	const configPath = join(tmpDir, `analyze-63-${Date.now()}-${Math.random().toString(16).slice(2)}.yaml`);
	writeFileSync(configPath, withThreshold, 'utf-8');
	return configPath;
}

function cleanTestData(): void {
	db.runSql(
		[
			'DELETE FROM pipeline_run_sources',
			'DELETE FROM pipeline_runs',
			'DELETE FROM jobs',
			'DELETE FROM evidence_chains',
			'DELETE FROM spatio_temporal_clusters',
			'DELETE FROM entity_grounding',
			'DELETE FROM story_entities',
			'DELETE FROM entity_edges',
			'DELETE FROM entity_aliases',
			'DELETE FROM taxonomy',
			'DELETE FROM entities',
			'DELETE FROM stories',
			'DELETE FROM source_steps',
			'DELETE FROM sources',
		].join('; '),
	);
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
			`VALUES (${sqlString(args.id)}, NULL, ${sqlString(args.name)}, 'organization', '{}'::jsonb, 'auto')`,
		].join(' '),
	);
}

function seedAlias(args: { id: string; entityId: string; alias: string }): void {
	db.runSql(
		[
			'INSERT INTO entity_aliases (id, entity_id, alias, source)',
			`VALUES (${sqlString(args.id)}, ${sqlString(args.entityId)}, ${sqlString(args.alias)}, 'manual')`,
		].join(' '),
	);
}

function linkStoryEntity(storyId: string, entityId: string): void {
	db.runSql(
		`INSERT INTO story_entities (story_id, entity_id, confidence, mention_count) VALUES (${sqlString(storyId)}, ${sqlString(entityId)}, 0.9, 1)`,
	);
}

function seedEvidenceChain(args: {
	id: string;
	thesis: string;
	path: string[];
	strength: number;
	supports: boolean;
}): void {
	db.runSql(
		[
			'INSERT INTO evidence_chains (id, thesis, path, strength, supports, computed_at)',
			`VALUES (${sqlString(args.id)}, ${sqlString(args.thesis)}, ARRAY[${args.path
				.map((entry) => sqlString(entry))
				.join(', ')}]::uuid[], ${args.strength}, ${args.supports}, now())`,
		].join(' '),
	);
}

function seedSupportFixture(): void {
	seedSource({ id: SOURCE_ACME_ID, filename: 'acme.pdf' });
	seedSource({ id: SOURCE_BERLIN_ID, filename: 'berlin.pdf' });
	seedStory({ id: STORY_ACME_ID, sourceId: SOURCE_ACME_ID, title: 'Acme Story' });
	seedStory({ id: STORY_BERLIN_ID, sourceId: SOURCE_BERLIN_ID, title: 'Berlin Story' });
	seedEntity({ id: ENTITY_ACME_ID, name: 'Acme' });
	seedEntity({ id: ENTITY_BERLIN_ID, name: 'Berlin' });
	seedAlias({ id: '00000000-0000-0000-0000-000000630301', entityId: ENTITY_ACME_ID, alias: 'Acme' });
	seedAlias({ id: '00000000-0000-0000-0000-000000630302', entityId: ENTITY_BERLIN_ID, alias: 'Berlin' });
	linkStoryEntity(STORY_ACME_ID, ENTITY_ACME_ID);
	linkStoryEntity(STORY_BERLIN_ID, ENTITY_BERLIN_ID);
	db.runSql(
		[
			'INSERT INTO entity_edges (id, source_entity_id, target_entity_id, relationship, edge_type, confidence, story_id)',
			`VALUES (${sqlString(EDGE_SUPPORT_ID)}, ${sqlString(ENTITY_ACME_ID)}, ${sqlString(ENTITY_BERLIN_ID)}, 'located_in', 'RELATIONSHIP', 0.88, ${sqlString(STORY_ACME_ID)})`,
		].join(' '),
	);
}

function seedMixedFixture(): void {
	seedSupportFixture();
	seedEntity({ id: ENTITY_DENIED_ID, name: 'Denied' });
	seedAlias({ id: '00000000-0000-0000-0000-000000630303', entityId: ENTITY_DENIED_ID, alias: 'Denied' });
	db.runSql(
		[
			'INSERT INTO entity_edges (id, source_entity_id, target_entity_id, relationship, edge_type, confidence, story_id)',
			`VALUES (${sqlString(EDGE_CONTRADICTION_ID)}, ${sqlString(ENTITY_ACME_ID)}, ${sqlString(ENTITY_DENIED_ID)}, 'denies', 'CONFIRMED_CONTRADICTION', 0.67, ${sqlString(STORY_ACME_ID)})`,
		].join(' '),
	);
}

function fetchChains(thesis?: string): EvidenceChainRow[] {
	const filter = thesis ? `WHERE thesis = ${sqlString(thesis)}` : '';
	const raw = db.runSql(
		[
			"SELECT COALESCE(json_agg(row_to_json(chains) ORDER BY thesis, path, supports)::text, '[]')",
			'FROM (',
			'  SELECT thesis, path::text AS path, strength::text AS strength, supports, computed_at::text AS computed_at',
			'  FROM evidence_chains',
			`  ${filter}`,
			'  ORDER BY thesis, path, supports',
			') chains;',
		].join('\n'),
	);
	return JSON.parse(raw) as EvidenceChainRow[];
}

function fetchDistinctTheses(): string[] {
	const raw = db.runSql(
		[
			"SELECT COALESCE(json_agg(theses.thesis ORDER BY theses.thesis)::text, '[]')",
			'FROM (',
			'  SELECT DISTINCT thesis',
			'  FROM evidence_chains',
			'  ORDER BY thesis',
			') theses;',
		].join('\n'),
	);
	return JSON.parse(raw) as string[];
}

describe.sequential('Spec 63 — Evidence Chains', () => {
	beforeAll(() => {
		tmpDir = mkdtempSync(join(tmpdir(), 'mulder-qa-63-'));
		enabledSingleThesisConfigPath = writeAnalyzeConfig({
			enabled: true,
			evidenceChains: true,
			evidenceTheses: [THESIS_PRIMARY],
		});
		enabledDualThesisConfigPath = writeAnalyzeConfig({
			enabled: true,
			evidenceChains: true,
			evidenceTheses: [THESIS_PRIMARY, THESIS_SECONDARY],
		});
		enabledEmptyThesisConfigPath = writeAnalyzeConfig({ enabled: true, evidenceChains: true, evidenceTheses: [] });
		sparseThresholdConfigPath = writeAnalyzeConfig({
			enabled: true,
			evidenceChains: true,
			evidenceTheses: [THESIS_PRIMARY],
			threshold: 5,
		});
		disabledConfigPath = writeAnalyzeConfig({ enabled: false, evidenceChains: true, evidenceTheses: [THESIS_PRIMARY] });
		featureDisabledConfigPath = writeAnalyzeConfig({
			enabled: true,
			evidenceChains: false,
			evidenceTheses: [THESIS_PRIMARY],
		});

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

	it('QA-01: sparse corpora skip evidence-chain traversal and writes', () => {
		if (!pgAvailable) return;
		seedEvidenceChain({
			id: '00000000-0000-0000-0000-000000630501',
			thesis: THESIS_PRIMARY,
			path: [ENTITY_ACME_ID, ENTITY_BERLIN_ID],
			strength: 0.88,
			supports: true,
		});
		const beforeChains = fetchChains(THESIS_PRIMARY);
		const result = runCli(['analyze', '--evidence-chains'], {
			env: { MULDER_CONFIG: sparseThresholdConfigPath },
		});
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toContain('not yet available');
		expect(fetchChains(THESIS_PRIMARY)).toEqual(beforeChains);
		expect(fetchDistinctTheses()).toEqual([THESIS_PRIMARY]);
	});

	it('QA-02: configured evidence theses persist supporting chains', () => {
		if (!pgAvailable) return;
		seedSupportFixture();

		const result = runCli(['analyze', '--evidence-chains'], { env: { MULDER_CONFIG: enabledSingleThesisConfigPath } });
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain('Thesis');
		expect(result.stderr).toContain('Analyze complete');

		const chains = fetchChains(THESIS_PRIMARY);
		expect(chains).not.toHaveLength(0);
		for (const chain of chains) {
			expect(chain.path).not.toBe('{}');
			expect(Number(chain.strength)).toBeGreaterThan(0);
			expect(chain.supports).toBe(true);
		}
	});

	it('QA-03: re-running the same thesis is idempotent', () => {
		if (!pgAvailable) return;
		seedMixedFixture();

		const first = runCli(['analyze', '--evidence-chains'], { env: { MULDER_CONFIG: enabledSingleThesisConfigPath } });
		expect(first.exitCode).toBe(0);
		const firstChains = fetchChains(THESIS_PRIMARY).map(({ thesis, path, strength, supports }) => ({
			thesis,
			path,
			strength,
			supports,
		}));

		const second = runCli(['analyze', '--evidence-chains'], { env: { MULDER_CONFIG: enabledSingleThesisConfigPath } });
		expect(second.exitCode).toBe(0);
		const secondChains = fetchChains(THESIS_PRIMARY).map(({ thesis, path, strength, supports }) => ({
			thesis,
			path,
			strength,
			supports,
		}));
		expect(secondChains).toEqual(firstChains);
	});

	it('QA-04: CLI thesis overrides work without config theses', () => {
		if (!pgAvailable) return;
		seedSupportFixture();

		const result = runCli(['analyze', '--evidence-chains', '--thesis', THESIS_PRIMARY], {
			env: { MULDER_CONFIG: enabledEmptyThesisConfigPath },
		});
		expect(result.exitCode).toBe(0);
		expect(fetchDistinctTheses()).toEqual([THESIS_PRIMARY]);
	});

	it('QA-05: confirmed contradiction evidence is persisted as non-supporting', () => {
		if (!pgAvailable) return;
		seedMixedFixture();

		const result = runCli(['analyze', '--evidence-chains'], { env: { MULDER_CONFIG: enabledSingleThesisConfigPath } });
		expect(result.exitCode).toBe(0);

		const chains = fetchChains(THESIS_PRIMARY);
		expect(chains.some((chain) => chain.supports === false)).toBe(true);
		expect(chains.some((chain) => Number(chain.strength) > 0)).toBe(true);
	});

	it('QA-06: missing thesis input fails before traversal or writes', () => {
		if (!pgAvailable) return;

		const result = runCli(['analyze', '--evidence-chains'], { env: { MULDER_CONFIG: enabledEmptyThesisConfigPath } });
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain('ANALYZE_THESIS_INPUT_MISSING');
		expect(result.stderr).toContain('At least one thesis query is required for evidence-chain analysis');
		expect(fetchChains()).toHaveLength(0);
	});

	it('QA-07: unresolvable theses report partial failure without blocking valid ones', () => {
		if (!pgAvailable) return;
		seedSupportFixture();

		const result = runCli(['analyze', '--evidence-chains', '--thesis', THESIS_PRIMARY, '--thesis', THESIS_UNRESOLVED], {
			env: { MULDER_CONFIG: enabledEmptyThesisConfigPath },
		});
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toContain('ANALYZE_THESIS_UNRESOLVED');
		expect(result.stderr).toContain('Analyze partial');
		expect(fetchDistinctTheses()).toEqual([THESIS_PRIMARY]);
		expect(fetchChains(THESIS_PRIMARY)).not.toHaveLength(0);
		expect(fetchChains(THESIS_UNRESOLVED)).toHaveLength(0);
	});

	it('QA-08: disabled evidence-chain analysis fails before writes', () => {
		if (!pgAvailable) return;
		seedSupportFixture();

		const disabledResult = runCli(['analyze', '--evidence-chains'], { env: { MULDER_CONFIG: disabledConfigPath } });
		expect(disabledResult.exitCode).not.toBe(0);
		expect(disabledResult.stderr).toContain('ANALYZE_DISABLED');
		expect(disabledResult.stderr).toContain('Evidence chain analysis is disabled in the active configuration');

		const featureDisabledResult = runCli(['analyze', '--evidence-chains'], {
			env: { MULDER_CONFIG: featureDisabledConfigPath },
		});
		expect(featureDisabledResult.exitCode).not.toBe(0);
		expect(featureDisabledResult.stderr).toContain('ANALYZE_DISABLED');
		expect(fetchChains()).toHaveLength(0);
	});

	it('CLI-01: `--evidence-chains` below `thresholds.corroboration_meaningful` reports sparse-data gating and persists no evidence-chain rows', () => {
		if (!pgAvailable) return;
		seedSupportFixture();

		const result = runCli(['analyze', '--evidence-chains'], { env: { MULDER_CONFIG: sparseThresholdConfigPath } });
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toContain('not yet available');
		expect(fetchChains()).toHaveLength(0);
	});

	it('CLI-02: `--evidence-chains` uses configured thesis strings and persists evidence-chain rows', () => {
		if (!pgAvailable) return;
		seedSupportFixture();

		const result = runCli(['analyze', '--evidence-chains'], { env: { MULDER_CONFIG: enabledDualThesisConfigPath } });
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain('Thesis');
		expect(result.stdout).toContain(THESIS_PRIMARY);
		expect(result.stdout).toContain(THESIS_SECONDARY);
		expect(fetchDistinctTheses()).toEqual([THESIS_PRIMARY, THESIS_SECONDARY]);
	});

	it('CLI-03: `--evidence-chains --thesis <text>` computes rows for the provided thesis only', () => {
		if (!pgAvailable) return;
		seedSupportFixture();

		const result = runCli(['analyze', '--evidence-chains', '--thesis', THESIS_PRIMARY], {
			env: { MULDER_CONFIG: enabledEmptyThesisConfigPath },
		});
		expect(result.exitCode).toBe(0);
		expect(fetchDistinctTheses()).toEqual([THESIS_PRIMARY]);
	});

	it('CLI-04: `--evidence-chains --thesis "A" --thesis "B"` processes both thesis strings in one run', () => {
		if (!pgAvailable) return;
		seedSupportFixture();

		const result = runCli(['analyze', '--evidence-chains', '--thesis', THESIS_PRIMARY, '--thesis', THESIS_SECONDARY], {
			env: { MULDER_CONFIG: enabledEmptyThesisConfigPath },
		});
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain(THESIS_PRIMARY);
		expect(result.stdout).toContain(THESIS_SECONDARY);
		expect(fetchDistinctTheses()).toEqual([THESIS_PRIMARY, THESIS_SECONDARY]);
	});

	it('CLI-05: `--evidence-chains` run twice preserves the first run snapshot', () => {
		if (!pgAvailable) return;
		seedMixedFixture();

		const first = runCli(['analyze', '--evidence-chains'], { env: { MULDER_CONFIG: enabledSingleThesisConfigPath } });
		expect(first.exitCode).toBe(0);
		const firstSnapshot = fetchChains(THESIS_PRIMARY).map(({ thesis, path, strength, supports }) => ({
			thesis,
			path,
			strength,
			supports,
		}));

		const second = runCli(['analyze', '--evidence-chains'], { env: { MULDER_CONFIG: enabledSingleThesisConfigPath } });
		expect(second.exitCode).toBe(0);
		const secondSnapshot = fetchChains(THESIS_PRIMARY).map(({ thesis, path, strength, supports }) => ({
			thesis,
			path,
			strength,
			supports,
		}));
		expect(secondSnapshot).toEqual(firstSnapshot);
	});

	it('CLI-06: `--evidence-chains --reliability` exits non-zero because multi-selector analyze is not implemented yet', () => {
		const result = runCli(['analyze', '--evidence-chains', '--reliability'], {
			env: { MULDER_CONFIG: enabledEmptyThesisConfigPath },
		});
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain('one selector or --full');
	});

	it('CLI-07: `--evidence-chains --contradictions` exits non-zero because multi-selector analyze is not implemented yet', () => {
		const result = runCli(['analyze', '--evidence-chains', '--contradictions'], {
			env: { MULDER_CONFIG: enabledEmptyThesisConfigPath },
		});
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain('one selector or --full');
	});

	it('CLI-08: `--evidence-chains --full` exits non-zero because full mode and single-pass selectors are mutually exclusive', () => {
		const result = runCli(['analyze', '--evidence-chains', '--full'], {
			env: { MULDER_CONFIG: enabledEmptyThesisConfigPath },
		});
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain('--full cannot be combined');
	});

	it('CLI-09: `--evidence-chains --thesis ""` exits non-zero with thesis validation feedback', () => {
		const result = runCli(['analyze', '--evidence-chains', '--thesis', ''], {
			env: { MULDER_CONFIG: enabledEmptyThesisConfigPath },
		});
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain('at least one non-empty value');
	});

	it('CLI-10: `mulder analyze` with no args now runs full analyze mode and skips thesis-less evidence chains', () => {
		if (!pgAvailable) return;
		seedSupportFixture();

		const result = runCli(['analyze'], { env: { MULDER_CONFIG: enabledEmptyThesisConfigPath } });
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain('evidence-chains');
		expect(result.stdout).toContain('skipped');
		expect(result.stderr).toContain('Analyze complete');
	});

	it('CLI-11: `--spatio-temporal` now succeeds as a no-op when no clusterable events exist', () => {
		if (!pgAvailable) return;

		const result = runCli(['analyze', '--spatio-temporal'], { env: { MULDER_CONFIG: enabledEmptyThesisConfigPath } });
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toContain('no clusterable events found');
	});
});

describe('Spec 63 — Evidence Chains CLI smoke', () => {
	it('SMOKE-01: `mulder analyze --help` exits 0 and shows evidence-chain options', () => {
		const result = runCli(['analyze', '--help'], { env: { MULDER_CONFIG: enabledEmptyThesisConfigPath } });
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain('--evidence-chains');
		expect(result.stdout).toContain('--thesis');
	});
});
