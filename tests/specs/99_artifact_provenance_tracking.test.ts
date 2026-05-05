import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as db from '../lib/db.js';
import { ensureSchema, truncateMulderTables } from '../lib/schema.js';

const ROOT = resolve(import.meta.dirname, '../..');
const MIGRATIONS_DIR = resolve(ROOT, 'packages/core/src/database/migrations');
const DB_MODULE = resolve(ROOT, 'packages/core/dist/database/index.js');

const PG_CONFIG = {
	host: db.TEST_PG_HOST,
	port: db.TEST_PG_PORT,
	database: db.TEST_PG_DATABASE,
	user: db.TEST_PG_USER,
	password: db.TEST_PG_PASSWORD,
};

const SOURCE_A = '00000000-0000-0000-0000-000000099001';
const SOURCE_B = '00000000-0000-0000-0000-000000099002';
const STORY_A = '00000000-0000-0000-0000-000000099101';
const STORY_B = '00000000-0000-0000-0000-000000099102';
const ENTITY_ID = '00000000-0000-0000-0000-000000099201';
const OTHER_ENTITY_ID = '00000000-0000-0000-0000-000000099202';
const ALIAS_ID = '00000000-0000-0000-0000-000000099301';
const EDGE_ID = '00000000-0000-0000-0000-000000099401';
const CHUNK_ID = '00000000-0000-0000-0000-000000099501';

let pool: pg.Pool;
let pgAvailable = false;

let createEntity: (...args: unknown[]) => Promise<Record<string, unknown>>;
let upsertEntityByNameType: (...args: unknown[]) => Promise<Record<string, unknown>>;
let findEntityById: (...args: unknown[]) => Promise<Record<string, unknown> | null>;
let createEntityAlias: (...args: unknown[]) => Promise<Record<string, unknown>>;
let findAliasesByEntityId: (...args: unknown[]) => Promise<Array<Record<string, unknown>>>;
let linkStoryEntity: (...args: unknown[]) => Promise<Record<string, unknown>>;
let createEdge: (...args: unknown[]) => Promise<Record<string, unknown>>;
let upsertEdge: (...args: unknown[]) => Promise<Record<string, unknown>>;
let findEdgeById: (...args: unknown[]) => Promise<Record<string, unknown> | null>;
let createChunk: (...args: unknown[]) => Promise<Record<string, unknown>>;
let findChunkById: (...args: unknown[]) => Promise<Record<string, unknown> | null>;
let createSource: (...args: unknown[]) => Promise<Record<string, unknown>>;
let createStory: (...args: unknown[]) => Promise<Record<string, unknown>>;

function migrationFilesThrough(filename: string): string[] {
	return readdirSync(MIGRATIONS_DIR)
		.filter((file) => file.endsWith('.sql') && file <= filename)
		.sort()
		.map((file) => resolve(MIGRATIONS_DIR, file));
}

async function resetDatabase(): Promise<void> {
	await pool.query(
		[
			'DROP FUNCTION IF EXISTS reset_pipeline_step CASCADE',
			'DROP FUNCTION IF EXISTS gc_orphaned_entities CASCADE',
			'DROP TABLE IF EXISTS monthly_budget_reservations CASCADE',
			'DROP TABLE IF EXISTS pipeline_run_sources CASCADE',
			'DROP TABLE IF EXISTS pipeline_runs CASCADE',
			'DROP TABLE IF EXISTS jobs CASCADE',
			'DROP TABLE IF EXISTS api_sessions CASCADE',
			'DROP TABLE IF EXISTS api_invitations CASCADE',
			'DROP TABLE IF EXISTS api_users CASCADE',
			'DROP TABLE IF EXISTS document_blobs CASCADE',
			'DROP TYPE IF EXISTS job_status CASCADE',
			'DROP TABLE IF EXISTS chunks CASCADE',
			'DROP TABLE IF EXISTS story_entities CASCADE',
			'DROP TABLE IF EXISTS entity_edges CASCADE',
			'DROP TABLE IF EXISTS entity_aliases CASCADE',
			'DROP TABLE IF EXISTS taxonomy CASCADE',
			'DROP TABLE IF EXISTS entities CASCADE',
			'DROP TABLE IF EXISTS stories CASCADE',
			'DROP TABLE IF EXISTS spatio_temporal_clusters CASCADE',
			'DROP TABLE IF EXISTS evidence_chains CASCADE',
			'DROP TABLE IF EXISTS entity_grounding CASCADE',
			'DROP TABLE IF EXISTS url_lifecycle CASCADE',
			'DROP TABLE IF EXISTS url_host_lifecycle CASCADE',
			'DROP TABLE IF EXISTS source_steps CASCADE',
			'DROP TABLE IF EXISTS sources CASCADE',
			'DROP TABLE IF EXISTS mulder_migrations CASCADE',
			'DROP TYPE IF EXISTS source_type CASCADE',
			'DROP EXTENSION IF EXISTS vector CASCADE',
			'DROP EXTENSION IF EXISTS postgis CASCADE',
			'DROP EXTENSION IF EXISTS pg_trgm CASCADE',
		].join('; '),
	);
}

async function applyMigrationsThrough(filename: string): Promise<void> {
	for (const file of migrationFilesThrough(filename)) {
		await pool.query(readFileSync(file, 'utf-8'));
	}
}

async function seedPreProvenanceArtifacts(): Promise<void> {
	await pool.query(
		`
		INSERT INTO sources (id, filename, storage_path, file_hash, status)
		VALUES
			($1, 'source-a.pdf', 'raw/source-a.pdf', 'hash-spec99-a', 'segmented'),
			($2, 'source-b.pdf', 'raw/source-b.pdf', 'hash-spec99-b', 'segmented')
		`,
		[SOURCE_A, SOURCE_B],
	);
	await pool.query(
		`
		INSERT INTO stories (id, source_id, title, gcs_markdown_uri, gcs_metadata_uri, status)
		VALUES
			($1, $2, 'Story A', 'gs://bucket/a.md', 'gs://bucket/a.json', 'embedded'),
			($3, $4, 'Story B', 'gs://bucket/b.md', 'gs://bucket/b.json', 'embedded')
		`,
		[STORY_A, SOURCE_A, STORY_B, SOURCE_B],
	);
	await pool.query(
		`
		INSERT INTO entities (id, name, type)
		VALUES
			($1, 'Shared Entity', 'person'),
			($2, 'Other Entity', 'person')
		`,
		[ENTITY_ID, OTHER_ENTITY_ID],
	);
	await pool.query(
		`
		INSERT INTO entity_aliases (id, entity_id, alias, source)
		VALUES ($1, $2, 'Shared Alias', 'fixture')
		`,
		[ALIAS_ID, ENTITY_ID],
	);
	await pool.query(
		`
		INSERT INTO story_entities (story_id, entity_id, confidence, mention_count)
		VALUES
			($1, $3, 0.9, 1),
			($2, $3, 0.8, 1)
		`,
		[STORY_A, STORY_B, ENTITY_ID],
	);
	await pool.query(
		`
		INSERT INTO entity_edges (id, source_entity_id, target_entity_id, relationship, story_id)
		VALUES ($1, $2, $3, 'knows', $4)
		`,
		[EDGE_ID, ENTITY_ID, OTHER_ENTITY_ID, STORY_A],
	);
	await pool.query(
		`
		INSERT INTO chunks (id, story_id, content, chunk_index)
		VALUES ($1, $2, 'Chunk content', 0)
		`,
		[CHUNK_ID, STORY_A],
	);
}

async function seedRepositoryParents(): Promise<{ sourceId: string; storyId: string; runId: string }> {
	await truncateMulderTables();
	const runId = randomUUID();
	const source = await createSource(pool, {
		filename: `spec99-${Date.now()}.pdf`,
		storagePath: `raw/spec99-${Date.now()}.pdf`,
		fileHash: `hash_spec99_repo_${Date.now()}`,
		pageCount: 1,
	});
	const story = await createStory(pool, {
		sourceId: source.id,
		title: 'Spec 99 Repository Story',
		gcsMarkdownUri: 'gs://bucket/spec99/story.md',
		gcsMetadataUri: 'gs://bucket/spec99/story.json',
	});
	return { sourceId: String(source.id), storyId: String(story.id), runId };
}

function sourceIds(value: unknown): string[] {
	if (value === null || value === undefined || typeof value !== 'object') {
		return [];
	}
	const provenance = value as { sourceDocumentIds?: string[] };
	return provenance.sourceDocumentIds ?? [];
}

describe('Spec 99: Artifact Provenance Tracking', () => {
	beforeAll(async () => {
		pgAvailable = db.isPgAvailable();
		if (!pgAvailable) {
			console.warn('SKIP: PostgreSQL not reachable at PGHOST/PGPORT.');
			return;
		}

		pool = new pg.Pool(PG_CONFIG);
		await resetDatabase();
		await applyMigrationsThrough('024_document_blobs.sql');
		await seedPreProvenanceArtifacts();
		await pool.query(readFileSync(resolve(MIGRATIONS_DIR, '025_artifact_provenance.sql'), 'utf-8'));

		const coreMod = await import(DB_MODULE);
		createEntity = coreMod.createEntity;
		upsertEntityByNameType = coreMod.upsertEntityByNameType;
		findEntityById = coreMod.findEntityById;
		createEntityAlias = coreMod.createEntityAlias;
		findAliasesByEntityId = coreMod.findAliasesByEntityId;
		linkStoryEntity = coreMod.linkStoryEntity;
		createEdge = coreMod.createEdge;
		upsertEdge = coreMod.upsertEdge;
		findEdgeById = coreMod.findEdgeById;
		createChunk = coreMod.createChunk;
		findChunkById = coreMod.findChunkById;
		createSource = coreMod.createSource;
		createStory = coreMod.createStory;
	}, 60_000);

	afterAll(async () => {
		if (!pgAvailable) return;
		await resetDatabase();
		await pool.end();
		ensureSchema();
	});

	it('QA-01: artifact tables have constrained provenance JSONB', async () => {
		if (!pgAvailable) return;

		const tables = ['entities', 'entity_aliases', 'entity_edges', 'story_entities', 'chunks'];
		for (const table of tables) {
			const column = await pool.query<{ data_type: string; is_nullable: string }>(
				`
				SELECT data_type, is_nullable
				FROM information_schema.columns
				WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'provenance'
				`,
				[table],
			);
			expect(column.rows[0]).toEqual({ data_type: 'jsonb', is_nullable: 'NO' });

			const constraints = await pool.query<{ constraint_name: string }>(
				`
				SELECT constraint_name
				FROM information_schema.table_constraints
				WHERE table_schema = 'public' AND table_name = $1 AND constraint_type = 'CHECK'
				  AND constraint_name LIKE '%provenance_shape'
				`,
				[table],
			);
			expect(constraints.rows.length).toBeGreaterThanOrEqual(1);
		}
	});

	it('QA-02/03: migration backfills story-linked artifacts, shared entities, and aliases', async () => {
		if (!pgAvailable) return;

		const rows = await pool.query<{
			chunk_sources: string[];
			link_sources: string[];
			edge_sources: string[];
			entity_sources: string[];
			alias_sources: string[];
		}>(
			`
			SELECT
				(SELECT ARRAY(SELECT jsonb_array_elements_text(provenance->'source_document_ids') ORDER BY 1) FROM chunks WHERE id = $1) AS chunk_sources,
				(SELECT ARRAY(SELECT jsonb_array_elements_text(provenance->'source_document_ids') ORDER BY 1) FROM story_entities WHERE story_id = $2 AND entity_id = $3) AS link_sources,
				(SELECT ARRAY(SELECT jsonb_array_elements_text(provenance->'source_document_ids') ORDER BY 1) FROM entity_edges WHERE id = $4) AS edge_sources,
				(SELECT ARRAY(SELECT jsonb_array_elements_text(provenance->'source_document_ids') ORDER BY 1) FROM entities WHERE id = $3) AS entity_sources,
				(SELECT ARRAY(SELECT jsonb_array_elements_text(provenance->'source_document_ids') ORDER BY 1) FROM entity_aliases WHERE id = $5) AS alias_sources
			`,
			[CHUNK_ID, STORY_A, ENTITY_ID, EDGE_ID, ALIAS_ID],
		);
		const row = rows.rows[0];
		expect(row.chunk_sources).toEqual([SOURCE_A]);
		expect(row.link_sources).toEqual([SOURCE_A]);
		expect(row.edge_sources).toEqual([SOURCE_A]);
		expect(row.entity_sources).toEqual([SOURCE_A, SOURCE_B]);
		expect(row.alias_sources).toEqual([SOURCE_A, SOURCE_B]);
	});

	it('QA-04/05: repositories round-trip and merge provenance on artifact writes', async () => {
		if (!pgAvailable) return;

		const { sourceId, storyId, runId } = await seedRepositoryParents();
		const secondSourceId = randomUUID();
		const provenanceA = { sourceDocumentIds: [sourceId, sourceId, ''], extractionPipelineRun: runId };
		const provenanceB = { sourceDocumentIds: [secondSourceId], extractionPipelineRun: null };

		const entity = await upsertEntityByNameType(pool, { name: 'Repo Entity', type: 'person', provenance: provenanceA });
		const mergedEntity = await upsertEntityByNameType(pool, {
			name: 'Repo Entity',
			type: 'person',
			provenance: provenanceB,
		});
		expect(mergedEntity.id).toBe(entity.id);
		expect(sourceIds(mergedEntity.provenance)).toEqual([secondSourceId, sourceId].sort());
		expect((mergedEntity.provenance as { extractionPipelineRun: string | null }).extractionPipelineRun).toBe(runId);

		const alias = await createEntityAlias(pool, { entityId: entity.id, alias: 'Repo Alias', provenance: provenanceA });
		const mergedAlias = await createEntityAlias(pool, {
			entityId: entity.id,
			alias: 'Repo Alias',
			provenance: provenanceB,
		});
		expect(mergedAlias.id).toBe(alias.id);
		expect(sourceIds(mergedAlias.provenance)).toEqual([secondSourceId, sourceId].sort());

		const storyEntity = await linkStoryEntity(pool, {
			storyId,
			entityId: entity.id,
			confidence: 0.9,
			mentionCount: 2,
			provenance: provenanceA,
		});
		expect(storyEntity.id).toBe(entity.id);

		const target = await createEntity(pool, { name: 'Repo Target', type: 'person', provenance: provenanceA });
		const edge = await createEdge(pool, {
			sourceEntityId: entity.id,
			targetEntityId: target.id,
			relationship: 'knows',
			storyId,
			provenance: provenanceA,
		});
		const mergedEdge = await upsertEdge(pool, {
			sourceEntityId: entity.id,
			targetEntityId: target.id,
			relationship: 'knows',
			storyId,
			provenance: provenanceB,
		});
		expect(mergedEdge.id).toBe(edge.id);
		expect(sourceIds(mergedEdge.provenance)).toEqual([secondSourceId, sourceId].sort());

		const chunk = await createChunk(pool, {
			id: randomUUID(),
			storyId,
			content: 'Repository chunk',
			chunkIndex: 0,
			provenance: provenanceA,
		});
		const foundChunk = await findChunkById(pool, chunk.id);
		expect(sourceIds(foundChunk?.provenance)).toEqual([sourceId]);

		const foundEntity = await findEntityById(pool, entity.id);
		expect(sourceIds(foundEntity?.provenance)).toEqual([secondSourceId, sourceId].sort());
		const aliases = await findAliasesByEntityId(pool, entity.id);
		expect(sourceIds(aliases[0].provenance)).toEqual([secondSourceId, sourceId].sort());
		const foundEdge = await findEdgeById(pool, edge.id);
		expect(sourceIds(foundEdge?.provenance)).toEqual([secondSourceId, sourceId].sort());
	});
});
