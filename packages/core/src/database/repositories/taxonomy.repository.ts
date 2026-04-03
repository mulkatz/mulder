/**
 * Taxonomy repository -- CRUD operations + trigram similarity search
 * for the `taxonomy` table.
 *
 * Plain functions that accept a `pg.Pool` as the first argument (same pattern
 * as `entity.repository.ts`). No class wrapper.
 *
 * All queries use parameterized SQL. Inserts are idempotent via ON CONFLICT.
 * Trigram search uses the `pg_trgm` extension with GIN index on `canonical_name`.
 *
 * @see docs/specs/27_taxonomy_normalization.spec.md §4.2
 * @see docs/functional-spec.md §6.2
 */

import type pg from 'pg';
import { DATABASE_ERROR_CODES, DatabaseError } from '../../shared/errors.js';
import { createChildLogger, createLogger } from '../../shared/logger.js';
import type {
	CreateTaxonomyEntryInput,
	TaxonomyEntry,
	TaxonomyEntryStatus,
	TaxonomyFilter,
	TaxonomySimilarityMatch,
	UpdateTaxonomyEntryInput,
} from './taxonomy.types.js';

const logger = createLogger();
const repoLogger = createChildLogger(logger, { module: 'taxonomy-repository' });

// ────────────────────────────────────────────────────────────
// Row mapper (snake_case DB -> camelCase TS)
// ────────────────────────────────────────────────────────────

interface TaxonomyRow {
	id: string;
	canonical_name: string;
	entity_type: string;
	category: string | null;
	status: TaxonomyEntryStatus;
	aliases: string[] | null;
	created_at: Date;
	updated_at: Date;
}

interface TaxonomySimilarityRow extends TaxonomyRow {
	sim: number;
}

function mapTaxonomyRow(row: TaxonomyRow): TaxonomyEntry {
	return {
		id: row.id,
		canonicalName: row.canonical_name,
		entityType: row.entity_type,
		category: row.category,
		status: row.status,
		aliases: row.aliases ?? [],
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

// ────────────────────────────────────────────────────────────
// CRUD operations
// ────────────────────────────────────────────────────────────

/**
 * Creates a new taxonomy entry. Idempotent via
 * `ON CONFLICT (canonical_name, entity_type) DO UPDATE`.
 *
 * On conflict the aliases are merged and the entry is returned.
 */
export async function createTaxonomyEntry(pool: pg.Pool, input: CreateTaxonomyEntryInput): Promise<TaxonomyEntry> {
	const sql = `
    INSERT INTO taxonomy (canonical_name, entity_type, category, status, aliases)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (canonical_name, entity_type) DO UPDATE SET
      aliases = (
        SELECT array_agg(DISTINCT a)
        FROM unnest(taxonomy.aliases || EXCLUDED.aliases) AS a
      ),
      updated_at = now()
    RETURNING *
  `;
	const params = [
		input.canonicalName,
		input.entityType,
		input.category ?? null,
		input.status ?? 'auto',
		input.aliases ?? [],
	];

	try {
		const result = await pool.query<TaxonomyRow>(sql, params);
		const row = result.rows[0];
		repoLogger.debug(
			{ taxonomyId: row.id, canonicalName: input.canonicalName, entityType: input.entityType },
			'Taxonomy entry created or found',
		);
		return mapTaxonomyRow(row);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to create taxonomy entry', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { canonicalName: input.canonicalName, entityType: input.entityType },
		});
	}
}

/**
 * Finds a taxonomy entry by its UUID.
 *
 * @returns The taxonomy entry, or `null` if not found.
 */
export async function findTaxonomyEntryById(pool: pg.Pool, id: string): Promise<TaxonomyEntry | null> {
	const sql = 'SELECT * FROM taxonomy WHERE id = $1';

	try {
		const result = await pool.query<TaxonomyRow>(sql, [id]);
		if (result.rows.length === 0) {
			return null;
		}
		return mapTaxonomyRow(result.rows[0]);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to find taxonomy entry by ID', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { id },
		});
	}
}

/**
 * Finds a taxonomy entry by exact canonical name + entity type.
 *
 * @returns The taxonomy entry, or `null` if not found.
 */
export async function findTaxonomyEntryByName(
	pool: pg.Pool,
	canonicalName: string,
	entityType: string,
): Promise<TaxonomyEntry | null> {
	const sql = 'SELECT * FROM taxonomy WHERE canonical_name = $1 AND entity_type = $2';

	try {
		const result = await pool.query<TaxonomyRow>(sql, [canonicalName, entityType]);
		if (result.rows.length === 0) {
			return null;
		}
		return mapTaxonomyRow(result.rows[0]);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to find taxonomy entry by name', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { canonicalName, entityType },
		});
	}
}

/**
 * Finds all taxonomy entries matching the given filter.
 *
 * Supports filtering by entityType and status,
 * with pagination via limit/offset. Results ordered by canonical_name ASC.
 */
export async function findAllTaxonomyEntries(pool: pg.Pool, filter?: TaxonomyFilter): Promise<TaxonomyEntry[]> {
	const conditions: string[] = [];
	const params: unknown[] = [];
	let paramIndex = 1;

	if (filter?.entityType) {
		conditions.push(`entity_type = $${paramIndex}`);
		params.push(filter.entityType);
		paramIndex++;
	}

	if (filter?.status) {
		conditions.push(`status = $${paramIndex}`);
		params.push(filter.status);
		paramIndex++;
	}

	const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

	const limit = filter?.limit ?? 100;
	const offset = filter?.offset ?? 0;

	const sql = `SELECT * FROM taxonomy ${whereClause} ORDER BY canonical_name ASC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
	params.push(limit, offset);

	try {
		const result = await pool.query<TaxonomyRow>(sql, params);
		return result.rows.map(mapTaxonomyRow);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to find taxonomy entries', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { filter },
		});
	}
}

/**
 * Counts taxonomy entries matching the given filter. For pagination and status overview.
 */
export async function countTaxonomyEntries(pool: pg.Pool, filter?: TaxonomyFilter): Promise<number> {
	const conditions: string[] = [];
	const params: unknown[] = [];
	let paramIndex = 1;

	if (filter?.entityType) {
		conditions.push(`entity_type = $${paramIndex}`);
		params.push(filter.entityType);
		paramIndex++;
	}

	if (filter?.status) {
		conditions.push(`status = $${paramIndex}`);
		params.push(filter.status);
		paramIndex++;
	}

	const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
	const sql = `SELECT COUNT(*) FROM taxonomy ${whereClause}`;

	try {
		const result = await pool.query<{ count: string }>(sql, params);
		return Number.parseInt(result.rows[0].count, 10);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to count taxonomy entries', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { filter },
		});
	}
}

/**
 * Updates a taxonomy entry. Only provided fields are updated.
 * Sets `updated_at = now()` automatically.
 *
 * @throws {DatabaseError} with `DB_NOT_FOUND` if the entry does not exist.
 */
export async function updateTaxonomyEntry(
	pool: pg.Pool,
	id: string,
	input: UpdateTaxonomyEntryInput,
): Promise<TaxonomyEntry> {
	const setClauses: string[] = [];
	const params: unknown[] = [];
	let paramIndex = 1;

	if (input.canonicalName !== undefined) {
		setClauses.push(`canonical_name = $${paramIndex}`);
		params.push(input.canonicalName);
		paramIndex++;
	}

	if (input.entityType !== undefined) {
		setClauses.push(`entity_type = $${paramIndex}`);
		params.push(input.entityType);
		paramIndex++;
	}

	// category: explicit null clears the field, undefined skips it
	if (input.category !== undefined) {
		setClauses.push(`category = $${paramIndex}`);
		params.push(input.category);
		paramIndex++;
	}

	if (input.status !== undefined) {
		setClauses.push(`status = $${paramIndex}`);
		params.push(input.status);
		paramIndex++;
	}

	if (input.aliases !== undefined) {
		setClauses.push(`aliases = $${paramIndex}`);
		params.push(input.aliases);
		paramIndex++;
	}

	// Always update the timestamp
	setClauses.push('updated_at = now()');

	if (setClauses.length === 1) {
		// Only updated_at — no actual changes, still execute to bump timestamp
	}

	params.push(id);
	const sql = `UPDATE taxonomy SET ${setClauses.join(', ')} WHERE id = $${paramIndex} RETURNING *`;

	try {
		const result = await pool.query<TaxonomyRow>(sql, params);
		if (result.rows.length === 0) {
			throw new DatabaseError(`Taxonomy entry not found: ${id}`, DATABASE_ERROR_CODES.DB_NOT_FOUND, {
				context: { id },
			});
		}
		repoLogger.debug({ taxonomyId: id }, 'Taxonomy entry updated');
		return mapTaxonomyRow(result.rows[0]);
	} catch (error: unknown) {
		if (error instanceof DatabaseError) {
			throw error;
		}
		throw new DatabaseError('Failed to update taxonomy entry', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { id, fields: Object.keys(input) },
		});
	}
}

/**
 * Deletes a taxonomy entry by ID.
 *
 * @returns `true` if the entry was deleted, `false` if it didn't exist.
 */
export async function deleteTaxonomyEntry(pool: pg.Pool, id: string): Promise<boolean> {
	const sql = 'DELETE FROM taxonomy WHERE id = $1';

	try {
		const result = await pool.query(sql, [id]);
		const deleted = (result.rowCount ?? 0) > 0;
		if (deleted) {
			repoLogger.debug({ taxonomyId: id }, 'Taxonomy entry deleted');
		}
		return deleted;
	} catch (error: unknown) {
		throw new DatabaseError('Failed to delete taxonomy entry', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { id },
		});
	}
}

// ────────────────────────────────────────────────────────────
// Trigram similarity search
// ────────────────────────────────────────────────────────────

/**
 * Searches taxonomy entries by trigram similarity against both
 * canonical_name and aliases array.
 *
 * Uses `pg_trgm` `similarity()` function with GIN index on canonical_name.
 * Excludes entries with status `'rejected'`.
 *
 * @returns Matches sorted by similarity DESC, limited to 5 results.
 */
export async function searchTaxonomyBySimilarity(
	pool: pg.Pool,
	name: string,
	entityType: string,
	threshold: number,
): Promise<TaxonomySimilarityMatch[]> {
	const sql = `
    SELECT t.*, greatest(
      similarity(t.canonical_name, $1),
      (SELECT COALESCE(max(similarity(a, $1)), 0) FROM unnest(t.aliases) AS a)
    ) AS sim
    FROM taxonomy t
    WHERE t.entity_type = $2
      AND t.status != 'rejected'
      AND (
        similarity(t.canonical_name, $1) >= $3
        OR EXISTS (
          SELECT 1 FROM unnest(t.aliases) AS a
          WHERE similarity(a, $1) >= $3
        )
      )
    ORDER BY sim DESC
    LIMIT 5
  `;

	try {
		const result = await pool.query<TaxonomySimilarityRow>(sql, [name, entityType, threshold]);
		return result.rows.map((row) => ({
			entry: mapTaxonomyRow(row),
			similarity: Number(row.sim),
		}));
	} catch (error: unknown) {
		throw new DatabaseError('Failed to search taxonomy by similarity', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { name, entityType, threshold },
		});
	}
}
