/**
 * File-based SQL migration runner with tracking.
 *
 * Reads numbered `.sql` files from a migrations directory, applies them
 * sequentially in individual transactions, and records applied migrations
 * in a `mulder_migrations` tracking table (auto-created).
 *
 * @see docs/specs/07_database_client_migration_runner.spec.md §4.3
 * @see docs/functional-spec.md §4.2
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type pg from 'pg';
import { DATABASE_ERROR_CODES, DatabaseError } from '../shared/errors.js';
import { createChildLogger, createLogger } from '../shared/logger.js';

const logger = createLogger();
const migrateLogger = createChildLogger(logger, { module: 'migrate' });
const MIGRATION_LOCK_CLASS_ID = 0x4d554c44; // "MULD"
const MIGRATION_LOCK_OBJECT_ID = 0x4d4947; // "MIG"

type Queryable = pg.Pool | pg.PoolClient;

// ────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────

/** Result of running migrations. */
export interface MigrationResult {
	/** Filenames of newly applied migrations. */
	applied: string[];
	/** Filenames of already-applied (skipped) migrations. */
	skipped: string[];
	/** Total number of migration files found. */
	total: number;
}

/** Status of a single migration file. */
export interface MigrationStatus {
	/** The migration filename (e.g., `001_extensions.sql`). */
	filename: string;
	/** Whether this migration has been applied. */
	applied: boolean;
	/** Timestamp when the migration was applied, or `null` if pending. */
	appliedAt: Date | null;
}

// ────────────────────────────────────────────────────────────
// Tracking table management
// ────────────────────────────────────────────────────────────

const CREATE_TRACKING_TABLE = `
CREATE TABLE IF NOT EXISTS mulder_migrations (
  id SERIAL PRIMARY KEY,
  filename TEXT NOT NULL UNIQUE,
  applied_at TIMESTAMPTZ DEFAULT now()
);
`;

/**
 * Ensures the `mulder_migrations` tracking table exists.
 * Safe to call multiple times (uses `CREATE TABLE IF NOT EXISTS`).
 */
async function ensureTrackingTable(pool: Queryable): Promise<void> {
	await pool.query(CREATE_TRACKING_TABLE);
}

// ────────────────────────────────────────────────────────────
// File discovery
// ────────────────────────────────────────────────────────────

/**
 * Reads all `.sql` files from the migrations directory, sorted by filename.
 * The numeric prefix (e.g., `001_`, `002_`) ensures correct ordering.
 */
async function discoverMigrationFiles(migrationsDir: string): Promise<string[]> {
	let entries: string[];
	try {
		entries = await readdir(migrationsDir);
	} catch (error: unknown) {
		throw new DatabaseError(
			`Failed to read migrations directory: ${migrationsDir}`,
			DATABASE_ERROR_CODES.DB_MIGRATION_FAILED,
			{
				cause: error,
				context: { migrationsDir },
			},
		);
	}

	return entries.filter((f) => f.endsWith('.sql')).sort();
}

/**
 * Returns the set of already-applied migration filenames.
 */
async function getAppliedMigrations(pool: Queryable): Promise<Set<string>> {
	const result = await pool.query<{ filename: string }>('SELECT filename FROM mulder_migrations ORDER BY id');
	return new Set(result.rows.map((row) => row.filename));
}

// ────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────

/**
 * Executes pending SQL migrations from the given directory.
 *
 * - Auto-creates the `mulder_migrations` tracking table if it doesn't exist
 * - Each migration runs in its own transaction (BEGIN/COMMIT)
 * - If a migration fails, its transaction rolls back and the runner stops
 * - Already-applied migrations are skipped (idempotent)
 *
 * @throws {DatabaseError} with `DB_MIGRATION_FAILED` if a migration fails or the directory is unreadable
 */
export async function runMigrations(pool: pg.Pool, migrationsDir: string): Promise<MigrationResult> {
	const files = await discoverMigrationFiles(migrationsDir);

	const result: MigrationResult = {
		applied: [],
		skipped: [],
		total: files.length,
	};

	const client = await pool.connect();
	let lockAcquired = false;

	try {
		// Serialize migration runners across test workers and CLI processes.
		await client.query('SELECT pg_advisory_lock($1, $2)', [MIGRATION_LOCK_CLASS_ID, MIGRATION_LOCK_OBJECT_ID]);
		lockAcquired = true;

		await ensureTrackingTable(client);
		const appliedSet = await getAppliedMigrations(client);

		for (const filename of files) {
			if (appliedSet.has(filename)) {
				migrateLogger.debug({ filename }, 'Migration already applied, skipping');
				result.skipped.push(filename);
				continue;
			}

			migrateLogger.info({ filename }, 'Applying migration');

			const filePath = join(migrationsDir, filename);
			let sql: string;
			try {
				sql = await readFile(filePath, 'utf-8');
			} catch (error: unknown) {
				throw new DatabaseError(
					`Failed to read migration file: ${filename}`,
					DATABASE_ERROR_CODES.DB_MIGRATION_FAILED,
					{
						cause: error,
						context: { filename, filePath },
					},
				);
			}

			try {
				await client.query('BEGIN');
				await client.query(sql);
				await client.query('INSERT INTO mulder_migrations (filename) VALUES ($1)', [filename]);
				await client.query('COMMIT');

				migrateLogger.info({ filename }, 'Migration applied successfully');
				result.applied.push(filename);
			} catch (error: unknown) {
				await client.query('ROLLBACK');
				throw new DatabaseError(`Migration failed: ${filename}`, DATABASE_ERROR_CODES.DB_MIGRATION_FAILED, {
					cause: error,
					context: { filename },
				});
			}
		}
	} finally {
		if (lockAcquired) {
			await client.query('SELECT pg_advisory_unlock($1, $2)', [MIGRATION_LOCK_CLASS_ID, MIGRATION_LOCK_OBJECT_ID]);
		}
		client.release();
	}

	migrateLogger.info(
		{ applied: result.applied.length, skipped: result.skipped.length, total: result.total },
		'Migration run complete',
	);

	return result;
}

/**
 * Returns the status of all migration files (applied or pending).
 *
 * Lists every `.sql` file in the migrations directory alongside
 * its applied/pending status and application timestamp.
 */
export async function getMigrationStatus(pool: pg.Pool, migrationsDir: string): Promise<MigrationStatus[]> {
	await ensureTrackingTable(pool);

	const files = await discoverMigrationFiles(migrationsDir);

	const result = await pool.query<{ filename: string; applied_at: Date }>(
		'SELECT filename, applied_at FROM mulder_migrations ORDER BY id',
	);

	const appliedMap = new Map<string, Date>();
	for (const row of result.rows) {
		appliedMap.set(row.filename, row.applied_at);
	}

	return files.map((filename) => {
		const appliedAt = appliedMap.get(filename) ?? null;
		return {
			filename,
			applied: appliedAt !== null,
			appliedAt,
		};
	});
}
