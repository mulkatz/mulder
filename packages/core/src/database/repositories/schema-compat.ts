import type pg from 'pg';

type Queryable = pg.Pool | pg.PoolClient;

interface PgErrorLike {
	code?: unknown;
	message?: unknown;
}

function isPgErrorLike(value: unknown): value is PgErrorLike {
	return value !== null && typeof value === 'object';
}

function isMissingSensitivityColumnError(error: unknown): boolean {
	if (!isPgErrorLike(error)) {
		return false;
	}
	if (error.code !== '42703' || typeof error.message !== 'string') {
		return false;
	}
	return error.message.includes('sensitivity_level') || error.message.includes('sensitivity_metadata');
}

function isMissingSourceDeletionStatusError(error: unknown): boolean {
	if (!isPgErrorLike(error)) {
		return false;
	}
	return error.code === '42703' && typeof error.message === 'string' && error.message.includes('deletion_status');
}

export async function queryWithSensitivityColumnFallback<Row extends pg.QueryResultRow>(
	pool: Queryable,
	sql: string,
	params: unknown[],
	legacySql: string,
	legacyParams: unknown[],
): Promise<pg.QueryResult<Row>> {
	try {
		return await pool.query<Row>(sql, params);
	} catch (error: unknown) {
		if (!isMissingSensitivityColumnError(error)) {
			throw error;
		}
		return await pool.query<Row>(legacySql, legacyParams);
	}
}

export async function queryWithSourceDeletionStatusFallback<Row extends pg.QueryResultRow>(
	pool: Queryable,
	sql: string,
	params: unknown[],
	legacySql: string,
	legacyParams: unknown[],
): Promise<pg.QueryResult<Row>> {
	try {
		return await pool.query<Row>(sql, params);
	} catch (error: unknown) {
		if (!isMissingSourceDeletionStatusError(error)) {
			throw error;
		}
		return await pool.query<Row>(legacySql, legacyParams);
	}
}
