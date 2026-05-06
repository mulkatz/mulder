/**
 * Source repository — CRUD operations for `sources` and `source_steps` tables.
 *
 * Plain functions that accept a `pg.Pool` as the first argument (same pattern
 * as `migrate.ts`). No class wrapper — keeps it simple and testable.
 *
 * All queries use parameterized SQL. Inserts are idempotent via ON CONFLICT.
 *
 * @see docs/specs/14_source_repository.spec.md §4.2
 * @see docs/functional-spec.md §4.3
 */

import type pg from 'pg';
import { DATABASE_ERROR_CODES, DatabaseError } from '../../shared/errors.js';
import { createChildLogger, createLogger } from '../../shared/logger.js';
import { normalizeSensitivityMetadata, stringifySensitivityMetadata } from '../../shared/sensitivity.js';
import { queryWithSensitivityColumnFallback } from './schema-compat.js';
import type {
	CreateSourceInput,
	FailedSourceInfo,
	PersistedSource,
	SourceFilter,
	SourceFormatMetadata,
	SourceStatus,
	SourceStep,
	SourceStepStatus,
	SourceType,
	SourceWithSteps,
	SourceWithStepsFilter,
	UpdateSourceInput,
	UpsertSourceStepInput,
} from './source.types.js';

const logger = createLogger();
const repoLogger = createChildLogger(logger, { module: 'source-repository' });

type Queryable = pg.Pool | pg.PoolClient;

// ────────────────────────────────────────────────────────────
// Row mappers (snake_case DB → camelCase TS)
// ────────────────────────────────────────────────────────────

interface SourceRow {
	id: string;
	filename: string;
	storage_path: string;
	file_hash: string;
	parent_source_id: string | null;
	source_type: SourceType | null;
	format_metadata: SourceFormatMetadata | null;
	page_count: number | null;
	has_native_text: boolean;
	native_text_ratio: number;
	status: SourceStatus;
	reliability_score: number | null;
	tags: string[] | null;
	metadata: Record<string, unknown>;
	deleted_at?: Date | null;
	deletion_status?: PersistedSource['deletionStatus'];
	active_source?: boolean;
	sensitivity_level: PersistedSource['sensitivityLevel'];
	sensitivity_metadata: unknown;
	created_at: Date;
	updated_at: Date;
}

interface SourceStepRow {
	source_id: string;
	step_name: string;
	status: SourceStepStatus;
	config_hash: string | null;
	completed_at: Date | null;
	error_message: string | null;
}

interface SourceWithStepsRow extends SourceRow {
	step_name: string | null;
	step_status: SourceStepStatus | null;
	step_config_hash: string | null;
	step_completed_at: Date | null;
	step_error_message: string | null;
}

function mapSourceRow(row: SourceRow): PersistedSource {
	return {
		id: row.id,
		filename: row.filename,
		storagePath: row.storage_path,
		fileHash: row.file_hash,
		parentSourceId: row.parent_source_id,
		sourceType: row.source_type ?? 'pdf',
		formatMetadata: row.format_metadata ?? {},
		pageCount: row.page_count,
		hasNativeText: row.has_native_text,
		nativeTextRatio: row.native_text_ratio,
		status: row.status,
		reliabilityScore: row.reliability_score,
		tags: row.tags ?? [],
		metadata: row.metadata ?? {},
		deletedAt: row.deleted_at ?? null,
		deletionStatus: row.deletion_status ?? 'active',
		activeSource: row.active_source ?? true,
		sensitivityLevel: row.sensitivity_level ?? 'internal',
		sensitivityMetadata: normalizeSensitivityMetadata(row.sensitivity_metadata, row.sensitivity_level ?? 'internal'),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function mapSourceStepRow(row: SourceStepRow): SourceStep {
	return {
		sourceId: row.source_id,
		stepName: row.step_name,
		status: row.status,
		configHash: row.config_hash,
		completedAt: row.completed_at,
		errorMessage: row.error_message,
	};
}

function mapSourceWithStepsRow(row: SourceWithStepsRow): SourceWithSteps {
	return {
		source: mapSourceRow(row),
		steps: row.step_name
			? [
					{
						sourceId: row.id,
						stepName: row.step_name,
						status: row.step_status ?? 'pending',
						configHash: row.step_config_hash,
						completedAt: row.step_completed_at,
						errorMessage: row.step_error_message,
					},
				]
			: [],
	};
}

function escapeLikePattern(value: string): string {
	return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

function buildSourceFilterClause(filter?: SourceFilter): { conditions: string[]; params: unknown[] } {
	const conditions: string[] = filter?.includeDeleted
		? []
		: ["deletion_status NOT IN ('soft_deleted', 'purging', 'purged')"];
	const params: unknown[] = [];
	let paramIndex = 1;

	if (filter?.status) {
		conditions.push(`status = $${paramIndex}`);
		params.push(filter.status);
		paramIndex++;
	}

	if (filter?.sourceType) {
		conditions.push(`source_type = $${paramIndex}`);
		params.push(filter.sourceType);
		paramIndex++;
	}

	if (filter?.search) {
		conditions.push(`filename ILIKE $${paramIndex} ESCAPE '\\'`);
		params.push(`%${escapeLikePattern(filter.search)}%`);
		paramIndex++;
	}

	if (filter?.tags && filter.tags.length > 0) {
		conditions.push(`tags @> $${paramIndex}`);
		params.push(filter.tags);
		paramIndex++;
	}

	return { conditions, params };
}

// ────────────────────────────────────────────────────────────
// Source CRUD
// ────────────────────────────────────────────────────────────

/**
 * Creates a new source record. Idempotent via `file_hash` unique constraint.
 *
 * On conflict (duplicate hash), returns the existing record with an updated
 * `updated_at` timestamp.
 */
export async function createSource(pool: Queryable, input: CreateSourceInput): Promise<PersistedSource> {
	const columns = input.id
		? [
				'id',
				'filename',
				'storage_path',
				'file_hash',
				'parent_source_id',
				'source_type',
				'format_metadata',
				'page_count',
				'has_native_text',
				'native_text_ratio',
				'tags',
				'metadata',
				'sensitivity_level',
				'sensitivity_metadata',
			]
		: [
				'filename',
				'storage_path',
				'file_hash',
				'parent_source_id',
				'source_type',
				'format_metadata',
				'page_count',
				'has_native_text',
				'native_text_ratio',
				'tags',
				'metadata',
				'sensitivity_level',
				'sensitivity_metadata',
			];
	const sensitivityLevel = input.sensitivityLevel ?? 'internal';
	const values = input.id
		? [
				input.id,
				input.filename,
				input.storagePath,
				input.fileHash,
				input.parentSourceId ?? null,
				input.sourceType ?? 'pdf',
				JSON.stringify(input.formatMetadata ?? {}),
				input.pageCount ?? null,
				input.hasNativeText ?? false,
				input.nativeTextRatio ?? 0,
				input.tags ?? [],
				JSON.stringify(input.metadata ?? {}),
				sensitivityLevel,
				stringifySensitivityMetadata(input.sensitivityMetadata, sensitivityLevel),
			]
		: [
				input.filename,
				input.storagePath,
				input.fileHash,
				input.parentSourceId ?? null,
				input.sourceType ?? 'pdf',
				JSON.stringify(input.formatMetadata ?? {}),
				input.pageCount ?? null,
				input.hasNativeText ?? false,
				input.nativeTextRatio ?? 0,
				input.tags ?? [],
				JSON.stringify(input.metadata ?? {}),
				sensitivityLevel,
				stringifySensitivityMetadata(input.sensitivityMetadata, sensitivityLevel),
			];
	const placeholders = values.map((_, index) => `$${index + 1}`).join(', ');
	const sql = `
    INSERT INTO sources (${columns.join(', ')})
    VALUES (${placeholders})
    ON CONFLICT (file_hash) DO UPDATE SET updated_at = now()
    RETURNING *
  `;
	const legacyColumnCount = columns.length - 2;
	const legacyColumns = columns.slice(0, legacyColumnCount);
	const legacyValues = values.slice(0, legacyColumnCount);
	const legacyPlaceholders = legacyValues.map((_, index) => `$${index + 1}`).join(', ');
	const legacySql = `
    INSERT INTO sources (${legacyColumns.join(', ')})
    VALUES (${legacyPlaceholders})
    ON CONFLICT (file_hash) DO UPDATE SET updated_at = now()
    RETURNING *
  `;

	try {
		const result = await queryWithSensitivityColumnFallback<SourceRow>(pool, sql, values, legacySql, legacyValues);
		const row = result.rows[0];
		repoLogger.debug({ sourceId: row.id, fileHash: input.fileHash }, 'Source created or found');
		return mapSourceRow(row);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to create source', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { filename: input.filename, fileHash: input.fileHash },
		});
	}
}

/**
 * Finds a source by its UUID.
 *
 * @returns The source, or `null` if not found.
 */
export async function findSourceById(
	pool: Queryable,
	id: string,
	options?: { includeDeleted?: boolean },
): Promise<PersistedSource | null> {
	const sql = `SELECT * FROM sources WHERE id = $1 ${
		options?.includeDeleted ? '' : "AND deletion_status NOT IN ('soft_deleted', 'purging', 'purged')"
	}`;

	try {
		const result = await pool.query<SourceRow>(sql, [id]);
		if (result.rows.length === 0) {
			return null;
		}
		return mapSourceRow(result.rows[0]);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to find source by ID', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { id },
		});
	}
}

/**
 * Finds a source by its file hash. Used for dedup checking at ingest time.
 *
 * @returns The source, or `null` if not found.
 */
export async function findSourceByHash(
	pool: Queryable,
	hash: string,
	options?: { includeDeleted?: boolean },
): Promise<PersistedSource | null> {
	const sql = `SELECT * FROM sources WHERE file_hash = $1 ${
		options?.includeDeleted ? '' : "AND deletion_status NOT IN ('soft_deleted', 'purging', 'purged')"
	}`;

	try {
		const result = await pool.query<SourceRow>(sql, [hash]);
		if (result.rows.length === 0) {
			return null;
		}
		return mapSourceRow(result.rows[0]);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to find source by hash', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { hash },
		});
	}
}

/**
 * Finds the earliest source with a durable cross-format ingest dedup key.
 *
 * The key lives in format_metadata so this remains migration-free for M9-J12.
 */
export async function findSourceByCrossFormatDedupKey(
	pool: Queryable,
	dedupKey: string,
): Promise<PersistedSource | null> {
	const sql = `
    SELECT *
    FROM sources
    WHERE format_metadata->>'cross_format_dedup_key' = $1
      AND deletion_status NOT IN ('soft_deleted', 'purging', 'purged')
    ORDER BY created_at ASC, id ASC
    LIMIT 1
  `;

	try {
		const result = await pool.query<SourceRow>(sql, [dedupKey]);
		if (result.rows.length === 0) {
			return null;
		}
		return mapSourceRow(result.rows[0]);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to find source by cross-format dedup key', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { dedupKey },
		});
	}
}

/**
 * Finds all sources matching the given filter.
 *
 * Supports filtering by status and tags, with pagination via limit/offset.
 * Results are ordered by `created_at DESC`.
 */
export async function findAllSources(pool: pg.Pool, filter?: SourceFilter): Promise<PersistedSource[]> {
	const { conditions, params } = buildSourceFilterClause(filter);
	const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

	const limit = filter?.limit ?? 100;
	const offset = filter?.offset ?? 0;
	const paramIndex = params.length + 1;

	const sql = `SELECT * FROM sources ${whereClause} ORDER BY created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
	params.push(limit, offset);

	try {
		const result = await pool.query<SourceRow>(sql, params);
		return result.rows.map(mapSourceRow);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to find sources', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { filter },
		});
	}
}

export interface SourceReliabilityFilter {
	limit?: number;
	offset?: number;
}

/**
 * Finds all sources with a persisted reliability score.
 */
export async function findScoredSources(pool: pg.Pool, filter?: SourceReliabilityFilter): Promise<PersistedSource[]> {
	const limit = filter?.limit ?? 100;
	const offset = filter?.offset ?? 0;
	const sql = `
    SELECT *
    FROM sources
    WHERE reliability_score IS NOT NULL
      AND deletion_status NOT IN ('soft_deleted', 'purging', 'purged')
    ORDER BY created_at DESC
    LIMIT $1 OFFSET $2
  `;

	try {
		const result = await pool.query<SourceRow>(sql, [limit, offset]);
		return result.rows.map(mapSourceRow);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to find scored sources', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { filter },
		});
	}
}

/**
 * Counts sources with a persisted reliability score.
 */
export async function countScoredSources(pool: pg.Pool): Promise<number> {
	const sql = `
    SELECT COUNT(*)
    FROM sources
    WHERE reliability_score IS NOT NULL
      AND deletion_status NOT IN ('soft_deleted', 'purging', 'purged')
  `;

	try {
		const result = await pool.query<{ count: string }>(sql);
		return Number.parseInt(result.rows[0].count, 10);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to count scored sources', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
		});
	}
}

/**
 * Counts sources matching the given filter. For pagination and status overview.
 */
export async function countSources(pool: pg.Pool, filter?: SourceFilter): Promise<number> {
	const { conditions, params } = buildSourceFilterClause(filter);
	const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
	const sql = `SELECT COUNT(*) FROM sources ${whereClause}`;

	try {
		const result = await pool.query<{ count: string }>(sql, params);
		return Number.parseInt(result.rows[0].count, 10);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to count sources', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { filter },
		});
	}
}

/**
 * Updates a source record. Only provided fields are updated.
 * Sets `updated_at = now()` automatically.
 *
 * @throws {DatabaseError} with `DB_NOT_FOUND` if the source does not exist.
 */
export async function updateSource(pool: pg.Pool, id: string, input: UpdateSourceInput): Promise<PersistedSource> {
	const setClauses: string[] = [];
	const params: unknown[] = [];
	let paramIndex = 1;

	const fieldMap: Array<[keyof UpdateSourceInput, string]> = [
		['filename', 'filename'],
		['storagePath', 'storage_path'],
		['fileHash', 'file_hash'],
		['parentSourceId', 'parent_source_id'],
		['sourceType', 'source_type'],
		['pageCount', 'page_count'],
		['hasNativeText', 'has_native_text'],
		['nativeTextRatio', 'native_text_ratio'],
		['status', 'status'],
		['reliabilityScore', 'reliability_score'],
		['tags', 'tags'],
		['deletedAt', 'deleted_at'],
		['deletionStatus', 'deletion_status'],
	];

	for (const [tsKey, dbKey] of fieldMap) {
		if (input[tsKey] !== undefined) {
			setClauses.push(`${dbKey} = $${paramIndex}`);
			params.push(input[tsKey]);
			paramIndex++;
		}
	}

	// metadata needs JSON.stringify
	if (input.metadata !== undefined) {
		setClauses.push(`metadata = $${paramIndex}`);
		params.push(JSON.stringify(input.metadata));
		paramIndex++;
	}

	if (input.formatMetadata !== undefined) {
		setClauses.push(`format_metadata = $${paramIndex}`);
		params.push(JSON.stringify(input.formatMetadata));
		paramIndex++;
	}

	if (input.sensitivityLevel !== undefined || input.sensitivityMetadata !== undefined) {
		const sensitivityLevel = input.sensitivityLevel ?? 'internal';
		setClauses.push(`sensitivity_level = $${paramIndex}`);
		params.push(sensitivityLevel);
		paramIndex++;
		setClauses.push(`sensitivity_metadata = $${paramIndex}::jsonb`);
		params.push(stringifySensitivityMetadata(input.sensitivityMetadata, sensitivityLevel));
		paramIndex++;
	}

	if (setClauses.length === 0) {
		// Nothing to update — just refresh timestamp and return
		setClauses.push('updated_at = now()');
	} else {
		setClauses.push('updated_at = now()');
	}

	params.push(id);
	const sql = `UPDATE sources SET ${setClauses.join(', ')} WHERE id = $${paramIndex} RETURNING *`;

	try {
		const result = await pool.query<SourceRow>(sql, params);
		if (result.rows.length === 0) {
			throw new DatabaseError(`Source not found: ${id}`, DATABASE_ERROR_CODES.DB_NOT_FOUND, {
				context: { id },
			});
		}
		repoLogger.debug({ sourceId: id }, 'Source updated');
		return mapSourceRow(result.rows[0]);
	} catch (error: unknown) {
		if (error instanceof DatabaseError) {
			throw error;
		}
		throw new DatabaseError('Failed to update source', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { id, fields: Object.keys(input) },
		});
	}
}

/**
 * Convenience function to update only the source status.
 * Sets `updated_at = now()` automatically.
 *
 * @throws {DatabaseError} with `DB_NOT_FOUND` if the source does not exist.
 */
export async function updateSourceStatus(pool: pg.Pool, id: string, status: SourceStatus): Promise<PersistedSource> {
	const sql = 'UPDATE sources SET status = $1, updated_at = now() WHERE id = $2 RETURNING *';

	try {
		const result = await pool.query<SourceRow>(sql, [status, id]);
		if (result.rows.length === 0) {
			throw new DatabaseError(`Source not found: ${id}`, DATABASE_ERROR_CODES.DB_NOT_FOUND, {
				context: { id, status },
			});
		}
		repoLogger.debug({ sourceId: id, status }, 'Source status updated');
		return mapSourceRow(result.rows[0]);
	} catch (error: unknown) {
		if (error instanceof DatabaseError) {
			throw error;
		}
		throw new DatabaseError('Failed to update source status', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { id, status },
		});
	}
}

export async function updateSourceSensitivityFromArtifacts(pool: pg.Pool, sourceId: string): Promise<PersistedSource> {
	const sql = `
    WITH artifact_sensitivity AS (
      SELECT sensitivity_level, sensitivity_metadata
      FROM stories
      WHERE source_id = $1
      UNION ALL
      SELECT se.sensitivity_level, se.sensitivity_metadata
      FROM story_entities se
      JOIN stories s ON s.id = se.story_id
      WHERE s.source_id = $1
      UNION ALL
      SELECT c.sensitivity_level, c.sensitivity_metadata
      FROM chunks c
      JOIN stories s ON s.id = c.story_id
      WHERE s.source_id = $1
      UNION ALL
      SELECT ee.sensitivity_level, ee.sensitivity_metadata
      FROM entity_edges ee
      JOIN stories s ON s.id = ee.story_id
      WHERE s.source_id = $1
      UNION ALL
      SELECT ka.sensitivity_level, ka.sensitivity_metadata
      FROM knowledge_assertions ka
      WHERE ka.source_id = $1 AND ka.deleted_at IS NULL
    ),
    ranked AS (
      SELECT
        COALESCE(
          (ARRAY_AGG(sensitivity_level ORDER BY
            CASE sensitivity_level
              WHEN 'confidential' THEN 4
              WHEN 'restricted' THEN 3
              WHEN 'internal' THEN 2
              ELSE 1
            END DESC
          ))[1],
          'internal'
        ) AS propagated_level,
        COALESCE(jsonb_agg(DISTINCT pii.value) FILTER (WHERE pii.value IS NOT NULL), '[]'::jsonb) AS pii_types
      FROM artifact_sensitivity
      LEFT JOIN LATERAL jsonb_array_elements_text(sensitivity_metadata->'pii_types') AS pii(value) ON true
    )
    UPDATE sources
    SET
      sensitivity_level = ranked.propagated_level,
      sensitivity_metadata = jsonb_build_object(
        'level', ranked.propagated_level,
        'reason', 'upward_propagation',
        'assigned_by', 'policy_rule',
        'assigned_at', to_jsonb(now()),
        'pii_types', ranked.pii_types,
        'declassify_date', 'null'::jsonb
      ),
      updated_at = now()
    FROM ranked
    WHERE sources.id = $1
    RETURNING sources.*
  `;

	try {
		const result = await pool.query<SourceRow>(sql, [sourceId]);
		if (result.rows.length === 0) {
			throw new DatabaseError(`Source not found: ${sourceId}`, DATABASE_ERROR_CODES.DB_NOT_FOUND, {
				context: { sourceId },
			});
		}
		return mapSourceRow(result.rows[0]);
	} catch (error: unknown) {
		if (error instanceof DatabaseError) {
			throw error;
		}
		throw new DatabaseError('Failed to update source sensitivity', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { sourceId },
		});
	}
}

/**
 * Deletes a source by ID. Cascades to `source_steps` via ON DELETE CASCADE.
 *
 * @returns `true` if the source was deleted, `false` if it didn't exist.
 */
export async function deleteSource(pool: pg.Pool, id: string): Promise<boolean> {
	const sql = 'DELETE FROM sources WHERE id = $1';

	try {
		const result = await pool.query(sql, [id]);
		const deleted = (result.rowCount ?? 0) > 0;
		if (deleted) {
			repoLogger.debug({ sourceId: id }, 'Source deleted');
		}
		return deleted;
	} catch (error: unknown) {
		throw new DatabaseError('Failed to delete source', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { id },
		});
	}
}

// ────────────────────────────────────────────────────────────
// Source step CRUD
// ────────────────────────────────────────────────────────────

/**
 * Upserts a source step record. Idempotent via (source_id, step_name) primary key.
 *
 * Sets `completed_at = now()` when the status is `completed` or `skipped`.
 */
export async function upsertSourceStep(pool: Queryable, input: UpsertSourceStepInput): Promise<SourceStep> {
	const isTerminalSuccess = input.status === 'completed' || input.status === 'skipped';
	const completedAt = isTerminalSuccess ? 'now()' : 'NULL';

	const sql = `
    INSERT INTO source_steps (source_id, step_name, status, config_hash, error_message, completed_at)
    VALUES ($1, $2, $3, $4, $5, ${completedAt})
    ON CONFLICT (source_id, step_name) DO UPDATE SET
      status = EXCLUDED.status,
      config_hash = CASE
        WHEN EXCLUDED.status = 'completed' THEN COALESCE(EXCLUDED.config_hash, source_steps.config_hash)
        ELSE EXCLUDED.config_hash
      END,
      error_message = EXCLUDED.error_message,
      completed_at = CASE WHEN EXCLUDED.status IN ('completed', 'skipped') THEN now() ELSE source_steps.completed_at END
    RETURNING *
  `;
	const params = [input.sourceId, input.stepName, input.status, input.configHash ?? null, input.errorMessage ?? null];

	try {
		const result = await pool.query<SourceStepRow>(sql, params);
		repoLogger.debug(
			{ sourceId: input.sourceId, stepName: input.stepName, status: input.status },
			'Source step upserted',
		);
		return mapSourceStepRow(result.rows[0]);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to upsert source step', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { sourceId: input.sourceId, stepName: input.stepName },
		});
	}
}

/**
 * Finds all source steps for a given source, ordered by step name.
 */
export async function findSourceSteps(pool: pg.Pool, sourceId: string): Promise<SourceStep[]> {
	const sql = 'SELECT * FROM source_steps WHERE source_id = $1 ORDER BY step_name';

	try {
		const result = await pool.query<SourceStepRow>(sql, [sourceId]);
		return result.rows.map(mapSourceStepRow);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to find source steps', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { sourceId },
		});
	}
}

/**
 * Finds all sources bundled with their source_steps rows for bulk planning.
 *
 * Optional filtering keeps the query efficient when a caller only needs
 * sources that have already reached a given status.
 */
export async function findSourcesWithSteps(pool: pg.Pool, filter?: SourceWithStepsFilter): Promise<SourceWithSteps[]> {
	const conditions: string[] = [];
	const params: unknown[] = [];
	let paramIndex = 1;

	if (filter?.minimumStatus) {
		conditions.push(
			`array_position(ARRAY['ingested','extracted','segmented','enriched','embedded','graphed','analyzed'], s.status) >= array_position(ARRAY['ingested','extracted','segmented','enriched','embedded','graphed','analyzed'], $${paramIndex})`,
		);
		params.push(filter.minimumStatus);
		paramIndex++;
	}
	if (!filter?.includeDeleted) {
		conditions.push("s.deletion_status NOT IN ('soft_deleted', 'purging', 'purged')");
	}

	const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
	const sql = `
    SELECT
      s.id,
      s.filename,
      s.storage_path,
      s.file_hash,
      s.parent_source_id,
      s.source_type,
      s.format_metadata,
      s.page_count,
      s.has_native_text,
      s.native_text_ratio,
      s.status,
      s.reliability_score,
      s.tags,
      s.metadata,
      s.deleted_at,
      s.deletion_status,
      s.active_source,
      s.created_at,
      s.updated_at,
      ss.step_name,
      ss.status AS step_status,
      ss.config_hash AS step_config_hash,
      ss.completed_at AS step_completed_at,
      ss.error_message AS step_error_message
    FROM sources s
    LEFT JOIN source_steps ss ON ss.source_id = s.id
    ${whereClause}
    ORDER BY s.created_at DESC, s.id ASC, ss.step_name ASC
  `;

	try {
		const result = await pool.query<SourceWithStepsRow>(sql, params);
		const grouped = new Map<string, SourceWithSteps>();

		for (const row of result.rows) {
			const existing = grouped.get(row.id);
			if (!existing) {
				grouped.set(row.id, mapSourceWithStepsRow(row));
				continue;
			}

			if (row.step_name) {
				existing.steps.push({
					sourceId: row.id,
					stepName: row.step_name,
					status: row.step_status ?? 'pending',
					configHash: row.step_config_hash,
					completedAt: row.step_completed_at,
					errorMessage: row.step_error_message,
				});
			}
		}

		return [...grouped.values()];
	} catch (error: unknown) {
		throw new DatabaseError('Failed to find sources with steps', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { minimumStatus: filter?.minimumStatus ?? null },
		});
	}
}

/**
 * Deletes a source step record by source ID and step name.
 *
 * @returns `true` if the record was deleted, `false` if it didn't exist.
 */
export async function deleteSourceStep(pool: pg.Pool, sourceId: string, stepName: string): Promise<boolean> {
	const sql = 'DELETE FROM source_steps WHERE source_id = $1 AND step_name = $2';

	try {
		const result = await pool.query(sql, [sourceId, stepName]);
		const deleted = (result.rowCount ?? 0) > 0;
		if (deleted) {
			repoLogger.debug({ sourceId, stepName }, 'Source step deleted');
		}
		return deleted;
	} catch (error: unknown) {
		throw new DatabaseError('Failed to delete source step', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { sourceId, stepName },
		});
	}
}

/**
 * Finds a single source step by source ID and step name.
 *
 * @returns The source step, or `null` if not found.
 */
export async function findSourceStep(pool: Queryable, sourceId: string, stepName: string): Promise<SourceStep | null> {
	const sql = 'SELECT * FROM source_steps WHERE source_id = $1 AND step_name = $2';

	try {
		const result = await pool.query<SourceStepRow>(sql, [sourceId, stepName]);
		if (result.rows.length === 0) {
			return null;
		}
		return mapSourceStepRow(result.rows[0]);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to find source step', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { sourceId, stepName },
		});
	}
}

// ────────────────────────────────────────────────────────────
// Aggregate queries (status overview)
// ────────────────────────────────────────────────────────────

/**
 * Count sources grouped by status.
 * Returns a record like `{ ingested: 3, extracted: 5, ... }`.
 */
export async function countSourcesByStatus(pool: pg.Pool): Promise<Record<string, number>> {
	const sql = `
    SELECT status, COUNT(*)::int AS count
    FROM sources
    WHERE deletion_status NOT IN ('soft_deleted', 'purging', 'purged')
    GROUP BY status
  `;

	try {
		const result = await pool.query<{ status: string; count: number }>(sql);
		const grouped: Record<string, number> = {};
		for (const row of result.rows) {
			grouped[row.status] = row.count;
		}
		return grouped;
	} catch (error: unknown) {
		throw new DatabaseError('Failed to count sources by status', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
		});
	}
}

/**
 * Find sources that have at least one failed source_step.
 * Returns source ID, filename, the failed step name, and error message.
 * Limited to 100 results, ordered by most recently updated first.
 */
export async function findSourcesWithFailedSteps(pool: pg.Pool): Promise<FailedSourceInfo[]> {
	const sql = `
    SELECT s.id AS source_id, s.filename, ss.step_name, ss.error_message
    FROM sources s
    JOIN source_steps ss ON ss.source_id = s.id
    WHERE ss.status = 'failed'
      AND s.deletion_status NOT IN ('soft_deleted', 'purging', 'purged')
    ORDER BY s.updated_at DESC
    LIMIT 100
  `;

	try {
		const result = await pool.query<{
			source_id: string;
			filename: string;
			step_name: string;
			error_message: string | null;
		}>(sql);
		return result.rows.map((row) => ({
			sourceId: row.source_id,
			filename: row.filename,
			stepName: row.step_name,
			errorMessage: row.error_message,
		}));
	} catch (error: unknown) {
		throw new DatabaseError('Failed to find sources with failed steps', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
		});
	}
}
