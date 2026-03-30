/**
 * PostgreSQL connection manager with dual connection pools.
 *
 * Two pools isolate OLTP (job queue) from OLAP (retrieval/search) workloads,
 * preventing heavy queries from starving the worker's job dequeue.
 *
 * Pools are lazy singletons — created on first call, reused thereafter.
 *
 * @see docs/specs/07_database_client_migration_runner.spec.md §4.2
 * @see docs/functional-spec.md §4.2, §4.6
 */

import pg from 'pg';
import type { CloudSqlConfig } from '../config/types.js';
import { DATABASE_ERROR_CODES, DatabaseError } from '../shared/errors.js';
import { createChildLogger, createLogger } from '../shared/logger.js';

const { Pool } = pg;
type Pool = pg.Pool;

const logger = createLogger();
const dbLogger = createChildLogger(logger, { module: 'database' });

// ────────────────────────────────────────────────────────────
// Pool registry (lazy singletons)
// ────────────────────────────────────────────────────────────

let workerPool: Pool | null = null;
let queryPool: Pool | null = null;

/**
 * Builds the base `pg.PoolConfig` from the Mulder Cloud SQL config.
 * Enables SSL for non-localhost connections.
 */
function buildPoolConfig(config: CloudSqlConfig): pg.PoolConfig {
	const poolConfig: pg.PoolConfig = {
		host: config.host,
		port: config.port,
		database: config.database,
		user: config.user,
	};

	if (config.password) {
		poolConfig.password = config.password;
	}

	// Enable SSL for non-localhost connections (Cloud SQL)
	const isLocal = config.host === 'localhost' || config.host === '127.0.0.1';
	if (!isLocal) {
		poolConfig.ssl = { rejectUnauthorized: false };
	}

	return poolConfig;
}

/**
 * Returns the worker pool (OLTP) — small pool for job queue operations.
 *
 * - 2 connections (min 1, max 3)
 * - No `statement_timeout` — pipeline steps can run long
 * - Lazy singleton: created on first call, reused thereafter
 *
 * @throws {DatabaseError} with `DB_CONNECTION_FAILED` on pool creation failure
 */
export function getWorkerPool(config: CloudSqlConfig): Pool {
	if (workerPool) {
		return workerPool;
	}

	try {
		const poolConfig = buildPoolConfig(config);
		workerPool = new Pool({
			...poolConfig,
			min: 1,
			max: 3,
		});

		workerPool.on('error', (err) => {
			dbLogger.error({ err, pool: 'worker' }, 'Idle client error on worker pool');
		});

		dbLogger.info(
			{ pool: 'worker', host: config.host, port: config.port, database: config.database },
			'Worker pool created',
		);

		return workerPool;
	} catch (error: unknown) {
		throw new DatabaseError('Failed to create worker connection pool', DATABASE_ERROR_CODES.DB_CONNECTION_FAILED, {
			cause: error,
			context: { host: config.host, port: config.port, database: config.database },
		});
	}
}

/**
 * Returns the query pool (OLAP) — larger pool for retrieval and search.
 *
 * - 5 connections (min 1, max 10)
 * - `statement_timeout = 10s` — queries that take longer are killed
 * - Lazy singleton: created on first call, reused thereafter
 *
 * @throws {DatabaseError} with `DB_CONNECTION_FAILED` on pool creation failure
 */
export function getQueryPool(config: CloudSqlConfig): Pool {
	if (queryPool) {
		return queryPool;
	}

	try {
		const poolConfig = buildPoolConfig(config);
		queryPool = new Pool({
			...poolConfig,
			min: 1,
			max: 10,
			statement_timeout: 10_000,
		});

		queryPool.on('error', (err) => {
			dbLogger.error({ err, pool: 'query' }, 'Idle client error on query pool');
		});

		dbLogger.info(
			{ pool: 'query', host: config.host, port: config.port, database: config.database },
			'Query pool created',
		);

		return queryPool;
	} catch (error: unknown) {
		throw new DatabaseError('Failed to create query connection pool', DATABASE_ERROR_CODES.DB_CONNECTION_FAILED, {
			cause: error,
			context: { host: config.host, port: config.port, database: config.database },
		});
	}
}

/**
 * Gracefully shuts down all active connection pools.
 *
 * After calling this, subsequent calls to `getWorkerPool` / `getQueryPool`
 * will create fresh pool instances.
 */
export async function closeAllPools(): Promise<void> {
	const closeTasks: Promise<void>[] = [];

	if (workerPool) {
		closeTasks.push(workerPool.end());
		workerPool = null;
	}

	if (queryPool) {
		closeTasks.push(queryPool.end());
		queryPool = null;
	}

	if (closeTasks.length > 0) {
		await Promise.all(closeTasks);
		dbLogger.info('All connection pools closed');
	}
}
