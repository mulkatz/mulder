import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureSchema } from '../lib/schema.js';

const ROOT = resolve(import.meta.dirname, '../..');
const CLI = resolve(ROOT, 'apps/cli/dist/index.js');
const EXAMPLE_CONFIG = resolve(ROOT, 'mulder.config.example.yaml');

/**
 * Black-box QA tests for Spec 08: Core Schema Migrations (001-008)
 *
 * Each `it()` maps to one QA condition from Section 5 of the spec.
 * Tests interact through system boundaries only: CLI subprocess calls,
 * SQL via `docker exec psql`, and filesystem.
 * Never import from packages/ or src/ or apps/.
 *
 * Requires a running PostgreSQL instance (Docker container `mulder-pg-test`)
 * with pgvector, PostGIS, and pg_trgm extensions available.
 */

const PG_CONTAINER = 'mulder-pg-test';
const PG_USER = 'mulder';
const PG_PASSWORD = 'mulder';

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
		env: { ...process.env, PGPASSWORD: PG_PASSWORD, ...opts?.env },
	});
	return {
		stdout: result.stdout ?? '',
		stderr: result.stderr ?? '',
		exitCode: result.status ?? 1,
	};
}

/**
 * Helper: run SQL via docker exec psql. Returns query output.
 */
function runSql(sql: string): string {
	const result = spawnSync(
		'docker',
		['exec', PG_CONTAINER, 'psql', '-U', PG_USER, '-d', 'mulder', '-t', '-A', '-c', sql],
		{ encoding: 'utf-8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] },
	);
	if (result.status !== 0) {
		throw new Error(`psql failed (exit ${result.status}): ${result.stderr}`);
	}
	return (result.stdout ?? '').trim();
}

/**
 * Helper: run SQL, return null on failure instead of throwing.
 */
function runSqlSafe(sql: string): string | null {
	try {
		return runSql(sql);
	} catch {
		return null;
	}
}

function isPgAvailable(): boolean {
	try {
		const result = spawnSync('docker', ['exec', PG_CONTAINER, 'pg_isready', '-U', PG_USER], {
			encoding: 'utf-8',
			timeout: 5000,
		});
		return result.status === 0;
	} catch {
		return false;
	}
}

function hasRequiredExtensions(): boolean {
	try {
		const out = runSql("SELECT count(*) FROM pg_available_extensions WHERE name IN ('vector', 'postgis', 'pg_trgm');");
		return Number.parseInt(out, 10) >= 3;
	} catch {
		return false;
	}
}

function resetDatabase(): void {
	// Drop all core tables, extensions, types, functions, and migrations table
	// to get a fully clean state. We use individual DROP statements rather than
	// DROP SCHEMA CASCADE to avoid interfering with PostGIS system tables.
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
		'DROP TABLE IF EXISTS source_steps CASCADE',
		'DROP TABLE IF EXISTS sources CASCADE',
		'DROP TABLE IF EXISTS mulder_migrations CASCADE',
		'DROP EXTENSION IF EXISTS vector CASCADE',
		'DROP EXTENSION IF EXISTS postgis CASCADE',
		'DROP EXTENSION IF EXISTS pg_trgm CASCADE',
	].join('; ');

	spawnSync('docker', ['exec', PG_CONTAINER, 'psql', '-U', PG_USER, '-d', 'mulder', '-c', dropSql], {
		encoding: 'utf-8',
		timeout: 15000,
	});
}

describe('Spec 08: Core Schema Migrations (001-008)', () => {
	let pgAvailable: boolean;
	let extensionsAvailable: boolean;

	beforeAll(() => {
		pgAvailable = isPgAvailable();
		if (!pgAvailable) {
			console.warn(
				'SKIP: PostgreSQL container not available. Start with:\n' +
					'  docker run -d --name mulder-pg-test -e POSTGRES_USER=mulder ' +
					'-e POSTGRES_PASSWORD=mulder -e POSTGRES_DB=mulder -p 5432:5432 pgvector/pgvector:pg17\n' +
					'  docker exec mulder-pg-test apt-get update && docker exec mulder-pg-test apt-get install -y postgresql-17-postgis-3',
			);
			return;
		}

		extensionsAvailable = hasRequiredExtensions();
		if (!extensionsAvailable) {
			console.warn('SKIP: Required extensions (pgvector, PostGIS, pg_trgm) not available in PostgreSQL container.');
			return;
		}

		// Start with a clean database
		resetDatabase();

		// Run migrations once for the test suite
		const { exitCode, stdout, stderr } = runCli(['db', 'migrate', EXAMPLE_CONFIG]);
		if (exitCode !== 0) {
			throw new Error(`Initial migration failed (exit ${exitCode}):\n${stdout}\n${stderr}`);
		}
	});

	afterAll(() => {
		// Reset and re-migrate so downstream specs inherit a valid schema
		// regardless of file execution order.
		if (pgAvailable && extensionsAvailable) {
			resetDatabase();
			try {
				ensureSchema();
			} catch {
				// Downstream specs call ensureSchema() themselves; teardown must
				// not throw.
			}
		}
	});

	function skipIfUnavailable(): boolean {
		if (!pgAvailable || !extensionsAvailable) {
			return true;
		}
		return false;
	}

	// ─── QA-01: Extensions created ───

	describe('QA-01: Extensions created', () => {
		it('pgvector, PostGIS, and pg_trgm extensions exist after migration', () => {
			if (skipIfUnavailable()) return;

			const extensions = runSql('SELECT extname FROM pg_extension ORDER BY extname;');
			const extList = extensions.split('\n').filter(Boolean);

			expect(extList).toContain('vector');
			expect(extList).toContain('postgis');
			expect(extList).toContain('pg_trgm');
		});
	});

	// ─── QA-02: All migrations applied ───

	describe('QA-02: All migrations applied', () => {
		it('all migrations are reported as applied, 0 skipped on fresh database', () => {
			if (skipIfUnavailable()) return;

			// The beforeAll already ran migrations on a fresh DB.
			// Re-run to get the "already applied" status which confirms all were applied.
			const { stdout, stderr, exitCode } = runCli(['db', 'migrate', EXAMPLE_CONFIG]);
			const combined = stdout + stderr;

			expect(exitCode).toBe(0);
			// On re-run, all should be skipped (meaning all were already applied)
			expect(combined).toMatch(/skipped.*\d+|\d+.*skipped|up to date/i);

			// Verify via direct DB query — 001-008 + 012-014 = 11 migration files
			const count = runSql('SELECT count(*) FROM mulder_migrations;');
			expect(Number.parseInt(count, 10)).toBeGreaterThanOrEqual(8);
		});
	});

	// ─── QA-03: Sources table exists ───

	describe('QA-03: Sources table exists', () => {
		it('sources table has all required columns', () => {
			if (skipIfUnavailable()) return;

			const columns = runSql(
				"SELECT column_name FROM information_schema.columns WHERE table_name = 'sources' AND table_schema = 'public' ORDER BY ordinal_position;",
			);
			const colList = columns.split('\n').filter(Boolean);

			const requiredColumns = [
				'id',
				'filename',
				'storage_path',
				'file_hash',
				'page_count',
				'has_native_text',
				'native_text_ratio',
				'status',
				'reliability_score',
				'tags',
				'metadata',
				'created_at',
				'updated_at',
			];

			for (const col of requiredColumns) {
				expect(colList, `Missing column: ${col}`).toContain(col);
			}
		});
	});

	// ─── QA-04: Source_steps table exists ───

	describe('QA-04: Source_steps table exists', () => {
		it('source_steps table has all required columns with composite PK', () => {
			if (skipIfUnavailable()) return;

			const columns = runSql(
				"SELECT column_name FROM information_schema.columns WHERE table_name = 'source_steps' AND table_schema = 'public' ORDER BY ordinal_position;",
			);
			const colList = columns.split('\n').filter(Boolean);

			const requiredColumns = ['source_id', 'step_name', 'status', 'config_hash', 'completed_at', 'error_message'];

			for (const col of requiredColumns) {
				expect(colList, `Missing column: ${col}`).toContain(col);
			}

			// Verify composite PK (source_id, step_name)
			const pkColumns = runSql(
				"SELECT kcu.column_name FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name WHERE tc.table_name = 'source_steps' AND tc.constraint_type = 'PRIMARY KEY' ORDER BY kcu.ordinal_position;",
			);
			const pkList = pkColumns.split('\n').filter(Boolean);
			expect(pkList).toContain('source_id');
			expect(pkList).toContain('step_name');
		});
	});

	// ─── QA-05: Stories table exists ───

	describe('QA-05: Stories table exists', () => {
		it('stories table has all columns including GCS URIs, with FK to sources', () => {
			if (skipIfUnavailable()) return;

			const columns = runSql(
				"SELECT column_name FROM information_schema.columns WHERE table_name = 'stories' AND table_schema = 'public' ORDER BY ordinal_position;",
			);
			const colList = columns.split('\n').filter(Boolean);

			// Must have gcs_markdown_uri and gcs_metadata_uri
			expect(colList, 'Missing gcs_markdown_uri').toContain('gcs_markdown_uri');
			expect(colList, 'Missing gcs_metadata_uri').toContain('gcs_metadata_uri');
			expect(colList, 'Missing source_id').toContain('source_id');

			// Verify FK to sources
			const fkRef = runSql(
				"SELECT ccu.table_name FROM information_schema.table_constraints tc JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name WHERE tc.table_name = 'stories' AND tc.constraint_type = 'FOREIGN KEY' AND ccu.table_name = 'sources';",
			);
			expect(fkRef).toBe('sources');
		});
	});

	// ─── QA-06: Entities + aliases tables exist ───

	describe('QA-06: Entities + aliases tables exist', () => {
		it('entities has self-referential canonical_id FK; entity_aliases has UNIQUE(entity_id, alias)', () => {
			if (skipIfUnavailable()) return;

			// Entities table must have canonical_id with self-referential FK
			const entityFk = runSql(
				"SELECT ccu.table_name, ccu.column_name FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name WHERE tc.table_name = 'entities' AND tc.constraint_type = 'FOREIGN KEY' AND kcu.column_name = 'canonical_id';",
			);
			// Should reference entities.id (self-referential)
			expect(entityFk).toContain('entities');
			expect(entityFk).toContain('id');

			// entity_aliases must have UNIQUE(entity_id, alias)
			const uniqueConstraint = runSql(
				"SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'entity_aliases'::regclass AND contype = 'u';",
			);
			expect(uniqueConstraint).toContain('entity_id');
			expect(uniqueConstraint).toContain('alias');
		});
	});

	// ─── QA-07: Relationship tables exist ───

	describe('QA-07: Relationship tables exist', () => {
		it('story_entities has composite PK (story_id, entity_id); entity_edges has FKs to entities and stories', () => {
			if (skipIfUnavailable()) return;

			// story_entities composite PK
			const sePk = runSql(
				"SELECT kcu.column_name FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name WHERE tc.table_name = 'story_entities' AND tc.constraint_type = 'PRIMARY KEY' ORDER BY kcu.ordinal_position;",
			);
			const sePkList = sePk.split('\n').filter(Boolean);
			expect(sePkList).toContain('story_id');
			expect(sePkList).toContain('entity_id');

			// entity_edges FKs to entities and stories
			const edgeFks = runSql(
				"SELECT kcu.column_name, ccu.table_name as ref_table FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name WHERE tc.table_name = 'entity_edges' AND tc.constraint_type = 'FOREIGN KEY';",
			);
			// Should reference both entities and stories
			expect(edgeFks).toContain('entities');
			expect(edgeFks).toContain('stories');
		});
	});

	// ─── QA-08: Chunks table with vector + FTS ───

	describe('QA-08: Chunks table with vector + FTS', () => {
		it('chunks table has embedding vector(768) column and fts_vector tsvector generated column', () => {
			if (skipIfUnavailable()) return;

			// Check embedding column type
			const embeddingType = runSql(
				"SELECT udt_name FROM information_schema.columns WHERE table_name = 'chunks' AND column_name = 'embedding';",
			);
			expect(embeddingType).toBe('vector');

			// Verify it's vector(768) by checking the full column definition
			const vectorDef = runSql(
				"SELECT format_type(atttypid, atttypmod) FROM pg_attribute WHERE attrelid = 'chunks'::regclass AND attname = 'embedding';",
			);
			expect(vectorDef).toBe('vector(768)');

			// Check fts_vector column type
			const ftsType = runSql(
				"SELECT udt_name FROM information_schema.columns WHERE table_name = 'chunks' AND column_name = 'fts_vector';",
			);
			expect(ftsType).toBe('tsvector');

			// Verify fts_vector is a generated column
			const isGenerated = runSql(
				"SELECT is_generated FROM information_schema.columns WHERE table_name = 'chunks' AND column_name = 'fts_vector';",
			);
			expect(isGenerated).toBe('ALWAYS');
		});
	});

	// ─── QA-09: Taxonomy table exists ───

	describe('QA-09: Taxonomy table exists', () => {
		it('taxonomy table has UNIQUE(canonical_name, entity_type)', () => {
			if (skipIfUnavailable()) return;

			// Check table exists
			const tableExists = runSql(
				"SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'taxonomy' AND table_schema = 'public');",
			);
			expect(tableExists).toBe('t');

			// Check UNIQUE constraint on (canonical_name, entity_type)
			const uniqueConstraint = runSql(
				"SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'taxonomy'::regclass AND contype = 'u';",
			);
			expect(uniqueConstraint).toContain('canonical_name');
			expect(uniqueConstraint).toContain('entity_type');
		});
	});

	// ─── QA-10: Indexes created ───

	describe('QA-10: Indexes created', () => {
		it('all expected indexes exist in pg_indexes', () => {
			if (skipIfUnavailable()) return;

			const indexes = runSql("SELECT indexname FROM pg_indexes WHERE schemaname = 'public' ORDER BY indexname;");
			const indexList = indexes.split('\n').filter(Boolean);

			const expectedIndexes = [
				'idx_sources_status',
				'idx_chunks_embedding',
				'idx_chunks_fts',
				'idx_entities_name_trgm',
				'idx_chunks_story',
				'idx_stories_source',
				'idx_stories_status',
				'idx_entities_canonical',
				'idx_entities_type',
				'idx_entity_edges_source',
				'idx_entity_edges_target',
				'idx_entity_edges_type',
				'idx_taxonomy_name_trgm',
			];

			for (const idx of expectedIndexes) {
				expect(indexList, `Missing index: ${idx}`).toContain(idx);
			}
		});
	});

	// ─── QA-11: HNSW index (not ivfflat) ───

	describe('QA-11: HNSW index (not ivfflat)', () => {
		it('idx_chunks_embedding uses hnsw access method, not ivfflat', () => {
			if (skipIfUnavailable()) return;

			// Check the access method of the index
			const method = runSql(
				"SELECT am.amname FROM pg_index idx JOIN pg_class cls ON idx.indexrelid = cls.oid JOIN pg_am am ON cls.relam = am.oid WHERE cls.relname = 'idx_chunks_embedding';",
			);
			expect(method).toBe('hnsw');
			expect(method).not.toBe('ivfflat');

			// Also confirm from the indexdef
			const indexDef = runSql("SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_chunks_embedding';");
			expect(indexDef.toLowerCase()).toContain('hnsw');
			expect(indexDef.toLowerCase()).not.toContain('ivfflat');
		});
	});

	// ─── QA-12: Idempotent re-run ───

	describe('QA-12: Idempotent re-run', () => {
		it('running db migrate again results in 0 applied, all skipped, no errors', () => {
			if (skipIfUnavailable()) return;

			const { stdout, stderr, exitCode } = runCli(['db', 'migrate', EXAMPLE_CONFIG]);
			const combined = stdout + stderr;

			expect(exitCode).toBe(0);

			// Should indicate up-to-date or 0 applied
			expect(combined).toMatch(/up to date|applied 0|0.*applied/i);

			// Parse the structured log for exact counts
			const logLine = combined.split('\n').find((line) => line.includes('"msg":"Migration run complete"'));
			if (logLine) {
				const parsed = JSON.parse(logLine);
				expect(parsed.applied).toBe(0);
				// 001-008 + 012-014 = 11 migration files
				expect(parsed.skipped).toBeGreaterThanOrEqual(8);
				expect(parsed.total).toBeGreaterThanOrEqual(8);
			}
		});
	});

	// ─── QA-13: Migration status correct ───

	describe('QA-13: Migration status correct', () => {
		it('mulder db status shows all 8 migrations as applied with timestamps', () => {
			if (skipIfUnavailable()) return;

			const { stdout, stderr, exitCode } = runCli(['db', 'status', EXAMPLE_CONFIG]);
			const combined = stdout + stderr;

			expect(exitCode).toBe(0);

			// All 8 migration files should appear
			const migrationFiles = [
				'001_extensions.sql',
				'002_sources.sql',
				'003_stories.sql',
				'004_entities.sql',
				'005_relationships.sql',
				'006_chunks.sql',
				'007_taxonomy.sql',
				'008_indexes.sql',
			];

			for (const file of migrationFiles) {
				expect(combined, `Migration ${file} not in status output`).toContain(file);
			}

			// Each should show as "applied"
			for (const file of migrationFiles) {
				// Find the line containing the filename and verify it says "applied"
				const lines = combined.split('\n');
				const fileLine = lines.find((l) => l.includes(file));
				expect(fileLine, `No status line for ${file}`).toBeDefined();
				expect(fileLine?.toLowerCase(), `${file} not shown as applied`).toContain('applied');
			}

			// Timestamps should be present (ISO date format)
			const timestampPattern = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
			const lines = combined.split('\n').filter((l) => l.includes('.sql'));
			for (const line of lines) {
				expect(line, `No timestamp in line: ${line}`).toMatch(timestampPattern);
			}
		});
	});

	// ─── QA-14: FK cascades work ───

	describe('QA-14: FK cascades work', () => {
		it('deleting a source row cascades to its source_steps rows', () => {
			if (skipIfUnavailable()) return;

			// Insert a test source
			runSql(
				"INSERT INTO sources (id, filename, storage_path, file_hash, status) VALUES ('00000000-0000-0000-0000-000000000001', 'test-cascade.pdf', 'gs://bucket/test.pdf', 'hash_cascade_test', 'pending');",
			);

			// Insert source_steps referencing that source
			runSql(
				"INSERT INTO source_steps (source_id, step_name, status) VALUES ('00000000-0000-0000-0000-000000000001', 'extract', 'completed');",
			);
			runSql(
				"INSERT INTO source_steps (source_id, step_name, status) VALUES ('00000000-0000-0000-0000-000000000001', 'segment', 'pending');",
			);

			// Verify source_steps exist
			const stepCount = runSql(
				"SELECT count(*) FROM source_steps WHERE source_id = '00000000-0000-0000-0000-000000000001';",
			);
			expect(Number.parseInt(stepCount, 10)).toBe(2);

			// Delete the source
			runSql("DELETE FROM sources WHERE id = '00000000-0000-0000-0000-000000000001';");

			// Verify source_steps were cascaded
			const remainingSteps = runSql(
				"SELECT count(*) FROM source_steps WHERE source_id = '00000000-0000-0000-0000-000000000001';",
			);
			expect(Number.parseInt(remainingSteps, 10)).toBe(0);
		});
	});

	// ─── QA-15: File_hash uniqueness enforced ───

	describe('QA-15: File_hash uniqueness enforced', () => {
		it('inserting two sources with the same file_hash fails with unique constraint violation', () => {
			if (skipIfUnavailable()) return;

			// Insert first source
			runSql(
				"INSERT INTO sources (id, filename, storage_path, file_hash, status) VALUES ('00000000-0000-0000-0000-000000000002', 'first.pdf', 'gs://bucket/first.pdf', 'hash_unique_test', 'pending');",
			);

			// Try to insert second source with same file_hash — should fail
			const result = runSqlSafe(
				"INSERT INTO sources (id, filename, storage_path, file_hash, status) VALUES ('00000000-0000-0000-0000-000000000003', 'second.pdf', 'gs://bucket/second.pdf', 'hash_unique_test', 'pending');",
			);

			// runSqlSafe returns null when psql exits non-zero (constraint violation)
			expect(result).toBeNull();

			// Verify only one row exists with that hash
			const count = runSql("SELECT count(*) FROM sources WHERE file_hash = 'hash_unique_test';");
			expect(Number.parseInt(count, 10)).toBe(1);

			// Cleanup
			runSql("DELETE FROM sources WHERE file_hash = 'hash_unique_test';");
		});
	});
});
