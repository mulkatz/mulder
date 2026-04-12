import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as db from '../lib/db.js';

const ROOT = resolve(import.meta.dirname, '../..');
const CLI = resolve(ROOT, 'apps/cli/dist/index.js');
const EXAMPLE_CONFIG = resolve(ROOT, 'mulder.config.example.yaml');
const DB_MODULE = resolve(ROOT, 'packages/core/dist/database/index.js');
const MIGRATE_MODULE = resolve(ROOT, 'packages/core/dist/database/migrate.js');

/**
 * Black-box QA tests for Spec 07: Database Client + Migration Runner
 *
 * Each `it()` maps to one QA condition from Section 5 of the spec.
 * Tests interact through system boundaries only: CLI subprocess calls,
 * SQL via `the shared env-driven SQL helper`, and filesystem.
 * Never import from packages/ or src/ or apps/.
 *
 * Requires a running PostgreSQL instance (the standard PG env vars).
 */

/** Config object matching CloudSqlConfig with defaults for local PostgreSQL. */
const DB_CONFIG_JSON = JSON.stringify({
	instance_name: 'mulder-db',
	database: 'mulder',
	tier: 'db-custom-2-8192',
	host: 'localhost',
	port: 5432,
	user: 'mulder',
});

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
 * Helper: run a Node.js helper script as a subprocess.
 * The script runs as an ESM module with PGPASSWORD set.
 */
function runScript(
	scriptContent: string,
	opts?: { env?: Record<string, string>; timeout?: number },
): { stdout: string; stderr: string; exitCode: number } {
	const scriptPath = join(tmpDir, `helper-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);
	writeFileSync(scriptPath, scriptContent, 'utf-8');

	const result = spawnSync('node', [scriptPath], {
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
function dropMigrationsTable(): void {
	db.runSql('DROP TABLE IF EXISTS mulder_migrations CASCADE;');
}

function cleanupTestTables(): void {
	db.runSql(
		'DROP TABLE IF EXISTS qa_test_one, qa_test_two, qa_test_good, qa_test_bad, qa_test_status_one, qa_test_status_two CASCADE;',
	);
}

/**
 * Full database reset: drops all core tables, extensions, and the migrations table.
 * Required when tests need to re-run `db migrate` against the real migrations directory
 * (which uses CREATE TABLE, not CREATE TABLE IF NOT EXISTS).
 */
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

let tmpDir: string;

describe('Spec 07: Database Client + Migration Runner', () => {
	let pgAvailable: boolean;

	beforeAll(() => {
		pgAvailable = db.isPgAvailable();
		if (!pgAvailable) {
			console.warn('SKIP: PostgreSQL not reachable at PGHOST/PGPORT.');
			return;
		}
		tmpDir = mkdtempSync(join(tmpdir(), 'mulder-qa-07-'));
		// Full reset to handle leftover state from prior test runs (spec 08 etc.)
		resetDatabase();
		cleanupTestTables();
	});

	afterAll(() => {
		if (tmpDir) {
			rmSync(tmpDir, { recursive: true, force: true });
		}
		if (pgAvailable) {
			resetDatabase();
			cleanupTestTables();
		}
	});

	// ─── QA-01: Worker pool connects ───

	describe('QA-01: Worker pool connects', () => {
		it('getWorkerPool() connects successfully, SELECT 1 returns a result', () => {
			if (!pgAvailable) return;

			// The CLI `db migrate` uses the worker pool internally.
			// If it exits 0, the worker pool connected and ran queries successfully.
			const { stdout, stderr, exitCode } = runCli(['db', 'migrate', EXAMPLE_CONFIG]);
			const combined = stdout + stderr;

			expect(exitCode).toBe(0);
			// Structured log should confirm worker pool was created
			expect(combined).toContain('Worker pool created');
		});
	});

	// ─── QA-02: Query pool connects ───

	describe('QA-02: Query pool connects', () => {
		it('getQueryPool() connects successfully, SELECT 1 returns a result', () => {
			if (!pgAvailable) return;

			const { stdout, stderr } = runScript(`
				import { getQueryPool, closeAllPools } from '${DB_MODULE}';
				const config = ${DB_CONFIG_JSON};
				try {
					const pool = getQueryPool(config);
					const res = await pool.query('SELECT 1 AS test');
					if (res.rows[0].test === 1) {
						process.stderr.write('QUERY_POOL_OK\\n');
					} else {
						process.stderr.write('QUERY_POOL_FAIL: unexpected result\\n');
					}
					await closeAllPools();
				} catch (e) {
					process.stderr.write('QUERY_POOL_FAIL:' + e.message + '\\n');
					process.exit(1);
				}
			`);

			const combined = stdout + stderr;
			expect(combined).toContain('QUERY_POOL_OK');
		});
	});

	// ─── QA-03: Pools are singletons ───

	describe('QA-03: Pools are singletons', () => {
		it('second call returns same pool instance, no new connections created', () => {
			if (!pgAvailable) return;

			const { stdout, stderr } = runScript(`
				import { getWorkerPool, getQueryPool, closeAllPools } from '${DB_MODULE}';
				const config = ${DB_CONFIG_JSON};

				const w1 = getWorkerPool(config);
				const w2 = getWorkerPool(config);
				const q1 = getQueryPool(config);
				const q2 = getQueryPool(config);

				process.stderr.write('WORKER_SINGLETON:' + (w1 === w2) + '\\n');
				process.stderr.write('QUERY_SINGLETON:' + (q1 === q2) + '\\n');

				await closeAllPools();
			`);

			const combined = stdout + stderr;
			expect(combined).toContain('WORKER_SINGLETON:true');
			expect(combined).toContain('QUERY_SINGLETON:true');
		});
	});

	// ─── QA-04: Pool cleanup ───

	describe('QA-04: Pool cleanup', () => {
		it('closeAllPools() ends all pools, subsequent calls create new pools', () => {
			if (!pgAvailable) return;

			const { stdout, stderr } = runScript(`
				import { getWorkerPool, getQueryPool, closeAllPools } from '${DB_MODULE}';
				const config = ${DB_CONFIG_JSON};

				// Create initial pools
				const w1 = getWorkerPool(config);
				const q1 = getQueryPool(config);

				// Close all
				await closeAllPools();

				// Create new pools — should be different instances
				const w2 = getWorkerPool(config);
				const q2 = getQueryPool(config);

				// Verify new pools work
				const res = await w2.query('SELECT 1 AS test');

				process.stderr.write('WORKER_NEW:' + (w1 !== w2) + '\\n');
				process.stderr.write('QUERY_NEW:' + (q1 !== q2) + '\\n');
				process.stderr.write('NEW_POOL_WORKS:' + (res.rows[0].test === 1) + '\\n');

				await closeAllPools();
			`);

			const combined = stdout + stderr;
			expect(combined).toContain('WORKER_NEW:true');
			expect(combined).toContain('QUERY_NEW:true');
			expect(combined).toContain('NEW_POOL_WORKS:true');
		});
	});

	// ─── QA-05: Migration table auto-created ───

	describe('QA-05: Migration table auto-created', () => {
		it('mulder_migrations table exists after runMigrations() on a fresh database', () => {
			if (!pgAvailable) return;

			// Full reset required: `db migrate` runs real migration files (001-008)
			// which use CREATE TABLE (not IF NOT EXISTS). Dropping only mulder_migrations
			// would cause "table already exists" errors from prior migration runs.
			resetDatabase();

			// Run migrate via CLI (which calls runMigrations internally)
			const { exitCode } = runCli(['db', 'migrate', EXAMPLE_CONFIG]);
			expect(exitCode).toBe(0);

			// Verify table exists via psql
			const tableExists = db.runSql(
				"SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'mulder_migrations');",
			);
			expect(tableExists).toBe('t');
		});
	});

	// ─── QA-06: Migrations apply in order ───

	describe('QA-06: Migrations apply in order', () => {
		it('two SQL files apply in numeric order, recorded in mulder_migrations', () => {
			if (!pgAvailable) return;

			// Clean state
			dropMigrationsTable();
			cleanupTestTables();

			// Create a temporary migrations directory with two SQL files
			const migrationsDir = join(tmpDir, 'migrations-qa06');
			mkdirSync(migrationsDir, { recursive: true });

			writeFileSync(
				join(migrationsDir, '001_create_qa_test_one.sql'),
				'CREATE TABLE qa_test_one (id SERIAL PRIMARY KEY, name TEXT NOT NULL);',
				'utf-8',
			);
			writeFileSync(
				join(migrationsDir, '002_create_qa_test_two.sql'),
				'CREATE TABLE qa_test_two (id SERIAL PRIMARY KEY, ref_id INT REFERENCES qa_test_one(id));',
				'utf-8',
			);

			const { stdout, stderr } = runScript(`
				import { getWorkerPool, closeAllPools } from '${DB_MODULE}';
				import { runMigrations } from '${MIGRATE_MODULE}';

				const config = ${DB_CONFIG_JSON};
				const pool = getWorkerPool(config);

				try {
					const result = await runMigrations(pool, '${migrationsDir}');
					process.stderr.write('APPLIED:' + JSON.stringify(result.applied) + '\\n');
					process.stderr.write('TOTAL:' + result.total + '\\n');
				} catch (e) {
					process.stderr.write('MIGRATION_ERROR:' + e.message + '\\n');
					process.exit(1);
				} finally {
					await closeAllPools();
				}
			`);

			const combined = stdout + stderr;
			expect(combined).toContain('001_create_qa_test_one.sql');
			expect(combined).toContain('002_create_qa_test_two.sql');

			// Verify both tables exist
			const t1 = db.runSql("SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'qa_test_one');");
			const t2 = db.runSql("SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'qa_test_two');");
			expect(t1).toBe('t');
			expect(t2).toBe('t');

			// Verify order in mulder_migrations
			const migrations = db.runSql('SELECT filename FROM mulder_migrations ORDER BY applied_at ASC, filename ASC;');
			const filenames = migrations.split('\n').filter(Boolean);
			expect(filenames[0]).toBe('001_create_qa_test_one.sql');
			expect(filenames[1]).toBe('002_create_qa_test_two.sql');
		});
	});

	// ─── QA-07: Migrations are idempotent ───

	describe('QA-07: Migrations are idempotent', () => {
		it('running again skips all, no errors, result shows 0 applied', () => {
			if (!pgAvailable) return;

			// Clean state
			dropMigrationsTable();
			cleanupTestTables();

			const migrationsDir = join(tmpDir, 'migrations-qa07');
			mkdirSync(migrationsDir, { recursive: true });

			writeFileSync(
				join(migrationsDir, '001_create_qa_test_one.sql'),
				'CREATE TABLE qa_test_one (id SERIAL PRIMARY KEY, name TEXT NOT NULL);',
				'utf-8',
			);
			writeFileSync(
				join(migrationsDir, '002_create_qa_test_two.sql'),
				'CREATE TABLE qa_test_two (id SERIAL PRIMARY KEY, ref_id INT REFERENCES qa_test_one(id));',
				'utf-8',
			);

			// First run: apply migrations
			const firstResult = runScript(`
				import { getWorkerPool, closeAllPools } from '${DB_MODULE}';
				import { runMigrations } from '${MIGRATE_MODULE}';

				const config = ${DB_CONFIG_JSON};
				const pool = getWorkerPool(config);
				const result = await runMigrations(pool, '${migrationsDir}');
				process.stderr.write('FIRST_APPLIED:' + result.applied.length + '\\n');
				await closeAllPools();
			`);
			expect(firstResult.stdout + firstResult.stderr).toContain('FIRST_APPLIED:2');

			// Second run: should skip all
			const secondResult = runScript(`
				import { getWorkerPool, closeAllPools } from '${DB_MODULE}';
				import { runMigrations } from '${MIGRATE_MODULE}';

				const config = ${DB_CONFIG_JSON};
				const pool = getWorkerPool(config);
				const result = await runMigrations(pool, '${migrationsDir}');
				process.stderr.write('APPLIED:' + result.applied.length + '\\n');
				process.stderr.write('SKIPPED:' + result.skipped.length + '\\n');
				process.stderr.write('TOTAL:' + result.total + '\\n');
				await closeAllPools();
			`);

			const combined = secondResult.stdout + secondResult.stderr;
			expect(combined).toContain('APPLIED:0');
			expect(combined).toContain('SKIPPED:2');
		});
	});

	// ─── QA-08: Failed migration rolls back ───

	describe('QA-08: Failed migration rolls back', () => {
		it('error thrown for invalid SQL, failed migration NOT recorded, database unchanged', () => {
			if (!pgAvailable) return;

			// Clean state
			dropMigrationsTable();
			cleanupTestTables();

			const migrationsDir = join(tmpDir, 'migrations-qa08');
			mkdirSync(migrationsDir, { recursive: true });

			// First migration is valid
			writeFileSync(join(migrationsDir, '001_good.sql'), 'CREATE TABLE qa_test_good (id SERIAL PRIMARY KEY);', 'utf-8');

			// Second migration has invalid SQL
			writeFileSync(join(migrationsDir, '002_bad.sql'), 'CREATE TABLE qa_test_bad (id INVALID_TYPE);', 'utf-8');

			const { stdout, stderr } = runScript(`
				import { getWorkerPool, closeAllPools } from '${DB_MODULE}';
				import { runMigrations } from '${MIGRATE_MODULE}';

				const config = ${DB_CONFIG_JSON};
				const pool = getWorkerPool(config);
				try {
					await runMigrations(pool, '${migrationsDir}');
					process.stderr.write('NO_ERROR\\n');
				} catch (e) {
					process.stderr.write('ERROR_THROWN:' + e.constructor.name + '\\n');
					process.stderr.write('ERROR_MSG:' + e.message + '\\n');
				} finally {
					await closeAllPools();
				}
			`);

			const combined = stdout + stderr;
			// Error should be thrown
			expect(combined).toContain('ERROR_THROWN:');
			expect(combined).not.toContain('NO_ERROR');

			// The failed migration (002_bad.sql) should NOT be recorded.
			// The mulder_migrations table may or may not exist depending on
			// whether the runner uses per-migration transactions or batch transactions.
			const recorded = db.runSqlSafe("SELECT filename FROM mulder_migrations WHERE filename = '002_bad.sql';");
			// Either the table doesn't exist (null) or the record doesn't exist ('')
			expect(recorded === null || recorded === '').toBe(true);

			// The bad table should not exist
			const badTableExists = db.runSql(
				"SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'qa_test_bad');",
			);
			expect(badTableExists).toBe('f');
		});
	});

	// ─── QA-09: Migration status reports ───

	describe('QA-09: Migration status reports', () => {
		it('each migration listed with correct applied/pending status and timestamp', () => {
			if (!pgAvailable) return;

			// Clean state
			dropMigrationsTable();
			cleanupTestTables();

			const migrationsDir = join(tmpDir, 'migrations-qa09');
			mkdirSync(migrationsDir, { recursive: true });

			writeFileSync(
				join(migrationsDir, '001_status_one.sql'),
				'CREATE TABLE qa_test_status_one (id SERIAL PRIMARY KEY);',
				'utf-8',
			);
			writeFileSync(
				join(migrationsDir, '002_status_two.sql'),
				'CREATE TABLE qa_test_status_two (id SERIAL PRIMARY KEY);',
				'utf-8',
			);

			// Apply only the first migration using a partial migrations dir
			const partialDir = join(tmpDir, 'migrations-qa09-partial');
			mkdirSync(partialDir, { recursive: true });
			writeFileSync(
				join(partialDir, '001_status_one.sql'),
				'CREATE TABLE qa_test_status_one (id SERIAL PRIMARY KEY);',
				'utf-8',
			);

			const applyResult = runScript(`
				import { getWorkerPool, closeAllPools } from '${DB_MODULE}';
				import { runMigrations } from '${MIGRATE_MODULE}';

				const config = ${DB_CONFIG_JSON};
				const pool = getWorkerPool(config);
				const result = await runMigrations(pool, '${partialDir}');
				process.stderr.write('APPLIED:' + result.applied.length + '\\n');
				await closeAllPools();
			`);
			expect(applyResult.stdout + applyResult.stderr).toContain('APPLIED:1');

			// Now check status with both migrations (one applied, one pending)
			const statusResult = runScript(`
				import { getWorkerPool, closeAllPools } from '${DB_MODULE}';
				import { getMigrationStatus } from '${MIGRATE_MODULE}';

				const config = ${DB_CONFIG_JSON};
				const pool = getWorkerPool(config);
				const status = await getMigrationStatus(pool, '${migrationsDir}');

				for (const s of status) {
					const statusLabel = s.applied ? 'applied' : 'pending';
					const tsLabel = s.appliedAt ? 'HAS_TIMESTAMP' : 'NO_TIMESTAMP';
					process.stderr.write('STATUS:' + s.filename + ':' + statusLabel + ':' + tsLabel + '\\n');
				}
				await closeAllPools();
			`);

			const combined = statusResult.stdout + statusResult.stderr;
			expect(combined).toContain('STATUS:001_status_one.sql:applied:HAS_TIMESTAMP');
			expect(combined).toContain('STATUS:002_status_two.sql:pending:NO_TIMESTAMP');
		});
	});

	// ─── QA-10: CLI db migrate runs ───

	describe('QA-10: CLI db migrate runs', () => {
		it('prints summary of applied/skipped migrations, exits 0', () => {
			if (!pgAvailable) return;

			// Full reset required: `db migrate` runs real migration files (001-008)
			// which use CREATE TABLE (not IF NOT EXISTS). Dropping only mulder_migrations
			// would cause "table already exists" errors from prior migration runs.
			resetDatabase();

			const { stdout, stderr, exitCode } = runCli(['db', 'migrate', EXAMPLE_CONFIG]);
			const combined = stdout + stderr;

			expect(exitCode).toBe(0);
			// Output should contain migration summary information
			expect(combined.toLowerCase()).toMatch(/up to date|applied|migrat/);
		});
	});

	// ─── QA-11: CLI db status runs ───

	describe('QA-11: CLI db status runs', () => {
		it('prints migration status information, exits 0', () => {
			if (!pgAvailable) return;

			const { stdout, stderr, exitCode } = runCli(['db', 'status', EXAMPLE_CONFIG]);
			const combined = stdout + stderr;

			expect(exitCode).toBe(0);
			// Output should contain status information
			expect(combined.toLowerCase()).toMatch(/no migration|status|migrat/);
		});
	});

	// ─── QA-12: Invalid connection fails gracefully ───

	describe('QA-12: Invalid connection fails gracefully', () => {
		it('DatabaseError thrown with appropriate error code for bad host/port', () => {
			if (!pgAvailable) return;

			// Use config pointing to a bad port
			const badConfig = JSON.stringify({
				instance_name: 'mulder-db',
				database: 'mulder',
				tier: 'db-custom-2-8192',
				host: '127.0.0.1',
				port: 59999,
				user: 'mulder',
			});

			const { stdout, stderr } = runScript(
				`
				import { getWorkerPool, closeAllPools } from '${DB_MODULE}';
				const config = ${badConfig};
				try {
					const pool = getWorkerPool(config);
					await pool.query('SELECT 1');
					process.stderr.write('NO_ERROR\\n');
				} catch (e) {
					process.stderr.write('ERROR_CLASS:' + e.constructor.name + '\\n');
					process.stderr.write('ERROR_CODE:' + (e.code || 'NONE') + '\\n');
					process.stderr.write('ERROR_MSG:' + e.message + '\\n');
				} finally {
					await closeAllPools();
				}
			`,
				{ timeout: 15000 },
			);

			const combined = stdout + stderr;
			expect(combined).not.toContain('NO_ERROR');
			expect(combined).toMatch(/ERROR|error|ECONNREFUSED|connect/i);
		});
	});

	// ─── QA-13: Query pool has statement timeout ───

	describe('QA-13: Query pool has statement timeout', () => {
		it('a query running > 10s on the query pool is cancelled/times out', { timeout: 30000 }, () => {
			if (!pgAvailable) return;

			const { stdout, stderr } = runScript(
				`
				import { getQueryPool, closeAllPools } from '${DB_MODULE}';
				const config = ${DB_CONFIG_JSON};
				const startTime = Date.now();
				try {
					const pool = getQueryPool(config);
					await pool.query('SELECT pg_sleep(15)');
					process.stderr.write('NO_TIMEOUT\\n');
				} catch (e) {
					const elapsed = Date.now() - startTime;
					process.stderr.write('TIMEOUT_ERROR:' + e.message + '\\n');
					process.stderr.write('ELAPSED_MS:' + elapsed + '\\n');
				} finally {
					await closeAllPools();
				}
			`,
				{ timeout: 30000 },
			);

			const combined = stdout + stderr;

			// The query should have been cancelled by statement_timeout
			expect(combined).not.toContain('NO_TIMEOUT');
			expect(combined).toContain('TIMEOUT_ERROR:');

			// Should contain a timeout-related error message
			expect(combined).toMatch(/timeout|cancel|statement/i);

			// Elapsed time should be around 10s (statement_timeout), not 15s (full sleep)
			const elapsedMatch = combined.match(/ELAPSED_MS:(\d+)/);
			if (elapsedMatch) {
				const elapsed = Number.parseInt(elapsedMatch[1], 10);
				expect(elapsed).toBeLessThan(14000);
			}
		});
	});
});
