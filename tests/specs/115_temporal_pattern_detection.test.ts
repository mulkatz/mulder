import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as db from '../lib/db.js';
import { ensureSchema, MULDER_TEST_TABLES, truncateExistingTables } from '../lib/schema.js';

const ROOT = resolve(import.meta.dirname, '../..');
const CORE_DIR = resolve(ROOT, 'packages/core');
const PIPELINE_DIR = resolve(ROOT, 'packages/pipeline');
const CLI_DIR = resolve(ROOT, 'apps/cli');
const CORE_DIST = resolve(CORE_DIR, 'dist/index.js');
const PIPELINE_DIST = resolve(PIPELINE_DIR, 'dist/index.js');
const EXAMPLE_CONFIG = resolve(ROOT, 'mulder.config.example.yaml');

const PG_CONFIG = {
	host: db.TEST_PG_HOST,
	port: db.TEST_PG_PORT,
	database: db.TEST_PG_DATABASE,
	user: db.TEST_PG_USER,
	password: db.TEST_PG_PASSWORD,
};

const pgAvailable = db.isPgAvailable();
let pool: pg.Pool;
let tempDir: string | null = null;
let coreModule: typeof import('@mulder/core');
let pipelineModule: typeof import('@mulder/pipeline');

const SPEC_CATEGORY_REF = { taxonomyId: 'spec115-taxonomy', categoryId: 'spec115-category' };
const SPEC_CATEGORY_ATTR_REF = {
	taxonomy_id: 'spec115-taxonomy',
	category_id: 'spec115-category',
	taxonomyId: 'spec115-taxonomy',
	categoryId: 'spec115-category',
};
const GENERIC_CAVEAT = 'Patterns are hypothesis starters, not causal evidence.';

function buildPackage(packageDir: string): void {
	const result = spawnSync('pnpm', ['build'], {
		cwd: packageDir,
		encoding: 'utf-8',
		timeout: 180_000,
		stdio: ['ignore', 'pipe', 'pipe'],
		env: { ...process.env, MULDER_LOG_LEVEL: 'silent' },
	});
	if ((result.status ?? 1) !== 0) {
		throw new Error(`Build failed in ${packageDir}:\n${result.stdout}\n${result.stderr}`);
	}
}

function writeMinimalConfigWithoutTemporalPatterns(): string {
	if (!tempDir) tempDir = mkdtempSync(join(tmpdir(), 'mulder-spec115-'));
	const configPath = join(tempDir, `minimal-${randomUUID()}.yaml`);
	writeFileSync(
		configPath,
		[
			'project:',
			'  name: "spec115"',
			'  supported_locales: ["en"]',
			'gcp:',
			'  project_id: "test-project"',
			'  region: "europe-west1"',
			'  cloud_sql:',
			'    instance_name: "mulder-db"',
			'    database: "mulder"',
			'  storage:',
			'    bucket: "mulder-test"',
			'  document_ai:',
			'    processor_id: "processor"',
			'ontology:',
			'  entity_types:',
			'    - name: "event"',
			'      description: "Generic event entity"',
			'  relationships: []',
			'',
		].join('\n'),
		'utf-8',
	);
	return configPath;
}

function cleanTables(): void {
	truncateExistingTables(MULDER_TEST_TABLES);
}

function sensitivityMetadata(level: import('@mulder/core').SensitivityLevel) {
	return {
		level,
		reason: 'spec115_fixture',
		assignedBy: 'policy_rule' as const,
		assignedAt: '2026-05-07T00:00:00.000Z',
		piiTypes: [],
		declassifyDate: null,
	};
}

function provenance(sourceDocumentIds: string[] = [randomUUID()]) {
	return {
		sourceDocumentIds,
		extractionPipelineRun: `spec115-run-${randomUUID()}`,
		createdAt: '2026-05-07T00:00:00.000Z',
	};
}

function cloneConfig(): import('@mulder/core').MulderConfig {
	return structuredClone(coreModule.loadConfig(EXAMPLE_CONFIG)) as import('@mulder/core').MulderConfig;
}

function tunedTemporalConfig(options?: {
	anomalies?: boolean;
	hotspots?: boolean;
	minEntities?: number;
	significanceThreshold?: number;
	radiusKm?: number;
	minClusterSize?: number;
	persistenceThresholdYears?: number;
}): import('@mulder/core').MulderConfig {
	const config = cloneConfig();
	config.temporal_pattern_detection.enabled = true;
	config.temporal_pattern_detection.schedule = 'manual';
	config.temporal_pattern_detection.anomaly_detection = {
		...config.temporal_pattern_detection.anomaly_detection,
		enabled: options?.anomalies ?? true,
		min_entities: options?.minEntities ?? 5,
		significance_threshold: options?.significanceThreshold ?? 0.05,
		baseline_window_years: 5,
		granularity: 'month',
		region_grid: 'country',
		max_regions: 25,
		max_windows: 72,
		window_size_buckets: 1,
		known_patterns: [],
	};
	config.temporal_pattern_detection.hotspot_clustering = {
		...config.temporal_pattern_detection.hotspot_clustering,
		enabled: options?.hotspots ?? true,
		algorithm: 'hdbscan',
		min_cluster_size: options?.minClusterSize ?? 3,
		radius_km: options?.radiusKm ?? 25,
		temporal_granularity: 'year',
		persistence_threshold_years: options?.persistenceThresholdYears ?? 2,
		max_clusters: 25,
	};
	config.temporal_pattern_detection.reporting_bias = {
		correction_enabled: true,
		correction_field: 'reporting_intensity',
		elevated_threshold: 1.5,
	};
	return config;
}

async function createEventFixture(args: {
	label: string;
	isoDate: string;
	regionKey: string;
	coords?: { lat: number; lng: number };
	reportingIntensity?: number;
	categoryRefs?: Array<Record<string, string>>;
	sensitivityLevel?: import('@mulder/core').SensitivityLevel;
}): Promise<string> {
	const attributes = {
		iso_date: args.isoDate,
		region_key: args.regionKey,
		region: args.regionKey,
		country: args.regionKey,
		reporting_intensity: args.reportingIntensity ?? 1,
		category_refs: args.categoryRefs ?? [],
	};
	const sensitivityLevel = args.sensitivityLevel ?? 'internal';
	const entity = await coreModule.createEntity(pool, {
		name: `Spec 115 ${args.label} ${randomUUID()}`,
		type: 'event',
		attributes,
		provenance: provenance(),
		sensitivityLevel,
		sensitivityMetadata: sensitivityMetadata(sensitivityLevel),
	});
	if (args.coords) {
		await pool.query('UPDATE entities SET geom = ST_SetSRID(ST_MakePoint($2, $1), 4326) WHERE id = $3;', [
			args.coords.lat,
			args.coords.lng,
			entity.id,
		]);
	}
	return entity.id;
}

async function seedSignificantAnomalyFixture(options?: {
	categoryRefs?: Array<Record<string, string>>;
}): Promise<string[]> {
	const categoryRefs = options?.categoryRefs ?? [SPEC_CATEGORY_ATTR_REF];
	for (let year = 2021; year <= 2023; year += 1) {
		for (let month = 1; month <= 12; month += 1) {
			await createEventFixture({
				label: `baseline-${year}-${month}`,
				isoDate: `${year}-${String(month).padStart(2, '0')}-12`,
				regionKey: 'alpha-zone',
				reportingIntensity: 1,
				categoryRefs,
			});
		}
	}
	for (let index = 0; index < 6; index += 1) {
		await createEventFixture({
			label: `control-${index}`,
			isoDate: `2024-${String(index + 1).padStart(2, '0')}-10`,
			regionKey: 'beta-zone',
			reportingIntensity: 1,
		});
	}

	const spikeIds: string[] = [];
	for (let index = 0; index < 12; index += 1) {
		spikeIds.push(
			await createEventFixture({
				label: `spike-${index}`,
				isoDate: `2024-01-${String(index + 1).padStart(2, '0')}`,
				regionKey: 'alpha-zone',
				reportingIntensity: 2,
				categoryRefs,
			}),
		);
	}
	return spikeIds;
}

async function seedSparseAnomalyFixture(): Promise<void> {
	for (let index = 0; index < 3; index += 1) {
		await createEventFixture({
			label: `sparse-${index}`,
			isoDate: `2024-02-${String(index + 1).padStart(2, '0')}`,
			regionKey: 'sparse-zone',
		});
	}
}

async function seedRecurringHotspotFixture(): Promise<string[]> {
	const ids: string[] = [];
	const windows = [
		{ year: 2020, latOffset: 0 },
		{ year: 2021, latOffset: 0.01 },
	];
	for (const window of windows) {
		for (let index = 0; index < 3; index += 1) {
			ids.push(
				await createEventFixture({
					label: `hotspot-${window.year}-${index}`,
					isoDate: `${window.year}-06-${String(index + 1).padStart(2, '0')}`,
					regionKey: 'hotspot-zone',
					coords: { lat: 52.5 + window.latOffset + index * 0.001, lng: 13.4 + index * 0.001 },
					categoryRefs: [SPEC_CATEGORY_ATTR_REF],
				}),
			);
		}
	}
	return ids;
}

async function rowCount(table: string): Promise<number> {
	const result = await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${table};`);
	return Number.parseInt(result.rows[0]?.count ?? '0', 10);
}

beforeAll(async () => {
	buildPackage(CORE_DIR);
	buildPackage(PIPELINE_DIR);
	buildPackage(CLI_DIR);
	coreModule = await import(pathToFileURL(CORE_DIST).href);
	pipelineModule = await import(pathToFileURL(PIPELINE_DIST).href);

	if (!pgAvailable) return;
	ensureSchema();
	pool = new pg.Pool(PG_CONFIG);
});

beforeEach(() => {
	if (!pgAvailable) return;
	cleanTables();
});

afterAll(async () => {
	if (pgAvailable) cleanTables();
	await pool?.end();
	await coreModule?.closeAllPools();
	if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

describe('Spec 115: Temporal Pattern Detection', () => {
	it('QA-01: Config exposes A12 internal pattern defaults', () => {
		const minimalConfig = coreModule.loadConfig(writeMinimalConfigWithoutTemporalPatterns()) as Record<string, unknown>;
		const exampleConfig = coreModule.loadConfig(EXAMPLE_CONFIG) as Record<string, unknown>;

		for (const config of [minimalConfig, exampleConfig]) {
			const temporal = config.temporal_pattern_detection as Record<string, unknown>;
			expect(temporal.enabled).toBe(true);
			expect(['manual', 'daily', 'weekly', 'monthly']).toContain(temporal.schedule);
			expect(temporal).not.toHaveProperty('external_sources');
			expect(temporal).not.toHaveProperty('source_plugins');

			const anomaly = temporal.anomaly_detection as Record<string, unknown>;
			expect(anomaly.enabled).toBe(true);
			expect(anomaly.min_entities).toBeGreaterThan(0);
			expect(anomaly.significance_threshold).toBeGreaterThan(0);
			expect(anomaly.significance_threshold).toBeLessThanOrEqual(1);
			expect(anomaly.baseline_window_years).toBeGreaterThan(0);
			expect(['day', 'week', 'month', 'year']).toContain(anomaly.granularity);
			expect(['country', 'admin1', 'hex_grid_100km']).toContain(anomaly.region_grid);
			expect(anomaly.max_regions).toBeGreaterThan(0);
			expect(anomaly.max_windows).toBeGreaterThan(0);
			expect(anomaly.window_size_buckets).toBeGreaterThan(0);
			expect(anomaly.known_patterns).toEqual([]);

			const hotspot = temporal.hotspot_clustering as Record<string, unknown>;
			expect(hotspot.enabled).toBe(true);
			expect(['dbscan', 'hdbscan']).toContain(hotspot.algorithm);
			expect(hotspot.min_cluster_size).toBeGreaterThan(0);
			expect(hotspot.radius_km).toBeGreaterThan(0);
			expect(['day', 'week', 'month', 'year']).toContain(hotspot.temporal_granularity);
			expect(hotspot.persistence_threshold_years).toBeGreaterThan(0);
			expect(hotspot.max_clusters).toBeGreaterThan(0);

			const reportingBias = temporal.reporting_bias as Record<string, unknown>;
			expect(reportingBias.correction_enabled).toBe(true);
			expect(reportingBias).toHaveProperty('correction_field');
			expect(reportingBias.elevated_threshold).toBeGreaterThan(1);
			expect(JSON.stringify(temporal).toLowerCase()).not.toMatch(/ufo|ufology|sighting|icd|naics|medical/);
		}
	});

	it.skipIf(!pgAvailable)('QA-02: Temporal pattern schema is constrained and queryable', async () => {
		const tables = await pool.query<{ table_name: string }>(
			[
				'SELECT table_name',
				'FROM information_schema.tables',
				"WHERE table_schema = 'public'",
				"  AND table_name IN ('temporal_anomaly_clusters', 'spatiotemporal_hotspot_clusters')",
				'ORDER BY table_name;',
			].join('\n'),
		);
		expect(tables.rows.map((row) => row.table_name)).toEqual([
			'spatiotemporal_hotspot_clusters',
			'temporal_anomaly_clusters',
		]);

		const columns = await pool.query<{ table_name: string; column_name: string; udt_name: string }>(
			[
				'SELECT table_name, column_name, udt_name',
				'FROM information_schema.columns',
				"WHERE table_schema = 'public'",
				"  AND table_name IN ('temporal_anomaly_clusters', 'spatiotemporal_hotspot_clusters')",
				'ORDER BY table_name, ordinal_position;',
			].join('\n'),
		);
		const columnsByTable = new Map<string, Set<string>>();
		for (const row of columns.rows) {
			columnsByTable.set(row.table_name, (columnsByTable.get(row.table_name) ?? new Set()).add(row.column_name));
		}
		expect([...(columnsByTable.get('temporal_anomaly_clusters') ?? [])]).toEqual(
			expect.arrayContaining([
				'region_key',
				'region_geojson',
				'time_start',
				'time_end',
				'entity_count',
				'baseline_rate',
				'observed_rate',
				'raw_significance',
				'comparison_count',
				'corrected_significance',
				'significance_threshold',
				'peak_date',
				'dominant_category_ref',
				'contributing_entity_ids',
				'bias_warning',
				'signal_strength',
				'caveats',
				'provenance',
				'sensitivity_level',
				'sensitivity_metadata',
				'deleted_at',
			]),
		);
		expect([...(columnsByTable.get('spatiotemporal_hotspot_clusters') ?? [])]).toEqual(
			expect.arrayContaining([
				'region_key',
				'centroid_lat',
				'centroid_lng',
				'radius_km',
				'time_start',
				'time_end',
				'entity_count',
				'density',
				'persistence',
				'recurrence_pattern',
				'related_cluster_ids',
				'contributing_entity_ids',
				'dominant_category_ref',
				'bias_warning',
				'signal_strength',
				'caveats',
				'provenance',
				'sensitivity_level',
				'sensitivity_metadata',
				'deleted_at',
			]),
		);
		expect(
			columns.rows.find(
				(row) => row.table_name === 'spatiotemporal_hotspot_clusters' && row.column_name === 'centroid_lat',
			)?.udt_name,
		).toBe('float8');
		expect(
			columns.rows.find(
				(row) => row.table_name === 'spatiotemporal_hotspot_clusters' && row.column_name === 'centroid_lng',
			)?.udt_name,
		).toBe('float8');

		const constraints = await pool.query<{ definition: string }>(
			[
				'SELECT pg_get_constraintdef(oid) AS definition',
				'FROM pg_constraint',
				"WHERE conrelid IN ('temporal_anomaly_clusters'::regclass, 'spatiotemporal_hotspot_clusters'::regclass)",
				'ORDER BY conname;',
			].join('\n'),
		);
		const constraintDefs = constraints.rows.map((row) => row.definition).join('\n');
		expect(constraintDefs).toContain("signal_strength = 'weak'");
		expect(constraintDefs).toContain('corrected_significance');
		expect(constraintDefs).toContain('comparison_count > 0');
		expect(constraintDefs).toContain('time_end > time_start');
		expect(constraintDefs).toContain('array_length(contributing_entity_ids');
		expect(constraintDefs).toContain('sensitivity_level');
		expect(constraintDefs).toContain('sensitivity_metadata');
		expect(constraintDefs).toContain('review_status');
		expect(constraintDefs).toContain('persistence');
		expect(constraintDefs).toContain('centroid_lat');
		expect(constraintDefs).toContain('centroid_lng');

		const indexes = await pool.query<{ indexname: string; indexdef: string }>(
			[
				'SELECT indexname, indexdef',
				'FROM pg_indexes',
				"WHERE schemaname = 'public'",
				"  AND tablename IN ('temporal_anomaly_clusters', 'spatiotemporal_hotspot_clusters')",
				'ORDER BY indexname;',
			].join('\n'),
		);
		const indexDefs = indexes.rows.map((row) => `${row.indexname} ${row.indexdef}`).join('\n');
		expect(indexDefs).toContain('UNIQUE INDEX');
		expect(indexDefs).toContain('region_key');
		expect(indexDefs).toContain('time_start');
		expect(indexDefs).toContain('contributing_entity_ids');
		expect(indexDefs).toContain('sensitivity_level');
		expect(indexDefs).toContain('review_status');
		expect(indexDefs).toContain('centroid_lat');
		expect(indexDefs).toContain('centroid_lng');
		expect(indexDefs).toContain('related_cluster_ids');
	});

	it.skipIf(!pgAvailable)('QA-03: Anomaly detection applies Bonferroni correction', async () => {
		const spikeIds = await seedSignificantAnomalyFixture();
		const config = tunedTemporalConfig({ hotspots: false });

		const result = await pipelineModule.detectTemporalPatterns(pool, config);
		const anomalies = await coreModule.listTemporalAnomalyClusters(pool);

		expect(result.status).toBe('success');
		expect(anomalies).toHaveLength(1);
		const anomaly = anomalies[0];
		expect(anomaly.regionKey).toBe('alpha-zone');
		expect(anomaly.entityCount).toBeGreaterThanOrEqual(5);
		expect(anomaly.observedRate).toBeGreaterThan(anomaly.baselineRate);
		expect(anomaly.rawSignificance).toBeGreaterThanOrEqual(0);
		expect(anomaly.rawSignificance).toBeLessThanOrEqual(1);
		expect(anomaly.comparisonCount).toBeGreaterThan(1);
		expect(anomaly.correctedSignificance).toBeCloseTo(
			Math.min(1, anomaly.rawSignificance * anomaly.comparisonCount),
			8,
		);
		expect(anomaly.correctedSignificance).toBeLessThanOrEqual(anomaly.significanceThreshold);
		expect(anomaly.significanceThreshold).toBe(0.05);
		expect(anomaly.peakDate).toBeInstanceOf(Date);
		expect(anomaly.contributingEntityIds).toEqual(expect.arrayContaining(spikeIds));
		expect(anomaly.signalStrength).toBe('weak');
		expect(anomaly.caveats.join(' ')).toMatch(/hypothesis starters|not causal evidence/i);
		expect(result.data.anomalyComparisonCount).toBe(anomaly.comparisonCount);
		expect(result.data.persistedAnomalyCount).toBe(1);
		expect(await rowCount('temporal_anomaly_clusters')).toBe(1);
	});

	it.skipIf(!pgAvailable)('QA-04: Non-significant or sparse windows do not persist anomalies', async () => {
		await seedSparseAnomalyFixture();
		const config = tunedTemporalConfig({ hotspots: false, minEntities: 5 });

		const result = await pipelineModule.detectTemporalPatterns(pool, config);
		const anomalies = await coreModule.listTemporalAnomalyClusters(pool);

		expect(result.status).toBe('success');
		expect(result.data.anomalyComparisonCount).toBeLessThanOrEqual(
			config.temporal_pattern_detection.anomaly_detection.max_regions *
				config.temporal_pattern_detection.anomaly_detection.max_windows,
		);
		expect(result.data.anomalyCount).toBe(0);
		expect(result.data.persistedAnomalyCount).toBe(0);
		expect(result.snapshot.anomalies).toHaveLength(0);
		expect(anomalies).toHaveLength(0);
		expect(await rowCount('temporal_anomaly_clusters')).toBe(0);
	});

	it.skipIf(!pgAvailable)('QA-05: Hotspot clustering records density and persistence', async () => {
		const eventIds = await seedRecurringHotspotFixture();
		const config = tunedTemporalConfig({
			anomalies: false,
			minClusterSize: 3,
			radiusKm: 20,
			persistenceThresholdYears: 2,
		});

		const result = await pipelineModule.detectTemporalPatterns(pool, config);
		const hotspots = await coreModule.listSpatiotemporalHotspotClusters(pool);

		expect(result.status).toBe('success');
		expect(hotspots.length).toBeGreaterThan(0);
		const hotspot = hotspots[0];
		expect(hotspot.regionKey).toEqual(expect.any(String));
		expect(hotspot.regionKey.length).toBeGreaterThan(0);
		expect(hotspot.centroidLat).toEqual(expect.any(Number));
		expect(hotspot.centroidLng).toEqual(expect.any(Number));
		expect(hotspot.radiusKm).toBeGreaterThan(0);
		expect(hotspot.density).toBeGreaterThan(0);
		expect(['recurring', 'permanent']).toContain(hotspot.persistence);
		expect(hotspot.recurrencePattern).toEqual(expect.any(String));
		expect(hotspot.contributingEntityIds.length).toBeGreaterThanOrEqual(3);
		expect(hotspots.flatMap((cluster) => cluster.contributingEntityIds)).toEqual(expect.arrayContaining(eventIds));
		expect(hotspot.relatedClusterIds).toEqual(expect.any(Array));
		expect(hotspot.signalStrength).toBe('weak');
		expect(hotspot.caveats.join(' ')).toMatch(/hypothesis starters|not causal evidence/i);
		expect(result.data.persistedHotspotCount).toBe(hotspots.length);
		expect(await rowCount('spatiotemporal_hotspot_clusters')).toBe(hotspots.length);
	});

	it.skipIf(!pgAvailable)('QA-06: Sensitivity filtering hides over-sensitive patterns', async () => {
		const restrictedEntityId = await createEventFixture({
			label: 'restricted',
			isoDate: '2024-03-01',
			regionKey: 'restricted-zone',
			sensitivityLevel: 'restricted',
		});
		const anomalyId = randomUUID();
		const hotspotId = randomUUID();

		await coreModule.replaceTemporalPatternSnapshot(pool, {
			anomalies: [
				{
					id: anomalyId,
					regionKey: 'restricted-zone',
					timeStart: new Date('2024-03-01T00:00:00Z'),
					timeEnd: new Date('2024-04-01T00:00:00Z'),
					entityCount: 5,
					baselineRate: 1,
					observedRate: 5,
					rawSignificance: 0.01,
					comparisonCount: 3,
					correctedSignificance: 0.03,
					significanceThreshold: 0.05,
					peakDate: new Date('2024-03-15T00:00:00Z'),
					regionGeojson: { type: 'FeatureCollection', features: [] },
					dominantCategoryRef: SPEC_CATEGORY_REF,
					contributingEntityIds: [restrictedEntityId],
					caveats: [GENERIC_CAVEAT],
					provenance: provenance([restrictedEntityId]),
					sensitivityLevel: 'restricted',
					sensitivityMetadata: sensitivityMetadata('restricted'),
				},
			],
			hotspots: [
				{
					id: hotspotId,
					regionKey: 'restricted-zone',
					centroidLat: 52.5,
					centroidLng: 13.4,
					radiusKm: 10,
					timeStart: new Date('2024-03-01T00:00:00Z'),
					timeEnd: new Date('2024-04-01T00:00:00Z'),
					entityCount: 5,
					density: 0.4,
					persistence: 'transient',
					dominantCategoryRef: SPEC_CATEGORY_REF,
					contributingEntityIds: [restrictedEntityId],
					caveats: [GENERIC_CAVEAT],
					provenance: provenance([restrictedEntityId]),
					sensitivityLevel: 'restricted',
					sensitivityMetadata: sensitivityMetadata('restricted'),
				},
			],
		});

		expect(await coreModule.listTemporalAnomalyClusters(pool, { maxSensitivityLevel: 'internal' })).toHaveLength(0);
		expect(await coreModule.listSpatiotemporalHotspotClusters(pool, { maxSensitivityLevel: 'internal' })).toHaveLength(
			0,
		);
		expect(
			await coreModule.findTemporalAnomalyCluster(pool, anomalyId, { maxSensitivityLevel: 'internal' }),
		).toBeNull();
		expect(
			await coreModule.findSpatiotemporalHotspotCluster(pool, hotspotId, { maxSensitivityLevel: 'internal' }),
		).toBeNull();

		const adminAnomalies = await coreModule.listTemporalAnomalyClusters(pool, { maxSensitivityLevel: 'confidential' });
		const adminHotspots = await coreModule.listSpatiotemporalHotspotClusters(pool, {
			maxSensitivityLevel: 'confidential',
		});
		expect(adminAnomalies.map((anomaly) => anomaly.id)).toContain(anomalyId);
		expect(adminHotspots.map((hotspot) => hotspot.id)).toContain(hotspotId);
		expect(
			await coreModule.findTemporalAnomalyCluster(pool, anomalyId, { maxSensitivityLevel: 'confidential' }),
		).not.toBeNull();
		expect(
			await coreModule.findSpatiotemporalHotspotCluster(pool, hotspotId, { maxSensitivityLevel: 'confidential' }),
		).not.toBeNull();
	});

	it.skipIf(!pgAvailable)('QA-07: Categoryless snapshots persist SQL NULL category refs', async () => {
		const entityId = await createEventFixture({
			label: 'categoryless-snapshot',
			isoDate: '2024-03-01',
			regionKey: 'categoryless-zone',
		});
		const anomalyId = randomUUID();
		const hotspotId = randomUUID();

		const snapshot = await coreModule.replaceTemporalPatternSnapshot(pool, {
			anomalies: [
				{
					id: anomalyId,
					regionKey: 'categoryless-zone',
					timeStart: new Date('2024-03-01T00:00:00Z'),
					timeEnd: new Date('2024-04-01T00:00:00Z'),
					entityCount: 5,
					baselineRate: 1,
					observedRate: 5,
					rawSignificance: 0.01,
					comparisonCount: 3,
					correctedSignificance: 0.03,
					significanceThreshold: 0.05,
					peakDate: new Date('2024-03-15T00:00:00Z'),
					regionGeojson: { type: 'FeatureCollection', features: [] },
					contributingEntityIds: [entityId],
					caveats: [GENERIC_CAVEAT],
					provenance: provenance([entityId]),
					sensitivityLevel: 'internal',
					sensitivityMetadata: sensitivityMetadata('internal'),
				},
			],
			hotspots: [
				{
					id: hotspotId,
					regionKey: 'categoryless-zone',
					centroidLat: 52.5,
					centroidLng: 13.4,
					radiusKm: 10,
					timeStart: new Date('2024-03-01T00:00:00Z'),
					timeEnd: new Date('2024-04-01T00:00:00Z'),
					entityCount: 5,
					density: 0.4,
					persistence: 'transient',
					dominantCategoryRef: null,
					contributingEntityIds: [entityId],
					caveats: [GENERIC_CAVEAT],
					provenance: provenance([entityId]),
					sensitivityLevel: 'internal',
					sensitivityMetadata: sensitivityMetadata('internal'),
				},
			],
		});

		expect(snapshot.anomalies[0].dominantCategoryRef).toBeNull();
		expect(snapshot.hotspots[0].dominantCategoryRef).toBeNull();
		expect((await coreModule.findTemporalAnomalyCluster(pool, anomalyId))?.dominantCategoryRef).toBeNull();
		expect((await coreModule.findSpatiotemporalHotspotCluster(pool, hotspotId))?.dominantCategoryRef).toBeNull();

		const anomalyCategory = await pool.query<{ dominant_category_ref: unknown }>(
			'SELECT dominant_category_ref FROM temporal_anomaly_clusters WHERE id = $1;',
			[anomalyId],
		);
		const hotspotCategory = await pool.query<{ dominant_category_ref: unknown }>(
			'SELECT dominant_category_ref FROM spatiotemporal_hotspot_clusters WHERE id = $1;',
			[hotspotId],
		);
		expect(anomalyCategory.rows[0]?.dominant_category_ref).toBeNull();
		expect(hotspotCategory.rows[0]?.dominant_category_ref).toBeNull();
	});

	it.skipIf(!pgAvailable)('QA-08: Category-constrained known patterns do not annotate categoryless anomalies', async () => {
		await seedSignificantAnomalyFixture({ categoryRefs: [] });
		const config = tunedTemporalConfig({ hotspots: false });
		config.temporal_pattern_detection.anomaly_detection.known_patterns = [
			{
				id: 'spec115-category-constrained',
				region_key: 'alpha-zone',
				category_ref: {
					taxonomy_id: SPEC_CATEGORY_REF.taxonomyId,
					category_id: SPEC_CATEGORY_REF.categoryId,
				},
				time_start: '2024-01-01',
				time_end: '2024-02-01',
			},
		];

		const result = await pipelineModule.detectTemporalPatterns(pool, config);
		const anomalies = await coreModule.listTemporalAnomalyClusters(pool);

		expect(result.status).toBe('success');
		expect(anomalies).toHaveLength(1);
		expect(anomalies[0].dominantCategoryRef).toBeNull();
		expect(anomalies[0].knownPatternMatch).toBeNull();
		expect(result.snapshot.anomalies[0]?.knownPatternMatch).toBeNull();
	});

	it.skipIf(!pgAvailable)('QA-09: Bias warnings and dominant category metadata are preserved', async () => {
		await seedSignificantAnomalyFixture();
		const config = tunedTemporalConfig({ hotspots: false });

		await pipelineModule.detectTemporalPatterns(pool, config);
		const anomalies = await coreModule.listTemporalAnomalyClusters(pool);

		expect(anomalies).toHaveLength(1);
		const anomaly = anomalies[0];
		expect(anomaly.biasWarning).toEqual(expect.any(String));
		expect(anomaly.biasWarning?.toLowerCase()).toContain('reporting');
		expect(anomaly.caveats).toContain(GENERIC_CAVEAT);
		expect(anomaly.dominantCategoryRef).toMatchObject(SPEC_CATEGORY_REF);
		expect(
			JSON.stringify({ biasWarning: anomaly.biasWarning, category: anomaly.dominantCategoryRef }).toLowerCase(),
		).not.toMatch(/ufo|ufology|sighting|icd|naics|medical/);
	});
});
