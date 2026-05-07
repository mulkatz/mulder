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

function writeMinimalConfigWithoutSimilarity(): string {
	if (!tempDir) tempDir = mkdtempSync(join(tmpdir(), 'mulder-spec113-'));
	const configPath = join(tempDir, `minimal-${randomUUID()}.yaml`);
	writeFileSync(
		configPath,
		[
			'project:',
			'  name: "spec113"',
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
			'    - name: "case"',
			'      description: "Generic case entity"',
			'  relationships: []',
			'',
		].join('\n'),
		'utf-8',
	);
	return configPath;
}

function cleanTables(): void {
	truncateExistingTables(['review_events', 'review_artifacts', ...MULDER_TEST_TABLES]);
}

function sensitivityMetadata(level: import('@mulder/core').SensitivityLevel) {
	return {
		level,
		reason: 'spec113_fixture',
		assignedBy: 'policy_rule' as const,
		assignedAt: '2026-05-07T00:00:00.000Z',
		piiTypes: [],
		declassifyDate: null,
	};
}

function coreScores(overrides: Partial<import('@mulder/core').CoreSimilarityDimensions> = {}) {
	return {
		semantic: { status: 'scored' as const, score: 0.91, reason: null },
		structural: { status: 'scored' as const, score: 0.82, reason: null },
		geospatial: { status: 'scored' as const, score: 0.73, reason: null },
		temporal: { status: 'scored' as const, score: 0.64, reason: null },
		...overrides,
	};
}

function domainScore(id = 'configured_attribute_match'): import('@mulder/core').DomainSimilarityDimension {
	return {
		id,
		label: 'Configured attribute match',
		source: 'attribute_comparison',
		configRef: 'similar_case_discovery.scoring.domain_dimensions[0]',
		score: 0.88,
		status: 'scored',
		reason: null,
		metadata: { attribute: 'category' },
	};
}

async function createEntityFixture(label: string, overrides: Partial<import('@mulder/core').CreateEntityInput> = {}) {
	return coreModule.createEntity(pool, {
		name: `${label} ${randomUUID()}`,
		type: 'case',
		attributes: {},
		sensitivityLevel: 'internal',
		sensitivityMetadata: sensitivityMetadata('internal'),
		...overrides,
	});
}

async function createSourceFixture(label: string): Promise<string> {
	const source = await coreModule.createSource(pool, {
		filename: `${label}.txt`,
		storagePath: `gs://spec113/${label}-${randomUUID()}.txt`,
		fileHash: `spec113-${label}-${randomUUID()}`,
		sourceType: 'text',
	});
	return source.id;
}

async function setEntityGeometry(entityId: string, latitude: number, longitude: number): Promise<void> {
	await pool.query('UPDATE entities SET geom = ST_SetSRID(ST_MakePoint($2, $1), 4326) WHERE id = $3;', [
		latitude,
		longitude,
		entityId,
	]);
}

async function upsertSimilarity(
	sourceEntityId: string,
	targetEntityId: string,
	overrides: Partial<import('@mulder/core').UpsertSimilarityResultInput> = {},
) {
	return coreModule.upsertSimilarityResult(pool, {
		sourceEntityId,
		targetEntityId,
		core: coreScores(),
		domain: [domainScore()],
		explanation: 'Deterministic similarity explanation',
		sharedEntityIds: [],
		keyDifferences: ['category differs'],
		rankPosition: 1,
		reviewStatus: 'pending',
		autoDiscovered: false,
		provenance: { sourceDocumentIds: [] },
		sensitivityLevel: 'internal',
		sensitivityMetadata: sensitivityMetadata('internal'),
		...overrides,
	});
}

function cloneConfig() {
	return structuredClone(coreModule.loadConfig(EXAMPLE_CONFIG)) as import('@mulder/core').MulderConfig;
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

describe('Spec 113: Similar Entity Discovery', () => {
	it('QA-01: Config exposes domain-agnostic similarity defaults', () => {
		const minimalConfig = coreModule.loadConfig(writeMinimalConfigWithoutSimilarity()) as Record<string, unknown>;
		const exampleConfig = coreModule.loadConfig(EXAMPLE_CONFIG) as Record<string, unknown>;

		for (const config of [minimalConfig, exampleConfig]) {
			const similarity = config.similar_case_discovery as Record<string, unknown>;
			expect(similarity.enabled).toBe(true);
			expect(similarity.max_results).toBeGreaterThan(0);

			const retrieval = similarity.candidate_retrieval as Record<string, unknown>;
			expect(retrieval.vector_top_k).toBeGreaterThan(0);
			expect(retrieval.geo_radius_km).toBeNull();
			expect(retrieval.temporal_window_years).toBeNull();

			const scoring = similarity.scoring as Record<string, unknown>;
			expect(scoring.core_dimensions).toEqual(['semantic', 'structural', 'geospatial', 'temporal']);
			expect(scoring.weights).toMatchObject({
				semantic: expect.any(Number),
				structural: expect.any(Number),
				geospatial: expect.any(Number),
				temporal: expect.any(Number),
			});
			expect(scoring.domain_dimensions).toEqual([]);

			const explanation = similarity.explanation as Record<string, unknown>;
			expect(explanation).toMatchObject({ enabled: true, engine: 'deterministic' });
			expect(explanation.max_tokens).toBeGreaterThan(0);

			const autoDiscovery = similarity.auto_discovery as Record<string, unknown>;
			expect(autoDiscovery).toMatchObject({
				enabled: true,
				create_graph_edge: true,
				edge_type: 'SIMILAR_TO',
			});
			expect(autoDiscovery.max_auto_links).toBeGreaterThan(0);
			expect(JSON.stringify(similarity).toLowerCase()).not.toMatch(/ufo|ufology|sighting/);
		}
	});

	it.skipIf(!pgAvailable)('QA-02: Similarity cache schema is constrained and idempotent', async () => {
		const columns = await pool.query<{ column_name: string }>(
			[
				'SELECT column_name',
				'FROM information_schema.columns',
				"WHERE table_schema = 'public'",
				"  AND table_name = 'similarity_cache'",
				'ORDER BY ordinal_position;',
			].join('\n'),
		);
		expect(columns.rows.map((row) => row.column_name)).toEqual([
			'id',
			'entity_id_a',
			'entity_id_b',
			'pair_entity_id_low',
			'pair_entity_id_high',
			'core_scores',
			'domain_scores',
			'explanation',
			'shared_entity_ids',
			'key_differences',
			'rank_position',
			'review_status',
			'auto_discovered',
			'auto_discovery_metadata',
			'provenance',
			'sensitivity_level',
			'sensitivity_metadata',
			'created_at',
			'updated_at',
			'deleted_at',
		]);

		const indexes = await pool.query<{ indexname: string; indexdef: string }>(
			[
				'SELECT indexname, indexdef',
				'FROM pg_indexes',
				"WHERE schemaname = 'public'",
				"  AND tablename = 'similarity_cache'",
				'ORDER BY indexname;',
			].join('\n'),
		);
		const indexDefs = indexes.rows.map((row) => `${row.indexname} ${row.indexdef}`).join('\n');
		expect(indexDefs).toContain('pair_entity_id_low, pair_entity_id_high');
		expect(indexDefs).toContain('UNIQUE INDEX');
		expect(indexDefs).toContain('entity_id_a');
		expect(indexDefs).toContain('entity_id_b');
		expect(indexDefs).toContain('review_status');
		expect(indexDefs).toContain('sensitivity_level');

		const constraints = await pool.query<{ definition: string }>(
			[
				'SELECT pg_get_constraintdef(oid) AS definition',
				'FROM pg_constraint',
				"WHERE conrelid = 'similarity_cache'::regclass",
				'ORDER BY conname;',
			].join('\n'),
		);
		const constraintDefs = constraints.rows.map((row) => row.definition).join('\n');
		expect(constraintDefs).toContain('entity_id_a <> entity_id_b');
		expect(constraintDefs).toContain('jsonb_typeof(core_scores)');
		expect(constraintDefs).toContain('jsonb_typeof(domain_scores)');
		expect(constraintDefs).toContain('review_status');
		expect(constraintDefs).toContain('sensitivity_metadata');
	});

	it.skipIf(!pgAvailable)('QA-03: Repository upserts and lists per-dimension results', async () => {
		const entityA = await createEntityFixture('Spec 113 A');
		const entityB = await createEntityFixture('Spec 113 B');
		const shared = await createEntityFixture('Spec 113 Shared');

		const first = await upsertSimilarity(entityA.id, entityB.id, {
			sharedEntityIds: [shared.id],
			keyDifferences: ['source date differs'],
			provenance: { sourceDocumentIds: ['source-a'] },
			sensitivityLevel: 'restricted',
			sensitivityMetadata: sensitivityMetadata('restricted'),
		});
		const second = await upsertSimilarity(entityB.id, entityA.id, {
			explanation: 'Updated deterministic explanation',
			sharedEntityIds: [shared.id],
			keyDifferences: ['source date differs', 'location differs'],
			provenance: { sourceDocumentIds: ['source-b'] },
			sensitivityLevel: 'restricted',
			sensitivityMetadata: sensitivityMetadata('restricted'),
		});

		expect(second.id).toBe(first.id);
		const rows = await pool.query('SELECT COUNT(*)::int AS count FROM similarity_cache WHERE deleted_at IS NULL;');
		expect(rows.rows[0].count).toBe(1);

		const fromA = await coreModule.listSimilarEntities(pool, {
			entityId: entityA.id,
			maxSensitivityLevel: 'restricted',
		});
		const fromB = await coreModule.listSimilarEntities(pool, {
			entityId: entityB.id,
			maxSensitivityLevel: 'restricted',
		});
		expect(fromA).toHaveLength(1);
		expect(fromB).toHaveLength(1);
		expect(fromA[0].entityId).toBe(entityB.id);
		expect(fromB[0].entityId).toBe(entityA.id);
		expect(fromA[0].core.semantic).toMatchObject({ status: 'scored', score: 0.91 });
		expect(fromA[0].core.structural).toMatchObject({ status: 'scored', score: 0.82 });
		expect(fromA[0].core.geospatial).toMatchObject({ status: 'scored', score: 0.73 });
		expect(fromA[0].core.temporal).toMatchObject({ status: 'scored', score: 0.64 });
		expect(fromA[0].domain).toEqual([domainScore()]);
		expect(fromA[0].explanation).toBe('Updated deterministic explanation');
		expect(fromA[0].sharedEntityIds).toEqual([shared.id]);
		expect(fromA[0].keyDifferences).toEqual(['source date differs', 'location differs']);
		expect(fromA[0].provenance.sourceDocumentIds).toEqual(expect.arrayContaining(['source-b']));
		expect(fromA[0].sensitivityLevel).toBe('restricted');
		expect(fromA[0].sensitivityMetadata.level).toBe('restricted');
	});

	it.skipIf(!pgAvailable)('QA-04: Query-mode scoring exposes insufficient data', async () => {
		const entityA = await createEntityFixture('Spec 113 Sparse A', {
			attributes: { date: '2020-01-01', category: 'alpha' },
		});
		const entityB = await createEntityFixture('Spec 113 Sparse B', {
			attributes: { date: '2020-01-01', category: 'alpha' },
		});
		const config = cloneConfig();

		const result = await pipelineModule.discoverSimilarEntities(pool, config, {
			entityId: entityA.id,
			candidateIds: [entityB.id],
			maxResults: 1,
			persistResults: false,
			autoDiscover: false,
			explanation: 'Query-mode explanation',
		});

		expect(result.persistedCount).toBe(0);
		expect(result.autoLinkCount).toBe(0);
		expect(result.results).toHaveLength(1);
		const scored = result.results[0];
		expect(scored.core.semantic).toMatchObject({ status: 'insufficient_data', score: null });
		expect(scored.core.structural).toMatchObject({ status: 'insufficient_data', score: null });
		expect(scored.core.geospatial).toMatchObject({ status: 'insufficient_data', score: null });
		expect(scored.core.temporal).toMatchObject({ status: 'scored', score: 1 });
		expect(scored.cacheRecord).toBeNull();
		const cachedRows = await pool.query('SELECT COUNT(*)::int AS count FROM similarity_cache;');
		expect(cachedRows.rows[0].count).toBe(0);
	});

	it.skipIf(!pgAvailable)('keeps restricted structural evidence out of lower-sensitivity query scoring', async () => {
		const entityA = await createEntityFixture('Spec 113 Structural Filter A');
		const entityB = await createEntityFixture('Spec 113 Structural Filter B');
		const shared = await createEntityFixture('Spec 113 Structural Restricted Shared', {
			sensitivityLevel: 'restricted',
			sensitivityMetadata: sensitivityMetadata('restricted'),
		});
		const restrictedEdge = {
			relationship: 'RELATIONSHIP',
			edgeType: 'RELATIONSHIP' as const,
			sensitivityLevel: 'restricted' as const,
			sensitivityMetadata: sensitivityMetadata('restricted'),
		};
		await coreModule.createEdge(pool, {
			sourceEntityId: entityA.id,
			targetEntityId: shared.id,
			...restrictedEdge,
		});
		await coreModule.createEdge(pool, {
			sourceEntityId: entityB.id,
			targetEntityId: shared.id,
			...restrictedEdge,
		});

		const config = cloneConfig();
		const internalResult = await pipelineModule.discoverSimilarEntities(pool, config, {
			entityId: entityA.id,
			candidateIds: [entityB.id],
			maxResults: 1,
			maxSensitivityLevel: 'internal',
		});
		const restrictedResult = await pipelineModule.discoverSimilarEntities(pool, config, {
			entityId: entityA.id,
			candidateIds: [entityB.id],
			maxResults: 1,
			maxSensitivityLevel: 'restricted',
		});

		expect(internalResult.results[0].core.structural).toMatchObject({
			status: 'insufficient_data',
			score: null,
		});
		expect(internalResult.results[0].sharedEntityIds).toEqual([]);
		expect(restrictedResult.results[0].core.structural).toMatchObject({
			status: 'scored',
			score: 1,
		});
		expect(restrictedResult.results[0].sharedEntityIds).toEqual([shared.id]);
	});

	it.skipIf(!pgAvailable)('unions bounded geospatial and temporal candidate sets beyond vector top-k', async () => {
		const entityA = await createEntityFixture('Spec 113 Candidate Union A', {
			attributes: { date: '2020-01-01' },
		});
		const geoCandidate = await createEntityFixture('Spec 113 Candidate Union Geo', {
			attributes: { date: '1900-01-01' },
		});
		const temporalCandidate = await createEntityFixture('Spec 113 Candidate Union Temporal', {
			attributes: { date: '2020-06-01' },
		});
		const unrelated = await createEntityFixture('Spec 113 Candidate Union Far', {
			attributes: { date: '1900-01-01' },
		});
		await setEntityGeometry(entityA.id, 52.52, 13.405);
		await setEntityGeometry(geoCandidate.id, 52.5205, 13.4055);
		await setEntityGeometry(unrelated.id, 48.137, 11.575);

		const config = cloneConfig();
		config.similar_case_discovery.max_results = 5;
		config.similar_case_discovery.candidate_retrieval.vector_top_k = 1;
		config.similar_case_discovery.candidate_retrieval.geo_radius_km = 1;
		config.similar_case_discovery.candidate_retrieval.temporal_window_years = 1;

		const result = await pipelineModule.discoverSimilarEntities(pool, config, {
			entityId: entityA.id,
			maxResults: 5,
			persistResults: false,
			autoDiscover: false,
		});

		const resultIds = result.results.map((item) => item.entityId);
		expect(resultIds).toEqual(expect.arrayContaining([geoCandidate.id, temporalCandidate.id]));
		expect(resultIds).not.toContain(unrelated.id);
		expect(result.results.find((item) => item.entityId === geoCandidate.id)?.core.geospatial.status).toBe('scored');
		expect(result.results.find((item) => item.entityId === temporalCandidate.id)?.core.temporal.status).toBe('scored');
	});

	it.skipIf(!pgAvailable)('QA-05: Auto-discovery persists bounded links', async () => {
		const sourceAId = await createSourceFixture('auto-a');
		const sourceHighId = await createSourceFixture('auto-high');
		const entityA = await createEntityFixture('Spec 113 Auto A', {
			attributes: { date: '2020-01-01' },
			provenance: { sourceDocumentIds: [sourceAId] },
		});
		const high = await createEntityFixture('Spec 113 Auto High', {
			attributes: { date: '2020-01-01' },
			provenance: { sourceDocumentIds: [sourceHighId] },
		});
		const low = await createEntityFixture('Spec 113 Auto Low', { attributes: { date: '1900-01-01' } });
		const config = cloneConfig();
		config.similar_case_discovery.max_results = 2;
		config.similar_case_discovery.auto_discovery.threshold = 0;
		config.similar_case_discovery.auto_discovery.max_auto_links = 1;
		config.similar_case_discovery.auto_discovery.create_graph_edge = true;
		config.review_workflow.enabled = true;

		const first = await pipelineModule.discoverSimilarEntities(pool, config, {
			entityId: entityA.id,
			candidateIds: [high.id, low.id],
			maxResults: 2,
			persistResults: false,
			autoDiscover: true,
			explanation: 'Auto-discovery explanation',
		});
		const second = await pipelineModule.discoverSimilarEntities(pool, config, {
			entityId: entityA.id,
			candidateIds: [high.id, low.id],
			maxResults: 2,
			persistResults: false,
			autoDiscover: true,
			explanation: 'Auto-discovery explanation',
		});

		expect(first.autoLinkCount).toBe(1);
		expect(second.autoLinkCount).toBe(1);
		const edgeRows = await pool.query(
			"SELECT COUNT(*)::int AS count FROM entity_edges WHERE relationship = 'SIMILAR_TO';",
		);
		expect(edgeRows.rows[0].count).toBe(1);
		const cacheRows = await pool.query('SELECT COUNT(*)::int AS count FROM similarity_cache WHERE deleted_at IS NULL;');
		expect(cacheRows.rows[0].count).toBe(1);
		const linked = await coreModule.findSimilarityByPair(pool, entityA.id, high.id);
		expect(linked?.autoDiscovered).toBe(true);
		expect(linked?.rankPosition).toBe(1);
		expect(linked?.provenance.sourceDocumentIds.sort()).toEqual([sourceAId, sourceHighId].sort());
		expect(linked?.autoDiscoveryMetadata).toMatchObject({
			threshold: 0,
			max_auto_links: 1,
			create_graph_edge: true,
		});
		expect(linked?.autoDiscoveryMetadata).not.toHaveProperty('weighted_rank_score');
		const edge = await pool.query<{
			confidence: number | null;
			attributes: Record<string, unknown>;
			provenance: { source_document_ids?: string[] };
		}>("SELECT confidence, attributes, provenance FROM entity_edges WHERE relationship = 'SIMILAR_TO';");
		expect(edge.rows[0].confidence).toBeNull();
		expect(edge.rows[0].attributes).not.toHaveProperty('weighted_rank_score');
		expect(edge.rows[0].provenance.source_document_ids?.sort()).toEqual([sourceAId, sourceHighId].sort());
	});

	it.skipIf(!pgAvailable)('marks only bounded auto-discovery rows when query persistence is enabled', async () => {
		const entityA = await createEntityFixture('Spec 113 Query Persist Auto A', {
			attributes: { date: '2020-01-01' },
		});
		const high = await createEntityFixture('Spec 113 Query Persist Auto High', {
			attributes: { date: '2020-01-01' },
		});
		const low = await createEntityFixture('Spec 113 Query Persist Auto Low', {
			attributes: { date: '1900-01-01' },
		});
		const config = cloneConfig();
		config.similar_case_discovery.max_results = 2;
		config.similar_case_discovery.auto_discovery.threshold = 0;
		config.similar_case_discovery.auto_discovery.max_auto_links = 1;
		config.similar_case_discovery.auto_discovery.create_graph_edge = false;
		config.review_workflow.enabled = true;

		const result = await pipelineModule.discoverSimilarEntities(pool, config, {
			entityId: entityA.id,
			candidateIds: [high.id, low.id],
			maxResults: 2,
			persistResults: true,
			autoDiscover: true,
			explanation: 'Query-persisted auto-discovery explanation',
		});

		expect(result.persistedCount).toBe(2);
		expect(result.autoLinkCount).toBe(0);
		expect(result.results.map((item) => item.entityId)).toEqual([high.id, low.id]);
		const highCache = await coreModule.findSimilarityByPair(pool, entityA.id, high.id);
		const lowCache = await coreModule.findSimilarityByPair(pool, entityA.id, low.id);
		expect(highCache?.autoDiscovered).toBe(true);
		expect(highCache?.autoDiscoveryMetadata).toMatchObject({ max_auto_links: 1 });
		expect(lowCache?.autoDiscovered).toBe(false);
		expect(lowCache?.autoDiscoveryMetadata).toEqual({});
		expect(result.cachedResults.map((item) => item.entityId).sort()).toEqual([high.id, low.id].sort());
		expect(result.results[0].reviewArtifactId).toMatch(/^[0-9a-f-]+$/);
		expect(result.results[1].reviewArtifactId).toBeNull();
		const artifacts = await coreModule.listReviewableArtifacts(pool, { artifactType: 'similar_case_link' });
		expect(artifacts).toHaveLength(1);
		expect(artifacts[0].currentValue).toMatchObject({
			source_entity_id: entityA.id,
			target_entity_id: high.id,
			explanation: 'Query-persisted auto-discovery explanation',
		});
		const edgeRows = await pool.query(
			"SELECT COUNT(*)::int AS count FROM entity_edges WHERE relationship = 'SIMILAR_TO';",
		);
		expect(edgeRows.rows[0].count).toBe(0);
	});

	it.skipIf(!pgAvailable)('updates an existing higher-sensitivity SIMILAR_TO edge during auto-discovery', async () => {
		const entityA = await createEntityFixture('Spec 113 Edge Sensitivity A', {
			attributes: { date: '2020-01-01' },
		});
		const entityB = await createEntityFixture('Spec 113 Edge Sensitivity B', {
			attributes: { date: '2020-01-01' },
		});
		const existing = await coreModule.createEdge(pool, {
			sourceEntityId: entityA.id,
			targetEntityId: entityB.id,
			relationship: 'SIMILAR_TO',
			edgeType: 'RELATIONSHIP',
			attributes: { previous: true },
			sensitivityLevel: 'restricted',
			sensitivityMetadata: sensitivityMetadata('restricted'),
		});
		const config = cloneConfig();
		config.similar_case_discovery.auto_discovery.threshold = 0;
		config.similar_case_discovery.auto_discovery.max_auto_links = 1;
		config.similar_case_discovery.auto_discovery.create_graph_edge = true;

		const result = await pipelineModule.discoverSimilarEntities(pool, config, {
			entityId: entityA.id,
			candidateIds: [entityB.id],
			maxResults: 1,
			autoDiscover: true,
			explanation: 'Updated edge explanation',
		});

		expect(result.autoLinkCount).toBe(1);
		expect(result.results[0].graphEdgeId).toBe(existing.id);
		const rows = await pool.query<{
			count: number;
			id: string;
			sensitivity_level: string;
			attributes: Record<string, unknown>;
		}>(
			[
				'SELECT COUNT(*) OVER ()::int AS count, id, sensitivity_level, attributes',
				'FROM entity_edges',
				"WHERE relationship = 'SIMILAR_TO'",
				'ORDER BY created_at;',
			].join('\n'),
		);
		expect(rows.rows).toHaveLength(1);
		expect(rows.rows[0]).toMatchObject({
			count: 1,
			id: existing.id,
			sensitivity_level: 'internal',
			attributes: expect.objectContaining({
				generatedBy: 'analyze.similar_case_discovery',
			}),
		});
	});

	it.skipIf(!pgAvailable)('QA-06: Sensitivity filtering hides over-sensitive links', async () => {
		const entityA = await createEntityFixture('Spec 113 Filter A');
		const internal = await createEntityFixture('Spec 113 Filter Internal');
		const restricted = await createEntityFixture('Spec 113 Filter Restricted');
		const confidential = await createEntityFixture('Spec 113 Filter Confidential');

		await upsertSimilarity(entityA.id, internal.id, {
			sensitivityLevel: 'internal',
			sensitivityMetadata: sensitivityMetadata('internal'),
		});
		await upsertSimilarity(entityA.id, restricted.id, {
			sensitivityLevel: 'restricted',
			sensitivityMetadata: sensitivityMetadata('restricted'),
		});
		await upsertSimilarity(entityA.id, confidential.id, {
			sensitivityLevel: 'confidential',
			sensitivityMetadata: sensitivityMetadata('confidential'),
		});

		const internalResults = await coreModule.listSimilarEntities(pool, {
			entityId: entityA.id,
			maxSensitivityLevel: 'internal',
		});
		expect(internalResults.map((result) => result.entityId)).toEqual([internal.id]);

		const adminResults = await coreModule.listSimilarEntities(pool, {
			entityId: entityA.id,
			maxSensitivityLevel: 'confidential',
		});
		expect(adminResults.map((result) => result.entityId).sort()).toEqual(
			[confidential.id, internal.id, restricted.id].sort(),
		);
	});

	it.skipIf(!pgAvailable)('filters cached discovery reloads by the requested sensitivity level', async () => {
		const entityA = await createEntityFixture('Spec 113 Cached Filter A', {
			attributes: { date: '2020-01-01' },
		});
		const internal = await createEntityFixture('Spec 113 Cached Filter Internal', {
			attributes: { date: '2020-01-01' },
		});
		const restricted = await createEntityFixture('Spec 113 Cached Filter Restricted', {
			attributes: { date: '2020-01-01' },
			sensitivityLevel: 'restricted',
			sensitivityMetadata: sensitivityMetadata('restricted'),
		});
		await upsertSimilarity(entityA.id, restricted.id, {
			sensitivityLevel: 'restricted',
			sensitivityMetadata: sensitivityMetadata('restricted'),
		});
		const config = cloneConfig();

		const result = await pipelineModule.discoverSimilarEntities(pool, config, {
			entityId: entityA.id,
			candidateIds: [internal.id],
			maxResults: 10,
			persistResults: true,
			autoDiscover: false,
			maxSensitivityLevel: 'internal',
			explanation: 'Internal cached reload explanation',
		});

		expect(result.results.map((item) => item.entityId)).toEqual([internal.id]);
		expect(result.cachedResults.map((item) => item.entityId)).toEqual([internal.id]);
		expect(result.cachedResults).toHaveLength(1);
		expect(result.cachedResults[0].sensitivityLevel).toBe('internal');
	});

	it.skipIf(!pgAvailable)('QA-07: Review artifact registration is observable', async () => {
		const sourceAId = await createSourceFixture('review-a');
		const sourceBId = await createSourceFixture('review-b');
		const entityA = await createEntityFixture('Spec 113 Review A', {
			attributes: { date: '2020-01-01' },
			provenance: { sourceDocumentIds: [sourceAId] },
		});
		const entityB = await createEntityFixture('Spec 113 Review B', {
			attributes: { date: '2020-01-01' },
			provenance: { sourceDocumentIds: [sourceBId] },
		});
		const config = cloneConfig();
		config.similar_case_discovery.auto_discovery.threshold = 0;
		config.similar_case_discovery.auto_discovery.max_auto_links = 1;
		config.similar_case_discovery.auto_discovery.create_graph_edge = true;
		config.review_workflow.enabled = true;

		const result = await pipelineModule.discoverSimilarEntities(pool, config, {
			entityId: entityA.id,
			candidateIds: [entityB.id],
			maxResults: 1,
			persistResults: false,
			autoDiscover: true,
			explanation: 'Review artifact explanation',
		});
		expect(result.results[0].reviewArtifactId).toMatch(/^[0-9a-f-]+$/);

		const artifacts = await coreModule.listReviewableArtifacts(pool, { artifactType: 'similar_case_link' });
		expect(artifacts).toHaveLength(1);
		const artifact = artifacts[0];
		expect(artifact.subjectTable).toBe('similarity_cache');
		expect(artifact.currentValue).toMatchObject({
			source_entity_id: entityA.id,
			target_entity_id: entityB.id,
			explanation: 'Review artifact explanation',
			core: expect.objectContaining({
				semantic: expect.objectContaining({ status: 'insufficient_data' }),
				temporal: expect.objectContaining({ status: 'scored' }),
			}),
			domain: [],
			provenance: expect.objectContaining({
				sourceDocumentIds: expect.arrayContaining([sourceAId, sourceBId]),
			}),
		});
		expect(artifact.context).toMatchObject({
			source_entity_id: entityA.id,
			target_entity_id: entityB.id,
			shared_entity_ids: [],
			provenance: expect.objectContaining({
				sourceDocumentIds: expect.arrayContaining([sourceAId, sourceBId]),
			}),
			sensitivity_level: 'internal',
			sensitivity_metadata: expect.objectContaining({ level: 'internal' }),
		});
	});
});
