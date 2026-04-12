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

const EVENT_A_ID = '00000000-0000-0000-0000-000000640001';
const EVENT_B_ID = '00000000-0000-0000-0000-000000640002';
const EVENT_C_ID = '00000000-0000-0000-0000-000000640003';
const TIME_ONLY_ID = '00000000-0000-0000-0000-000000640004';
const SPACE_ONLY_ID = '00000000-0000-0000-0000-000000640005';
const STALE_CLUSTER_ID = '00000000-0000-0000-0000-000000640101';

type ClusterRow = {
	id: string;
	clusterType: string;
	centerLat: string | null;
	centerLng: string | null;
	timeStart: string | null;
	timeEnd: string | null;
	eventCount: number;
	eventIds: string[];
	computedAt: string;
};

let tmpDir: string;
const pgAvailable = db.isPgAvailable();
let enabledConfigPath: string;
let disabledConfigPath: string;
let featureDisabledConfigPath: string;
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

function jsonLiteral(value: Record<string, unknown>): string {
	return `${sqlString(JSON.stringify(value))}::jsonb`;
}

function geometryLiteral(coords?: { lat: number; lng: number }): string {
	if (!coords) {
		return 'NULL';
	}

	return `ST_SetSRID(ST_MakePoint(${coords.lng}, ${coords.lat}), 4326)`;
}

function writeAnalyzeConfig(options?: {
	enabled?: boolean;
	spatioTemporal?: boolean;
	threshold?: number;
	clusterWindowDays?: number;
}): string {
	const base = readFileSync(EXAMPLE_CONFIG, 'utf-8');
	const devModeEnabled = base.replace(/^dev_mode:\s*false$/m, 'dev_mode: true');
	const analysisReplacement = [
		'analysis:',
		`  enabled: ${options?.enabled ?? true}`,
		'  contradictions: true',
		'  reliability: true',
		'  evidence_chains: true',
		`  spatio_temporal: ${options?.spatioTemporal ?? true}`,
		`  cluster_window_days: ${options?.clusterWindowDays ?? 30}`,
		'',
		'# --- Sparse Graph Thresholds ---',
	].join('\n');

	const withAnalysis = devModeEnabled.replace(
		/analysis:\n[\s\S]*?\n# --- Sparse Graph Thresholds ---/,
		analysisReplacement,
	);
	const threshold = options?.threshold ?? 3;
	const withThreshold = withAnalysis.replace(/temporal_clustering:\s*\d+/, `temporal_clustering: ${threshold}`);
	const configPath = join(tmpDir, `analyze-64-${Date.now()}-${Math.random().toString(16).slice(2)}.yaml`);
	writeFileSync(configPath, withThreshold, 'utf-8');
	return configPath;
}

function cleanTestData(): void {
	truncateMulderTables();
}

function seedEntity(args: { id: string; name: string; isoDate?: string; coords?: { lat: number; lng: number } }): void {
	const attributes = args.isoDate ? { iso_date: args.isoDate } : {};
	db.runSql(
		[
			'INSERT INTO entities (id, canonical_id, name, type, attributes, taxonomy_status, geom)',
			`VALUES (${sqlString(args.id)}, NULL, ${sqlString(args.name)}, 'event', ${jsonLiteral(attributes)}, 'auto', ${geometryLiteral(args.coords)})`,
		].join(' '),
	);
}

function seedThreeEventFixture(): void {
	seedEntity({
		id: EVENT_A_ID,
		name: 'Event A',
		isoDate: '2024-01-01',
		coords: { lat: 52.52, lng: 13.405 },
	});
	seedEntity({
		id: EVENT_B_ID,
		name: 'Event B',
		isoDate: '2024-01-03',
		coords: { lat: 52.5204, lng: 13.406 },
	});
	seedEntity({
		id: EVENT_C_ID,
		name: 'Event C',
		isoDate: '2024-01-05',
		coords: { lat: 52.5198, lng: 13.4044 },
	});
}

function seedMixedDimensionFixture(): void {
	seedThreeEventFixture();
	seedEntity({ id: TIME_ONLY_ID, name: 'Time Only', isoDate: '2024-01-04' });
	seedEntity({ id: SPACE_ONLY_ID, name: 'Space Only', coords: { lat: 52.5202, lng: 13.4055 } });
}

function seedExistingClusterSnapshot(): void {
	db.runSql(
		[
			'INSERT INTO spatio_temporal_clusters (id, center_lat, center_lng, time_start, time_end, event_count, event_ids, cluster_type, computed_at)',
			`VALUES (${sqlString(STALE_CLUSTER_ID)}, 51.5, 0.12, '2024-02-01T00:00:00Z', '2024-02-02T00:00:00Z', 2, ARRAY[${sqlString(EVENT_A_ID)}::uuid, ${sqlString(EVENT_B_ID)}::uuid], 'spatio-temporal', '2024-02-03T00:00:00Z')`,
		].join(' '),
	);
}

function fetchClusters(): ClusterRow[] {
	const raw = db.runSql(
		[
			'SELECT COALESCE(json_agg(row_to_json(clusters) ORDER BY "clusterType")::text, \'[]\')',
			'FROM (',
			'  SELECT',
			'    id::text AS id,',
			'    cluster_type AS "clusterType",',
			'    center_lat::text AS "centerLat",',
			'    center_lng::text AS "centerLng",',
			'    time_start::text AS "timeStart",',
			'    time_end::text AS "timeEnd",',
			'    event_count AS "eventCount",',
			'    to_json(event_ids) AS "eventIds",',
			'    computed_at::text AS "computedAt"',
			'  FROM spatio_temporal_clusters',
			'  ORDER BY cluster_type',
			') clusters;',
		].join('\n'),
	);
	return JSON.parse(raw) as ClusterRow[];
}

function normalizedSnapshot(): Array<Omit<ClusterRow, 'id' | 'computedAt'>> {
	return fetchClusters().map(({ clusterType, centerLat, centerLng, timeStart, timeEnd, eventCount, eventIds }) => ({
		clusterType,
		centerLat,
		centerLng,
		timeStart,
		timeEnd,
		eventCount,
		eventIds: [...eventIds].sort(),
	}));
}

describe('Spec 64 — Spatio-Temporal Clustering', () => {
	beforeAll(() => {
		tmpDir = mkdtempSync(join(tmpdir(), 'mulder-qa-64-'));
		enabledConfigPath = writeAnalyzeConfig({ enabled: true, spatioTemporal: true, threshold: 3 });
		disabledConfigPath = writeAnalyzeConfig({ enabled: false, spatioTemporal: true, threshold: 3 });
		featureDisabledConfigPath = writeAnalyzeConfig({ enabled: true, spatioTemporal: false, threshold: 3 });
		sparseThresholdConfigPath = writeAnalyzeConfig({ enabled: true, spatioTemporal: true, threshold: 4 });

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

	it.skipIf(!pgAvailable)('QA-01: spatio-temporal analysis persists combined clusters for eligible events', () => {
		seedThreeEventFixture();

		const result = runCli(['analyze', '--spatio-temporal'], { env: { MULDER_CONFIG: enabledConfigPath } });
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain('spatio-temporal');
		expect(result.stderr).toContain('Analyze complete');

		const clusters = fetchClusters();
		expect(clusters.map((cluster) => cluster.clusterType)).toEqual(['spatial', 'spatio-temporal', 'temporal']);

		const combined = clusters.find((cluster) => cluster.clusterType === 'spatio-temporal');
		expect(combined).toBeTruthy();
		expect(combined?.eventCount).toBe(3);
		expect(combined?.eventIds.sort()).toEqual([EVENT_A_ID, EVENT_B_ID, EVENT_C_ID]);
		expect(combined?.centerLat).not.toBeNull();
		expect(combined?.centerLng).not.toBeNull();
		expect(combined?.timeStart).not.toBeNull();
		expect(combined?.timeEnd).not.toBeNull();
	});

	it.skipIf(!pgAvailable)('QA-02: re-running clustering is idempotent for unchanged event data', () => {
		seedThreeEventFixture();

		const first = runCli(['analyze', '--spatio-temporal'], { env: { MULDER_CONFIG: enabledConfigPath } });
		expect(first.exitCode).toBe(0);
		const firstSnapshot = normalizedSnapshot();

		const second = runCli(['analyze', '--spatio-temporal'], { env: { MULDER_CONFIG: enabledConfigPath } });
		expect(second.exitCode).toBe(0);
		expect(normalizedSnapshot()).toEqual(firstSnapshot);
		expect(fetchClusters()).toHaveLength(3);
	});

	it.skipIf(!pgAvailable)('QA-03: sparse corpora degrade gracefully without persisting misleading clusters', () => {
		seedThreeEventFixture();

		const result = runCli(['analyze', '--spatio-temporal'], { env: { MULDER_CONFIG: sparseThresholdConfigPath } });
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toContain('below temporal clustering threshold');
		expect(fetchClusters()).toHaveLength(0);
	});

	it.skipIf(!pgAvailable)('QA-04: disabled spatio-temporal analysis fails before any writes', () => {
		seedThreeEventFixture();
		seedExistingClusterSnapshot();
		const snapshotBefore = fetchClusters();

		const disabledResult = runCli(['analyze', '--spatio-temporal'], {
			env: { MULDER_CONFIG: disabledConfigPath },
		});
		expect(disabledResult.exitCode).not.toBe(0);
		expect(disabledResult.stderr).toContain('ANALYZE_DISABLED');
		expect(fetchClusters()).toEqual(snapshotBefore);

		const featureDisabledResult = runCli(['analyze', '--spatio-temporal'], {
			env: { MULDER_CONFIG: featureDisabledConfigPath },
		});
		expect(featureDisabledResult.exitCode).not.toBe(0);
		expect(featureDisabledResult.stderr).toContain('ANALYZE_DISABLED');
		expect(fetchClusters()).toEqual(snapshotBefore);
	});

	it.skipIf(!pgAvailable)('QA-05: events missing one dimension still contribute only to valid cluster types', () => {
		seedMixedDimensionFixture();

		const result = runCli(['analyze', '--spatio-temporal'], { env: { MULDER_CONFIG: enabledConfigPath } });
		expect(result.exitCode).toBe(0);

		const clusters = fetchClusters();
		const temporal = clusters.find((cluster) => cluster.clusterType === 'temporal');
		const spatial = clusters.find((cluster) => cluster.clusterType === 'spatial');
		const combined = clusters.find((cluster) => cluster.clusterType === 'spatio-temporal');

		expect(temporal?.eventCount).toBe(4);
		expect(temporal?.eventIds).toContain(TIME_ONLY_ID);
		expect(temporal?.eventIds).not.toContain(SPACE_ONLY_ID);

		expect(spatial?.eventCount).toBe(4);
		expect(spatial?.eventIds).toContain(SPACE_ONLY_ID);
		expect(spatial?.eventIds).not.toContain(TIME_ONLY_ID);

		expect(combined?.eventCount).toBe(3);
		expect(combined?.eventIds.sort()).toEqual([EVENT_A_ID, EVENT_B_ID, EVENT_C_ID]);
		expect(combined?.eventIds).not.toContain(TIME_ONLY_ID);
		expect(combined?.eventIds).not.toContain(SPACE_ONLY_ID);
	});

	it.skipIf(!pgAvailable)('QA-06: no-op runs succeed cleanly when no clusterable events exist', () => {
		const result = runCli(['analyze', '--spatio-temporal'], { env: { MULDER_CONFIG: enabledConfigPath } });
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toContain('no clusterable events found');
		expect(fetchClusters()).toHaveLength(0);
	});

	it.skipIf(!pgAvailable)('CLI-01: --spatio-temporal computes and persists the current cluster snapshot', () => {
		seedThreeEventFixture();

		const result = runCli(['analyze', '--spatio-temporal'], { env: { MULDER_CONFIG: enabledConfigPath } });
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain('Type');
		expect(result.stdout).toContain('spatio-temporal');
		expect(result.stderr).toContain('3 clusters persisted');
		expect(fetchClusters()).toHaveLength(3);
	});

	it.skipIf(!pgAvailable)(
		'CLI-02: running --spatio-temporal twice preserves snapshot semantics without duplicate rows',
		() => {
			seedThreeEventFixture();

			expect(runCli(['analyze', '--spatio-temporal'], { env: { MULDER_CONFIG: enabledConfigPath } }).exitCode).toBe(0);
			const firstSnapshot = normalizedSnapshot();

			const result = runCli(['analyze', '--spatio-temporal'], { env: { MULDER_CONFIG: enabledConfigPath } });
			expect(result.exitCode).toBe(0);
			expect(normalizedSnapshot()).toEqual(firstSnapshot);
			expect(fetchClusters()).toHaveLength(3);
		},
	);

	it('CLI-03: --spatio-temporal --reliability exits non-zero because multi-selector analyze is not implemented yet', () => {
		const result = runCli(['analyze', '--spatio-temporal', '--reliability'], {
			env: { MULDER_CONFIG: enabledConfigPath },
		});
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain('one selector at a time');
	});

	it('CLI-04: --spatio-temporal --evidence-chains exits non-zero because multi-selector analyze is not implemented yet', () => {
		const result = runCli(['analyze', '--spatio-temporal', '--evidence-chains'], {
			env: { MULDER_CONFIG: enabledConfigPath },
		});
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain('one selector at a time');
	});

	it('CLI-05: --spatio-temporal --contradictions exits non-zero because multi-selector analyze is not implemented yet', () => {
		const result = runCli(['analyze', '--spatio-temporal', '--contradictions'], {
			env: { MULDER_CONFIG: enabledConfigPath },
		});
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain('one selector at a time');
	});

	it('CLI-06: --spatio-temporal --full exits non-zero because --full belongs to M6-G7', () => {
		const result = runCli(['analyze', '--spatio-temporal', '--full'], {
			env: { MULDER_CONFIG: enabledConfigPath },
		});
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain('M6-G7');
	});

	it('CLI-07: no args exits non-zero and asks for an analysis selector', () => {
		const result = runCli(['analyze'], { env: { MULDER_CONFIG: enabledConfigPath } });
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain('analysis selector');
	});

	it('CLI-08: --full exits non-zero because the full Analyze orchestrator is not implemented yet', () => {
		const result = runCli(['analyze', '--full'], { env: { MULDER_CONFIG: enabledConfigPath } });
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain('M6-G7');
	});
});
