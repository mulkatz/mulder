import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as db from '../lib/db.js';

const ROOT = resolve(import.meta.dirname, '../..');
const CLI = resolve(ROOT, 'apps/cli/dist/index.js');
const EXAMPLE_CONFIG = resolve(ROOT, 'mulder.config.example.yaml');

/**
 * Black-box QA tests for Spec 09: Job Queue & Pipeline Tracking Migrations (012-014)
 *
 * Each `it()` maps to one QA condition from Section 5 of the spec.
 * Tests interact through system boundaries only: CLI subprocess calls,
 * SQL via `the shared env-driven SQL helper`, and filesystem.
 * Never import from packages/ or src/ or apps/.
 *
 * Requires a running PostgreSQL instance (the standard PG env vars)
 * with pgvector, PostGIS, and pg_trgm extensions available.
 */

// ─── Test data UUIDs ───

const SOURCE_ID_1 = '00000000-0000-0000-0000-000000009001';
const SOURCE_ID_2 = '00000000-0000-0000-0000-000000009002';
const STORY_ID_1 = '00000000-0000-0000-0000-000000009101';
const STORY_ID_2 = '00000000-0000-0000-0000-000000009102';
const ENTITY_ID_1 = '00000000-0000-0000-0000-000000009201';
const ENTITY_ID_2 = '00000000-0000-0000-0000-000000009202';
const ENTITY_ID_ORPHAN = '00000000-0000-0000-0000-000000009203';
const CHUNK_ID_1 = '00000000-0000-0000-0000-000000009301';
const PIPELINE_RUN_ID = '00000000-0000-0000-0000-000000009401';

/**
 * Helper: run the CLI binary via node as a subprocess.
 */
function runCli(
	args: string[],
	opts?: { env?: Record<string, string>; timeout?: number },
): { stdout: string; stderr: string; exitCode: number } {
	const result = spawnSync('node', [CLI, ...args], {
		cwd: ROOT,
		encoding: 'utf-8',
		timeout: opts?.timeout ?? 30000,
		stdio: ['pipe', 'pipe', 'pipe'],
		env: { ...process.env, PGPASSWORD: db.TEST_PG_PASSWORD, ...opts?.env },
	});
	return {
		stdout: result.stdout ?? '',
		stderr: result.stderr ?? '',
		exitCode: result.status ?? 1,
	};
}

/**
 * Helper: run SQL via the shared env-driven SQL helper. Returns query output.
 */
/**
 * Helper: run SQL, return null on failure instead of throwing.
 */
function hasRequiredExtensions(): boolean {
	try {
		const out = db.runSql(
			"SELECT count(*) FROM pg_available_extensions WHERE name IN ('vector', 'postgis', 'pg_trgm');",
		);
		return Number.parseInt(out, 10) >= 3;
	} catch {
		return false;
	}
}

function resetDatabase(): void {
	const dropSql = [
		'DROP FUNCTION IF EXISTS reset_pipeline_step CASCADE',
		'DROP FUNCTION IF EXISTS gc_orphaned_entities CASCADE',
		'DROP TABLE IF EXISTS pipeline_run_sources CASCADE',
		'DROP TABLE IF EXISTS pipeline_runs CASCADE',
		'DROP TABLE IF EXISTS jobs CASCADE',
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
		'DROP TABLE IF EXISTS source_steps CASCADE',
		'DROP TABLE IF EXISTS sources CASCADE',
		'DROP TABLE IF EXISTS mulder_migrations CASCADE',
		'DROP INDEX IF EXISTS idx_entities_geom',
		'DROP EXTENSION IF EXISTS vector CASCADE',
		'DROP EXTENSION IF EXISTS postgis CASCADE',
		'DROP EXTENSION IF EXISTS pg_trgm CASCADE',
	].join('; ');

	db.runSql(dropSql);
}

/**
 * Helper: clean up test data inserted by reset function tests.
 */
function cleanupTestData(): void {
	const cleanSql = [
		`DELETE FROM chunks WHERE id = '${CHUNK_ID_1}'`,
		`DELETE FROM story_entities WHERE story_id IN ('${STORY_ID_1}', '${STORY_ID_2}')`,
		`DELETE FROM entity_edges WHERE story_id IN ('${STORY_ID_1}', '${STORY_ID_2}')`,
		`DELETE FROM stories WHERE source_id IN ('${SOURCE_ID_1}', '${SOURCE_ID_2}')`,
		`DELETE FROM source_steps WHERE source_id IN ('${SOURCE_ID_1}', '${SOURCE_ID_2}')`,
		`DELETE FROM entities WHERE id IN ('${ENTITY_ID_1}', '${ENTITY_ID_2}', '${ENTITY_ID_ORPHAN}')`,
		`DELETE FROM pipeline_run_sources WHERE run_id = '${PIPELINE_RUN_ID}'`,
		`DELETE FROM pipeline_runs WHERE id = '${PIPELINE_RUN_ID}'`,
		`DELETE FROM sources WHERE id IN ('${SOURCE_ID_1}', '${SOURCE_ID_2}')`,
		`DELETE FROM jobs WHERE type = 'spec09_test'`,
	].join('; ');

	db.runSqlSafe(cleanSql);
}

/**
 * Helper: seed a fully populated source with stories, entities, edges, chunks, and source_steps
 * for testing reset_pipeline_step scenarios.
 */
function seedFullSource(): void {
	const seedSql = [
		// Source
		`INSERT INTO sources (id, filename, storage_path, file_hash, status) VALUES ('${SOURCE_ID_1}', 'test-reset.pdf', 'gs://bucket/test-reset.pdf', 'hash_reset_spec09', 'completed')`,

		// Source steps
		`INSERT INTO source_steps (source_id, step_name, status) VALUES ('${SOURCE_ID_1}', 'extract', 'completed')`,
		`INSERT INTO source_steps (source_id, step_name, status) VALUES ('${SOURCE_ID_1}', 'segment', 'completed')`,
		`INSERT INTO source_steps (source_id, step_name, status) VALUES ('${SOURCE_ID_1}', 'enrich', 'completed')`,
		`INSERT INTO source_steps (source_id, step_name, status) VALUES ('${SOURCE_ID_1}', 'embed', 'completed')`,
		`INSERT INTO source_steps (source_id, step_name, status) VALUES ('${SOURCE_ID_1}', 'graph', 'completed')`,

		// Stories
		`INSERT INTO stories (id, source_id, title, gcs_markdown_uri, gcs_metadata_uri, status) VALUES ('${STORY_ID_1}', '${SOURCE_ID_1}', 'Test Story 1', 'gs://bucket/seg/s1.md', 'gs://bucket/seg/s1.meta.json', 'completed')`,
		`INSERT INTO stories (id, source_id, title, gcs_markdown_uri, gcs_metadata_uri, status) VALUES ('${STORY_ID_2}', '${SOURCE_ID_1}', 'Test Story 2', 'gs://bucket/seg/s2.md', 'gs://bucket/seg/s2.meta.json', 'completed')`,

		// Entities (one linked, one for orphan testing later)
		`INSERT INTO entities (id, name, type) VALUES ('${ENTITY_ID_1}', 'Test Entity 1', 'person')`,
		`INSERT INTO entities (id, name, type) VALUES ('${ENTITY_ID_2}', 'Test Entity 2', 'location')`,

		// Story-entity links
		`INSERT INTO story_entities (story_id, entity_id, mention_count) VALUES ('${STORY_ID_1}', '${ENTITY_ID_1}', 3)`,
		`INSERT INTO story_entities (story_id, entity_id, mention_count) VALUES ('${STORY_ID_2}', '${ENTITY_ID_2}', 1)`,

		// Entity edges
		`INSERT INTO entity_edges (source_entity_id, target_entity_id, relationship, story_id) VALUES ('${ENTITY_ID_1}', '${ENTITY_ID_2}', 'MENTIONED_WITH', '${STORY_ID_1}')`,

		// Chunks
		`INSERT INTO chunks (id, story_id, content, chunk_index) VALUES ('${CHUNK_ID_1}', '${STORY_ID_1}', 'This is a test chunk for spec 09 testing', 0)`,
	].join('; ');

	db.runSql(seedSql);
}

describe('Spec 09: Job Queue & Pipeline Tracking Migrations (012-014)', () => {
	let pgAvailable: boolean;
	let extensionsAvailable: boolean;

	beforeAll(() => {
		pgAvailable = db.isPgAvailable();
		if (!pgAvailable) {
			console.warn('SKIP: PostgreSQL not reachable at PGHOST/PGPORT.');
			return;
		}

		extensionsAvailable = hasRequiredExtensions();
		if (!extensionsAvailable) {
			console.warn('SKIP: Required extensions (pgvector, PostGIS, pg_trgm) not available in PostgreSQL container.');
			return;
		}

		// Start with a clean database
		resetDatabase();

		// Run all migrations (001-008 + 012-014)
		const { exitCode, stdout, stderr } = runCli(['db', 'migrate', EXAMPLE_CONFIG]);
		if (exitCode !== 0) {
			throw new Error(`Initial migration failed (exit ${exitCode}):\n${stdout}\n${stderr}`);
		}
	});

	afterAll(() => {
		if (pgAvailable && extensionsAvailable) {
			cleanupTestData();
			resetDatabase();
		}
	});

	function skipIfUnavailable(): boolean {
		if (!pgAvailable || !extensionsAvailable) {
			return true;
		}
		return false;
	}

	// ─── QA-01: Migrations apply cleanly ───

	describe('QA-01: Migrations apply cleanly', () => {
		it('migrations 012-014 apply without error on top of 001-008', () => {
			if (skipIfUnavailable()) return;

			// Migrations were applied in beforeAll. Verify that 012-014 are recorded.
			const migrationCount = db.runSql('SELECT count(*) FROM mulder_migrations;');
			// 001-008 = 8, 012-014 = 3, total = 11
			expect(Number.parseInt(migrationCount, 10)).toBeGreaterThanOrEqual(11);

			// Verify specific migration files are recorded
			const migrations = db.runSql('SELECT filename FROM mulder_migrations ORDER BY filename;');
			const migrationList = migrations.split('\n').filter(Boolean);

			expect(migrationList).toContain('012_job_queue.sql');
			expect(migrationList).toContain('013_pipeline_tracking.sql');
			expect(migrationList).toContain('014_pipeline_functions.sql');
		});
	});

	// ─── QA-02: Job status enum exists ───

	describe('QA-02: Job status enum exists', () => {
		it('job_status enum exists with values: pending, running, completed, failed, dead_letter', () => {
			if (skipIfUnavailable()) return;

			// Check enum exists in pg_type
			const enumExists = db.runSql("SELECT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'job_status');");
			expect(enumExists).toBe('t');

			// Check enum values
			const enumValues = db.runSql(
				"SELECT enumlabel FROM pg_enum WHERE enumtypid = (SELECT oid FROM pg_type WHERE typname = 'job_status') ORDER BY enumsortorder;",
			);
			const values = enumValues.split('\n').filter(Boolean);

			expect(values).toContain('pending');
			expect(values).toContain('running');
			expect(values).toContain('completed');
			expect(values).toContain('failed');
			expect(values).toContain('dead_letter');
			expect(values).toHaveLength(5);
		});
	});

	// ─── QA-03: Jobs table structure ───

	describe('QA-03: Jobs table structure', () => {
		it('jobs table has all columns with correct types and defaults', () => {
			if (skipIfUnavailable()) return;

			const columnsRaw = db.runSql(
				"SELECT column_name, data_type, column_default, is_nullable FROM information_schema.columns WHERE table_name = 'jobs' AND table_schema = 'public' ORDER BY ordinal_position;",
			);
			const rows = columnsRaw.split('\n').filter(Boolean);
			const columns: Record<string, { dataType: string; default: string; nullable: string }> = {};
			for (const row of rows) {
				const [name, dataType, colDefault, nullable] = row.split('|');
				columns[name] = { dataType, default: colDefault ?? '', nullable };
			}

			// Required columns per functional spec §4.3
			const expectedColumns = [
				'id',
				'type',
				'payload',
				'status',
				'attempts',
				'max_attempts',
				'error_log',
				'worker_id',
				'created_at',
				'started_at',
				'finished_at',
			];

			for (const col of expectedColumns) {
				expect(columns, `Missing column: ${col}`).toHaveProperty(col);
			}

			// Verify key types
			expect(columns.id.dataType).toBe('uuid');
			expect(columns.type.dataType).toBe('text');
			expect(columns.payload.dataType).toBe('jsonb');
			expect(columns.status.dataType).toBe('USER-DEFINED'); // enum
			expect(columns.attempts.dataType).toBe('integer');
			expect(columns.max_attempts.dataType).toBe('integer');
			expect(columns.created_at.dataType).toBe('timestamp with time zone');

			// Verify defaults
			expect(columns.id.default).toContain('gen_random_uuid');
			expect(columns.status.default).toContain('pending');
			expect(columns.attempts.default).toBe('0');
			expect(columns.max_attempts.default).toBe('3');

			// Verify NOT NULL constraints
			expect(columns.type.nullable).toBe('NO');
			expect(columns.payload.nullable).toBe('NO');
			expect(columns.status.nullable).toBe('NO');
		});
	});

	// ─── QA-04: Jobs queue index exists ───

	describe('QA-04: Jobs queue index exists', () => {
		it('partial index idx_jobs_queue exists on (status, created_at) WHERE status = pending', () => {
			if (skipIfUnavailable()) return;

			const indexDef = db.runSql("SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_jobs_queue';");

			expect(indexDef).toBeTruthy();
			// Should be a partial index on status and created_at
			expect(indexDef.toLowerCase()).toContain('status');
			expect(indexDef.toLowerCase()).toContain('created_at');
			// Should have WHERE clause for status = 'pending'
			expect(indexDef.toLowerCase()).toContain('where');
			expect(indexDef.toLowerCase()).toMatch(/pending/);
		});
	});

	// ─── QA-05: Pipeline runs table structure ───

	describe('QA-05: Pipeline runs table structure', () => {
		it('pipeline_runs table has all columns with correct types and defaults', () => {
			if (skipIfUnavailable()) return;

			const columnsRaw = db.runSql(
				"SELECT column_name, data_type, column_default, is_nullable FROM information_schema.columns WHERE table_name = 'pipeline_runs' AND table_schema = 'public' ORDER BY ordinal_position;",
			);
			const rows = columnsRaw.split('\n').filter(Boolean);
			const columns: Record<string, { dataType: string; default: string; nullable: string }> = {};
			for (const row of rows) {
				const [name, dataType, colDefault, nullable] = row.split('|');
				columns[name] = { dataType, default: colDefault ?? '', nullable };
			}

			// Required columns per functional spec §4.3
			const expectedColumns = ['id', 'tag', 'options', 'status', 'created_at', 'finished_at'];

			for (const col of expectedColumns) {
				expect(columns, `Missing column: ${col}`).toHaveProperty(col);
			}

			// Verify key types
			expect(columns.id.dataType).toBe('uuid');
			expect(columns.options.dataType).toBe('jsonb');
			expect(columns.status.dataType).toBe('text');
			expect(columns.created_at.dataType).toBe('timestamp with time zone');

			// Verify defaults
			expect(columns.id.default).toContain('gen_random_uuid');
			expect(columns.status.default).toContain('running');
			expect(columns.options.default).toContain('{}');
		});
	});

	// ─── QA-06: Pipeline run sources table structure ───

	describe('QA-06: Pipeline run sources table structure', () => {
		it('pipeline_run_sources has all columns, composite PK (run_id, source_id), FKs with CASCADE on run_id', () => {
			if (skipIfUnavailable()) return;

			const columnsRaw = db.runSql(
				"SELECT column_name FROM information_schema.columns WHERE table_name = 'pipeline_run_sources' AND table_schema = 'public' ORDER BY ordinal_position;",
			);
			const colList = columnsRaw.split('\n').filter(Boolean);

			const expectedColumns = ['run_id', 'source_id', 'current_step', 'status', 'error_message', 'updated_at'];

			for (const col of expectedColumns) {
				expect(colList, `Missing column: ${col}`).toContain(col);
			}

			// Verify composite PK (run_id, source_id)
			const pkColumns = db.runSql(
				"SELECT kcu.column_name FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name WHERE tc.table_name = 'pipeline_run_sources' AND tc.constraint_type = 'PRIMARY KEY' ORDER BY kcu.ordinal_position;",
			);
			const pkList = pkColumns.split('\n').filter(Boolean);
			expect(pkList).toContain('run_id');
			expect(pkList).toContain('source_id');

			// Verify FK to pipeline_runs
			const fkToPipelineRuns = db.runSql(
				"SELECT ccu.table_name FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name WHERE tc.table_name = 'pipeline_run_sources' AND tc.constraint_type = 'FOREIGN KEY' AND kcu.column_name = 'run_id';",
			);
			expect(fkToPipelineRuns).toContain('pipeline_runs');

			// Verify FK to sources
			const fkToSources = db.runSql(
				"SELECT ccu.table_name FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name WHERE tc.table_name = 'pipeline_run_sources' AND tc.constraint_type = 'FOREIGN KEY' AND kcu.column_name = 'source_id';",
			);
			expect(fkToSources).toContain('sources');

			// Verify CASCADE on run_id FK
			const cascadeOnRunId = db.runSql(
				"SELECT confdeltype FROM pg_constraint WHERE conrelid = 'pipeline_run_sources'::regclass AND contype = 'f' AND conname LIKE '%run_id%';",
			);
			// 'c' means CASCADE
			expect(cascadeOnRunId).toBe('c');
		});
	});

	// ─── QA-07: Reset pipeline step -- extract ───

	describe('QA-07: Reset pipeline step -- extract', () => {
		it('reset_pipeline_step(source_id, extract) deletes stories, clears source_steps, sets status to ingested', () => {
			if (skipIfUnavailable()) return;

			// Clean up any previous test data and seed fresh
			cleanupTestData();
			seedFullSource();

			// Verify pre-conditions
			const storiesBefore = db.runSql(`SELECT count(*) FROM stories WHERE source_id = '${SOURCE_ID_1}';`);
			expect(Number.parseInt(storiesBefore, 10)).toBe(2);

			const stepsBefore = db.runSql(`SELECT count(*) FROM source_steps WHERE source_id = '${SOURCE_ID_1}';`);
			expect(Number.parseInt(stepsBefore, 10)).toBe(5);

			// Call reset
			db.runSql(`SELECT reset_pipeline_step('${SOURCE_ID_1}', 'extract');`);

			// Stories deleted (cascading to chunks, story_entities, edges)
			const storiesAfter = db.runSql(`SELECT count(*) FROM stories WHERE source_id = '${SOURCE_ID_1}';`);
			expect(Number.parseInt(storiesAfter, 10)).toBe(0);

			// Chunks deleted (cascaded from stories)
			const chunksAfter = db.runSql(`SELECT count(*) FROM chunks WHERE story_id = '${STORY_ID_1}';`);
			expect(Number.parseInt(chunksAfter, 10)).toBe(0);

			// Story entities deleted (cascaded)
			const seAfter = db.runSql(
				`SELECT count(*) FROM story_entities WHERE story_id IN ('${STORY_ID_1}', '${STORY_ID_2}');`,
			);
			expect(Number.parseInt(seAfter, 10)).toBe(0);

			// Entity edges deleted (cascaded)
			const edgesAfter = db.runSql(
				`SELECT count(*) FROM entity_edges WHERE story_id IN ('${STORY_ID_1}', '${STORY_ID_2}');`,
			);
			expect(Number.parseInt(edgesAfter, 10)).toBe(0);

			// source_steps cleared (ALL steps)
			const stepsAfter = db.runSql(`SELECT count(*) FROM source_steps WHERE source_id = '${SOURCE_ID_1}';`);
			expect(Number.parseInt(stepsAfter, 10)).toBe(0);

			// source status = 'ingested'
			const sourceStatus = db.runSql(`SELECT status FROM sources WHERE id = '${SOURCE_ID_1}';`);
			expect(sourceStatus).toBe('ingested');

			// Clean up
			cleanupTestData();
		});
	});

	// ─── QA-08: Reset pipeline step -- segment ───

	describe('QA-08: Reset pipeline step -- segment', () => {
		it('reset_pipeline_step(source_id, segment) deletes stories, clears relevant source_steps, sets status to extracted', () => {
			if (skipIfUnavailable()) return;

			cleanupTestData();
			seedFullSource();

			// Call reset for segment
			db.runSql(`SELECT reset_pipeline_step('${SOURCE_ID_1}', 'segment');`);

			// Stories deleted
			const storiesAfter = db.runSql(`SELECT count(*) FROM stories WHERE source_id = '${SOURCE_ID_1}';`);
			expect(Number.parseInt(storiesAfter, 10)).toBe(0);

			// Relevant source_steps cleared (segment, enrich, embed, graph)
			const remainingSteps = db.runSql(
				`SELECT step_name FROM source_steps WHERE source_id = '${SOURCE_ID_1}' ORDER BY step_name;`,
			);
			const stepList = remainingSteps.split('\n').filter(Boolean);
			// Only 'extract' should remain
			expect(stepList).toContain('extract');
			expect(stepList).not.toContain('segment');
			expect(stepList).not.toContain('enrich');
			expect(stepList).not.toContain('embed');
			expect(stepList).not.toContain('graph');

			// source status = 'extracted'
			const sourceStatus = db.runSql(`SELECT status FROM sources WHERE id = '${SOURCE_ID_1}';`);
			expect(sourceStatus).toBe('extracted');

			cleanupTestData();
		});
	});

	// ─── QA-09: Reset pipeline step -- enrich ───

	describe('QA-09: Reset pipeline step -- enrich', () => {
		it('reset_pipeline_step(source_id, enrich) deletes story_entities and entity_edges, clears enrich/embed/graph steps, sets statuses to segmented', () => {
			if (skipIfUnavailable()) return;

			cleanupTestData();
			seedFullSource();

			// Call reset for enrich
			db.runSql(`SELECT reset_pipeline_step('${SOURCE_ID_1}', 'enrich');`);

			// story_entities deleted
			const seAfter = db.runSql(
				`SELECT count(*) FROM story_entities WHERE story_id IN ('${STORY_ID_1}', '${STORY_ID_2}');`,
			);
			expect(Number.parseInt(seAfter, 10)).toBe(0);

			// entity_edges deleted
			const edgesAfter = db.runSql(
				`SELECT count(*) FROM entity_edges WHERE story_id IN ('${STORY_ID_1}', '${STORY_ID_2}');`,
			);
			expect(Number.parseInt(edgesAfter, 10)).toBe(0);

			// source_steps for enrich/embed/graph cleared
			const remainingSteps = db.runSql(
				`SELECT step_name FROM source_steps WHERE source_id = '${SOURCE_ID_1}' ORDER BY step_name;`,
			);
			const stepList = remainingSteps.split('\n').filter(Boolean);
			expect(stepList).toContain('extract');
			expect(stepList).toContain('segment');
			expect(stepList).not.toContain('enrich');
			expect(stepList).not.toContain('embed');
			expect(stepList).not.toContain('graph');

			// stories status = 'segmented'
			const storyStatuses = db.runSql(`SELECT DISTINCT status FROM stories WHERE source_id = '${SOURCE_ID_1}';`);
			expect(storyStatuses).toBe('segmented');

			// source status = 'segmented'
			const sourceStatus = db.runSql(`SELECT status FROM sources WHERE id = '${SOURCE_ID_1}';`);
			expect(sourceStatus).toBe('segmented');

			cleanupTestData();
		});
	});

	// ─── QA-10: Reset pipeline step -- embed ───

	describe('QA-10: Reset pipeline step -- embed', () => {
		it('reset_pipeline_step(source_id, embed) deletes chunks, clears embed/graph steps, sets story status to enriched', () => {
			if (skipIfUnavailable()) return;

			cleanupTestData();
			seedFullSource();

			// Call reset for embed
			db.runSql(`SELECT reset_pipeline_step('${SOURCE_ID_1}', 'embed');`);

			// Chunks deleted
			const chunksAfter = db.runSql(
				`SELECT count(*) FROM chunks WHERE story_id IN ('${STORY_ID_1}', '${STORY_ID_2}');`,
			);
			expect(Number.parseInt(chunksAfter, 10)).toBe(0);

			// source_steps for embed/graph cleared
			const remainingSteps = db.runSql(
				`SELECT step_name FROM source_steps WHERE source_id = '${SOURCE_ID_1}' ORDER BY step_name;`,
			);
			const stepList = remainingSteps.split('\n').filter(Boolean);
			expect(stepList).toContain('extract');
			expect(stepList).toContain('segment');
			expect(stepList).toContain('enrich');
			expect(stepList).not.toContain('embed');
			expect(stepList).not.toContain('graph');

			// stories status = 'enriched'
			const storyStatuses = db.runSql(`SELECT DISTINCT status FROM stories WHERE source_id = '${SOURCE_ID_1}';`);
			expect(storyStatuses).toBe('enriched');

			cleanupTestData();
		});
	});

	// ─── QA-11: Reset pipeline step -- graph ───

	describe('QA-11: Reset pipeline step -- graph', () => {
		it('reset_pipeline_step(source_id, graph) deletes entity_edges, clears graph step, sets story status to embedded', () => {
			if (skipIfUnavailable()) return;

			cleanupTestData();
			seedFullSource();

			// Call reset for graph
			db.runSql(`SELECT reset_pipeline_step('${SOURCE_ID_1}', 'graph');`);

			// Entity edges deleted
			const edgesAfter = db.runSql(
				`SELECT count(*) FROM entity_edges WHERE story_id IN ('${STORY_ID_1}', '${STORY_ID_2}');`,
			);
			expect(Number.parseInt(edgesAfter, 10)).toBe(0);

			// source_steps for graph cleared
			const remainingSteps = db.runSql(
				`SELECT step_name FROM source_steps WHERE source_id = '${SOURCE_ID_1}' ORDER BY step_name;`,
			);
			const stepList = remainingSteps.split('\n').filter(Boolean);
			expect(stepList).toContain('extract');
			expect(stepList).toContain('segment');
			expect(stepList).toContain('enrich');
			expect(stepList).toContain('embed');
			expect(stepList).not.toContain('graph');

			// stories status = 'embedded'
			const storyStatuses = db.runSql(`SELECT DISTINCT status FROM stories WHERE source_id = '${SOURCE_ID_1}';`);
			expect(storyStatuses).toBe('embedded');

			cleanupTestData();
		});
	});

	// ─── QA-12: GC orphaned entities ───

	describe('QA-12: GC orphaned entities', () => {
		it('gc_orphaned_entities() deletes entities with no story_entities references and returns count', () => {
			if (skipIfUnavailable()) return;

			cleanupTestData();

			// Create a source and story for the linked entity
			db.runSql(
				`INSERT INTO sources (id, filename, storage_path, file_hash, status) VALUES ('${SOURCE_ID_1}', 'test-gc.pdf', 'gs://bucket/test-gc.pdf', 'hash_gc_spec09', 'completed');`,
			);
			db.runSql(
				`INSERT INTO stories (id, source_id, title, gcs_markdown_uri, gcs_metadata_uri, status) VALUES ('${STORY_ID_1}', '${SOURCE_ID_1}', 'GC Test Story', 'gs://bucket/gc.md', 'gs://bucket/gc.meta.json', 'completed');`,
			);

			// Create a non-orphaned entity (linked to a story)
			db.runSql(`INSERT INTO entities (id, name, type) VALUES ('${ENTITY_ID_1}', 'Linked Entity', 'person');`);
			db.runSql(
				`INSERT INTO story_entities (story_id, entity_id, mention_count) VALUES ('${STORY_ID_1}', '${ENTITY_ID_1}', 1);`,
			);

			// Create an orphaned entity (no story_entities references)
			db.runSql(`INSERT INTO entities (id, name, type) VALUES ('${ENTITY_ID_ORPHAN}', 'Orphaned Entity', 'location');`);

			// Verify pre-conditions
			const entitiesBefore = db.runSql(
				`SELECT count(*) FROM entities WHERE id IN ('${ENTITY_ID_1}', '${ENTITY_ID_ORPHAN}');`,
			);
			expect(Number.parseInt(entitiesBefore, 10)).toBe(2);

			// Call gc_orphaned_entities
			const deletedCount = db.runSql('SELECT gc_orphaned_entities();');
			expect(Number.parseInt(deletedCount, 10)).toBe(1);

			// Orphaned entity should be gone
			const orphanExists = db.runSql(`SELECT count(*) FROM entities WHERE id = '${ENTITY_ID_ORPHAN}';`);
			expect(Number.parseInt(orphanExists, 10)).toBe(0);

			// Non-orphaned entity should still exist
			const linkedExists = db.runSql(`SELECT count(*) FROM entities WHERE id = '${ENTITY_ID_1}';`);
			expect(Number.parseInt(linkedExists, 10)).toBe(1);

			cleanupTestData();
		});
	});

	// ─── QA-13: Idempotent migration ───

	describe('QA-13: Idempotent migration', () => {
		it('running migrations again when already applied produces no error', () => {
			if (skipIfUnavailable()) return;

			const { exitCode, stdout, stderr } = runCli(['db', 'migrate', EXAMPLE_CONFIG]);
			const combined = stdout + stderr;

			expect(exitCode).toBe(0);
			// Should indicate up-to-date or 0 applied
			expect(combined).toMatch(/up to date|applied 0|0.*applied|skipped/i);
		});
	});

	// ─── QA-14: FK cascade -- pipeline_run_sources ───

	describe('QA-14: FK cascade -- pipeline_run_sources', () => {
		it('deleting a pipeline_run cascades to pipeline_run_sources rows', () => {
			if (skipIfUnavailable()) return;

			cleanupTestData();

			// Create a source for FK reference
			db.runSql(
				`INSERT INTO sources (id, filename, storage_path, file_hash, status) VALUES ('${SOURCE_ID_1}', 'test-fk-cascade.pdf', 'gs://bucket/test-fk.pdf', 'hash_fk_spec09', 'pending');`,
			);

			// Create a pipeline_run
			db.runSql(
				`INSERT INTO pipeline_runs (id, tag, status) VALUES ('${PIPELINE_RUN_ID}', 'test-cascade-run', 'running');`,
			);

			// Create pipeline_run_sources referencing the run and source
			db.runSql(
				`INSERT INTO pipeline_run_sources (run_id, source_id, current_step, status) VALUES ('${PIPELINE_RUN_ID}', '${SOURCE_ID_1}', 'extract', 'pending');`,
			);

			// Verify pre-condition
			const prsBefore = db.runSql(`SELECT count(*) FROM pipeline_run_sources WHERE run_id = '${PIPELINE_RUN_ID}';`);
			expect(Number.parseInt(prsBefore, 10)).toBe(1);

			// Delete the pipeline_run
			db.runSql(`DELETE FROM pipeline_runs WHERE id = '${PIPELINE_RUN_ID}';`);

			// Verify cascade -- pipeline_run_sources should be gone
			const prsAfter = db.runSql(`SELECT count(*) FROM pipeline_run_sources WHERE run_id = '${PIPELINE_RUN_ID}';`);
			expect(Number.parseInt(prsAfter, 10)).toBe(0);

			cleanupTestData();
		});
	});
});
