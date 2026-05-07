import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as db from '../lib/db.js';
import { ensureSchema, MULDER_TEST_TABLES, truncateExistingTables } from '../lib/schema.js';

const ROOT = resolve(import.meta.dirname, '../..');
const CORE_DIST = resolve(ROOT, 'packages/core/dist/index.js');
const PIPELINE_DIST = resolve(ROOT, 'packages/pipeline/dist/index.js');
const EXAMPLE_CONFIG = resolve(ROOT, 'mulder.config.example.yaml');
const TEST_LANES = resolve(ROOT, 'scripts/test-lanes.mjs');
const CORRELATION_CAVEAT = 'Correlation ≠ Causation';
const PG_CONFIG = {
	host: db.TEST_PG_HOST,
	port: db.TEST_PG_PORT,
	database: db.TEST_PG_DATABASE,
	user: db.TEST_PG_USER,
	password: db.TEST_PG_PASSWORD,
};

let coreModule: typeof import('@mulder/core');
let pipelineModule: typeof import('@mulder/pipeline');
let pool: pg.Pool;
const pgAvailable = db.isPgAvailable();

function cleanTables(): void {
	truncateExistingTables(MULDER_TEST_TABLES);
}

function cloneConfig(): import('@mulder/core').MulderConfig {
	return structuredClone(coreModule.loadConfig(EXAMPLE_CONFIG)) as import('@mulder/core').MulderConfig;
}

function sensitivityMetadata(level: import('@mulder/core').SensitivityLevel) {
	return {
		level,
		reason: 'spec116_fixture',
		assignedBy: 'policy_rule' as const,
		assignedAt: '2026-05-07T00:00:00.000Z',
		piiTypes: [],
		declassifyDate: null,
	};
}

function provenance(sourceDocumentIds: string[] = [randomUUID()]) {
	return {
		sourceDocumentIds,
		extractionPipelineRun: `spec116-run-${randomUUID()}`,
		createdAt: '2026-05-07T00:00:00.000Z',
	};
}

async function createEventFixture(args: {
	label: string;
	isoDate: string;
	regionKey?: string;
	sensitivityLevel?: import('@mulder/core').SensitivityLevel;
}): Promise<string> {
	const sensitivityLevel = args.sensitivityLevel ?? 'internal';
	const entity = await coreModule.createEntity(pool, {
		name: `Spec 116 ${args.label} ${randomUUID()}`,
		type: 'event',
		attributes: {
			iso_date: args.isoDate,
			region_key: args.regionKey ?? 'spec116-zone',
			region: args.regionKey ?? 'spec116-zone',
			country: args.regionKey ?? 'spec116-zone',
		},
		provenance: provenance(),
		sensitivityLevel,
		sensitivityMetadata: sensitivityMetadata(sensitivityLevel),
	});
	return entity.id;
}

async function seedDailyCounts(options?: {
	regionKey?: string;
	sensitivityLevel?: import('@mulder/core').SensitivityLevel;
}): Promise<string[]> {
	const ids: string[] = [];
	const counts = [1, 2, 3, 4];
	for (let dayIndex = 0; dayIndex < counts.length; dayIndex += 1) {
		for (let item = 0; item < counts[dayIndex]; item += 1) {
			ids.push(
				await createEventFixture({
					label: `daily-${dayIndex}-${item}`,
					isoDate: `2026-01-${String(dayIndex + 1).padStart(2, '0')}`,
					regionKey: options?.regionKey,
					sensitivityLevel: options?.sensitivityLevel,
				}),
			);
		}
	}
	return ids;
}

function externalCorrelationConfig(): import('@mulder/core').MulderConfig {
	const config = cloneConfig();
	config.temporal_pattern_detection.enabled = true;
	config.temporal_pattern_detection.anomaly_detection.enabled = false;
	config.temporal_pattern_detection.hotspot_clustering.enabled = false;
	config.temporal_pattern_detection.external_correlation = {
		enabled: true,
		series: [
			{
				source_id: 'spec116-source',
				series_id: 'same-day',
				plugin_id: 'spec116-plugin',
				enabled: true,
				region_key: 'spec116-zone',
				time_start: '2026-01-01',
				time_end: '2026-01-08',
				filters: {},
			},
			{
				source_id: 'spec116-source',
				series_id: 'lagged',
				plugin_id: 'spec116-plugin',
				enabled: true,
				region_key: 'spec116-zone',
				time_start: '2026-01-01',
				time_end: '2026-01-08',
				filters: {},
			},
		],
		methods: ['spearman', 'cross_correlation'],
		min_data_points: 4,
		max_lag_days: 2,
		always_include_caveat: true,
	};
	return config;
}

function externalCorrelationInput(
	entityId: string,
	overrides?: Partial<import('@mulder/core').CreateExternalCorrelationInput>,
): import('@mulder/core').CreateExternalCorrelationInput {
	return {
		internalSeriesKey: 'entities:region=spec116-zone:category=all',
		externalSourceId: 'spec116-source',
		externalSeriesId: 'preserved-series',
		method: 'spearman',
		coefficient: 0.7,
		pValue: 0.04,
		lagDays: 0,
		timeStart: new Date('2026-02-01T00:00:00Z'),
		timeEnd: new Date('2026-02-02T00:00:00Z'),
		dataPointCount: 1,
		contributingEntityIds: [entityId],
		provenance: provenance([entityId]),
		sensitivityLevel: 'internal',
		sensitivityMetadata: sensitivityMetadata('internal'),
		...overrides,
	};
}

beforeAll(async () => {
	coreModule = await import(CORE_DIST);
	pipelineModule = await import(PIPELINE_DIST);
	if (!pgAvailable) return;
	ensureSchema();
	pool = new pg.Pool(PG_CONFIG);
});

beforeEach(() => {
	pipelineModule?.clearExternalDataSourcePlugins();
	if (!pgAvailable) return;
	cleanTables();
});

afterAll(async () => {
	pipelineModule?.clearExternalDataSourcePlugins();
	if (pgAvailable) cleanTables();
	await pool?.end();
	await coreModule?.closeAllPools();
});

describe('Spec 116: External Correlation Plugins', () => {
	it('QA-01: default/example config exposes safe external correlation defaults', () => {
		const config = coreModule.loadConfig(EXAMPLE_CONFIG);
		expect(config.temporal_pattern_detection.external_correlation).toEqual({
			enabled: true,
			series: [],
			methods: ['spearman', 'cross_correlation'],
			min_data_points: 30,
			max_lag_days: 90,
			always_include_caveat: true,
		});
	});

	it.skipIf(!pgAvailable)('QA-02: external correlation schema is constrained and queryable', async () => {
		const tables = await pool.query<{ table_name: string }>(
			[
				'SELECT table_name',
				'FROM information_schema.tables',
				"WHERE table_schema = 'public'",
				"  AND table_name = 'external_correlations';",
			].join('\n'),
		);
		expect(tables.rows.map((row) => row.table_name)).toEqual(['external_correlations']);

		const columns = await pool.query<{ column_name: string }>(
			[
				'SELECT column_name',
				'FROM information_schema.columns',
				"WHERE table_schema = 'public'",
				"  AND table_name = 'external_correlations'",
				'ORDER BY ordinal_position;',
			].join('\n'),
		);
		expect(columns.rows.map((row) => row.column_name)).toEqual(
			expect.arrayContaining([
				'internal_series_key',
				'external_source_id',
				'external_series_id',
				'method',
				'coefficient',
				'p_value',
				'lag_days',
				'time_start',
				'time_end',
				'interpretation_caveat',
				'caveats',
				'review_status',
				'signal_strength',
				'provenance',
				'sensitivity_level',
				'sensitivity_metadata',
				'deleted_at',
			]),
		);

		const constraints = await pool.query<{ definition: string }>(
			[
				'SELECT pg_get_constraintdef(oid) AS definition',
				'FROM pg_constraint',
				"WHERE conrelid = 'external_correlations'::regclass",
				'ORDER BY conname;',
			].join('\n'),
		);
		const constraintDefs = constraints.rows.map((row) => row.definition).join('\n');
		expect(constraintDefs).toContain("'spearman'");
		expect(constraintDefs).toContain("'cross_correlation'");
		expect(constraintDefs).toContain(CORRELATION_CAVEAT);
		expect(constraintDefs).toContain("signal_strength = 'weak'");
		expect(constraintDefs).toContain('review_status');
		expect(constraintDefs).toContain('provenance');
		expect(constraintDefs).toContain('sensitivity_level');
		expect(constraintDefs).toContain('sensitivity_metadata');
		expect(constraintDefs).toContain('time_end > time_start');

		const indexes = await pool.query<{ indexname: string; indexdef: string }>(
			[
				'SELECT indexname, indexdef',
				'FROM pg_indexes',
				"WHERE schemaname = 'public'",
				"  AND tablename = 'external_correlations'",
				'ORDER BY indexname;',
			].join('\n'),
		);
		const indexDefs = indexes.rows.map((row) => `${row.indexname} ${row.indexdef}`).join('\n');
		expect(indexDefs).toContain('UNIQUE INDEX');
		expect(indexDefs).toContain('external_source_id');
		expect(indexDefs).toContain('external_series_id');
		expect(indexDefs).toContain('internal_series_key');
		expect(indexDefs).toContain('time_start');
		expect(indexDefs).toContain('method');
		expect(indexDefs).toContain('review_status');
		expect(indexDefs).toContain('sensitivity_level');
		expect(indexDefs).toContain('provenance');
	});

	it('QA-03: static external plugins register and fetch by generic plugin id', async () => {
		const registry = new pipelineModule.ExternalDataSourceRegistry();
		registry.register(
			pipelineModule.createStaticExternalDataSourcePlugin({
				id: 'spec116-static',
				series: {
					observations: [
						{ date: '2026-01-01', value: 1 },
						{ date: '2026-01-02', value: 2 },
					],
				},
			}),
		);

		const originalFetch = globalThis.fetch;
		globalThis.fetch = (() => {
			throw new Error('Spec 116 tests must not use live network fetch.');
		}) as typeof fetch;
		try {
			const plugin = registry.get('spec116-static');
			expect(plugin?.kind).toBe('time_series');
			const fetched = await plugin?.fetch({
				sourceId: 'configured-source',
				seriesId: 'observations',
				series: {
					source_id: 'configured-source',
					series_id: 'observations',
					plugin_id: 'spec116-static',
					enabled: true,
					filters: {},
				},
			});
			expect(fetched?.points.map((point) => point.value)).toEqual([1, 2]);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it.skipIf(!pgAvailable)('QA-04: Spearman and cross-correlation persist bounded lagged results', async () => {
		await seedDailyCounts();
		const fetchRequests: string[] = [];
		pipelineModule.registerExternalDataSourcePlugin({
			id: 'spec116-plugin',
			kind: 'time_series',
			updateFrequency: 'static',
			fetch(request) {
				fetchRequests.push(`${request.sourceId}/${request.seriesId}`);
				const points =
					request.seriesId === 'lagged'
						? [
								{ date: '2026-01-03', value: 1 },
								{ date: '2026-01-04', value: 2 },
								{ date: '2026-01-05', value: 3 },
								{ date: '2026-01-06', value: 4 },
							]
						: [
								{ date: '2026-01-01', value: 1 },
								{ date: '2026-01-02', value: 2 },
								{ date: '2026-01-03', value: 3 },
								{ date: '2026-01-04', value: 4 },
							];
				return { points };
			},
		});

		const originalFetch = globalThis.fetch;
		globalThis.fetch = (() => {
			throw new Error('Spec 116 analysis must not use live network fetch.');
		}) as typeof fetch;
		try {
			const result = await pipelineModule.detectTemporalPatterns(pool, externalCorrelationConfig());
			const persisted = await coreModule.listExternalCorrelations(pool);
			const spearman = persisted.find(
				(correlation) => correlation.method === 'spearman' && correlation.externalSeriesId === 'same-day',
			);
			const lagged = persisted.find(
				(correlation) => correlation.method === 'cross_correlation' && correlation.externalSeriesId === 'lagged',
			);

			expect(result.status).toBe('success');
			expect(fetchRequests.sort()).toEqual(['spec116-source/lagged', 'spec116-source/same-day']);
			expect(result.data.externalCorrelationCount).toBeGreaterThanOrEqual(2);
			expect(result.data.persistedExternalCorrelationCount).toBe(persisted.length);
			expect(spearman?.coefficient).toBeCloseTo(1, 8);
			expect(spearman?.pValue).toBeGreaterThanOrEqual(0);
			expect(spearman?.pValue).toBeLessThanOrEqual(1);
			expect(spearman?.lagDays).toBe(0);
			expect(spearman?.dataPointCount).toBe(4);
			expect(lagged?.coefficient).toBeCloseTo(1, 8);
			expect(lagged?.lagDays).toBe(2);
			expect(lagged?.dataPointCount).toBe(4);
			expect(lagged?.timeStart.toISOString()).toBe('2026-01-01T00:00:00.000Z');
			expect(lagged?.timeEnd.toISOString()).toBe('2026-01-05T00:00:00.000Z');
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it.skipIf(!pgAvailable)('QA-05: weak-signal caveat and review state are mandatory', async () => {
		const entityId = await createEventFixture({ label: 'caveat', isoDate: '2026-02-01' });
		const snapshot = await coreModule.replaceExternalCorrelationSnapshot(pool, {
			correlations: [externalCorrelationInput(entityId, { externalSeriesId: 'caveat-series' })],
		});
		const stored = await coreModule.findExternalCorrelation(pool, snapshot.correlations[0].id);

		expect(stored?.signalStrength).toBe('weak');
		expect(stored?.reviewStatus).toBe('pending');
		expect(stored?.interpretationCaveat).toBe(CORRELATION_CAVEAT);
		expect(stored?.caveats).toContain(CORRELATION_CAVEAT);
	});

	it.skipIf(!pgAvailable)(
		'QA-06: external snapshot remains active when no external correlation run occurs',
		async () => {
			const entityId = await createEventFixture({ label: 'preserve', isoDate: '2026-02-01' });
			const initial = await coreModule.replaceExternalCorrelationSnapshot(pool, {
				correlations: [externalCorrelationInput(entityId)],
			});
			const correlationId = initial.correlations[0].id;

			const scenarios: Array<{
				name: string;
				configure(config: import('@mulder/core').MulderConfig): void;
			}> = [
				{
					name: 'disabled',
					configure(config) {
						config.temporal_pattern_detection.external_correlation.enabled = false;
					},
				},
				{
					name: 'empty',
					configure(config) {
						config.temporal_pattern_detection.external_correlation.enabled = true;
						config.temporal_pattern_detection.external_correlation.series = [];
					},
				},
				{
					name: 'missing-plugin',
					configure(config) {
						config.temporal_pattern_detection.external_correlation = {
							...externalCorrelationConfig().temporal_pattern_detection.external_correlation,
							series: [
								{
									source_id: 'spec116-source',
									series_id: 'missing',
									plugin_id: 'spec116-missing-plugin',
									enabled: true,
									region_key: 'spec116-zone',
									time_start: '2026-02-01',
									time_end: '2026-02-02',
									filters: {},
								},
							],
						};
					},
				},
			];

			for (const scenario of scenarios) {
				const config = cloneConfig();
				config.temporal_pattern_detection.enabled = true;
				config.temporal_pattern_detection.anomaly_detection.enabled = false;
				config.temporal_pattern_detection.hotspot_clustering.enabled = false;
				scenario.configure(config);

				const result = await pipelineModule.detectTemporalPatterns(pool, config);
				const active = await coreModule.listExternalCorrelations(pool);

				expect(result.status, scenario.name).toBe('success');
				expect(result.data.persistedExternalCorrelationCount, scenario.name).toBe(0);
				expect(
					active.map((correlation) => correlation.id),
					scenario.name,
				).toContain(correlationId);
			}
		},
	);

	it.skipIf(!pgAvailable)('QA-07: external correlation recompute preserves non-pending review status', async () => {
		const entityId = await createEventFixture({ label: 'review-preserve', isoDate: '2026-02-01' });
		const correlationId = randomUUID();
		await coreModule.replaceExternalCorrelationSnapshot(pool, {
			correlations: [externalCorrelationInput(entityId, { id: correlationId, reviewStatus: 'approved' })],
		});

		const recomputed = await coreModule.replaceExternalCorrelationSnapshot(pool, {
			correlations: [externalCorrelationInput(entityId, { id: correlationId, coefficient: 0.65, pValue: 0.08 })],
		});
		const stored = await coreModule.findExternalCorrelation(pool, correlationId);

		expect(recomputed.correlations[0].reviewStatus).toBe('approved');
		expect(stored?.reviewStatus).toBe('approved');
		expect(stored?.coefficient).toBeCloseTo(0.65, 8);
	});

	it.skipIf(!pgAvailable)('QA-08: sensitivity filtering hides over-sensitive correlations', async () => {
		const restrictedEntityIds = await seedDailyCounts({ regionKey: 'restricted-zone', sensitivityLevel: 'restricted' });
		const snapshot = await coreModule.replaceExternalCorrelationSnapshot(pool, {
			correlations: [
				{
					internalSeriesKey: 'entities:region=restricted-zone:category=all',
					externalSourceId: 'spec116-source',
					externalSeriesId: 'restricted-series',
					method: 'cross_correlation',
					coefficient: 0.9,
					pValue: 0.01,
					lagDays: 1,
					timeStart: new Date('2026-01-01T00:00:00Z'),
					timeEnd: new Date('2026-01-05T00:00:00Z'),
					dataPointCount: 4,
					contributingEntityIds: restrictedEntityIds,
					provenance: provenance(restrictedEntityIds),
					sensitivityLevel: 'restricted',
					sensitivityMetadata: sensitivityMetadata('restricted'),
				},
			],
		});
		const correlationId = snapshot.correlations[0].id;

		expect(await coreModule.listExternalCorrelations(pool, { maxSensitivityLevel: 'internal' })).toHaveLength(0);
		expect(
			await coreModule.findExternalCorrelation(pool, correlationId, { maxSensitivityLevel: 'internal' }),
		).toBeNull();

		const adminVisible = await coreModule.listExternalCorrelations(pool, { maxSensitivityLevel: 'confidential' });
		expect(adminVisible.map((correlation) => correlation.id)).toContain(correlationId);
		expect(
			await coreModule.findExternalCorrelation(pool, correlationId, { maxSensitivityLevel: 'confidential' }),
		).not.toBeNull();
	});

	it('QA-09: affected-test mapping stays scoped for N4 files', () => {
		const result = spawnSync(
			process.execPath,
			[
				TEST_LANES,
				'affected-plan',
				'--changed-file',
				'packages/core/src/database/migrations/047_external_correlations.sql',
				'--changed-file',
				'packages/pipeline/src/analyze/external-correlation.ts',
				'--json',
			],
			{ cwd: ROOT, encoding: 'utf-8', timeout: 30_000 },
		);
		expect(result.status).toBe(0);
		const plan = JSON.parse(result.stdout) as { files: { relativePath: string }[] };
		const selectedFiles = plan.files.map((file) => file.relativePath);
		expect(selectedFiles).toContain('tests/specs/116_external_correlation_plugins.test.ts');
		expect(selectedFiles).not.toContain('tests/specs/44_e2e_pipeline_integration.test.ts');
	});
});
