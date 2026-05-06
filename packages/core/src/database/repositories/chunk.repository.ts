/**
 * Chunk repository — CRUD + vector search + FTS operations for the `chunks` table.
 *
 * Plain functions that accept a `pg.Pool` as the first argument (same pattern
 * as `story.repository.ts`). No class wrapper — keeps it simple and testable.
 *
 * All queries use parameterized SQL. Inserts are idempotent via ON CONFLICT.
 * Vector search uses `<=>` operator (cosine distance) with HNSW index.
 * Full-text search uses the generated `fts_vector` column.
 *
 * @see docs/specs/32_embedding_wrapper_semantic_chunker_chunk_repository.spec.md §4.2
 * @see docs/functional-spec.md §4.3
 */

import type pg from 'pg';
import { DATABASE_ERROR_CODES, DatabaseError } from '../../shared/errors.js';
import { createChildLogger, createLogger } from '../../shared/logger.js';
import { normalizeSensitivityMetadata, stringifySensitivityMetadata } from '../../shared/sensitivity.js';
import {
	mapArtifactProvenanceFromDb,
	mergeArtifactProvenanceSql,
	stringifyArtifactProvenance,
} from './artifact-provenance.js';
import type {
	Chunk,
	ChunkFilter,
	ChunkRow,
	CreateChunkInput,
	FtsSearchResult,
	VectorSearchResult,
} from './chunk.types.js';
import { queryWithSensitivityColumnFallback, queryWithSourceDeletionStatusFallback } from './schema-compat.js';

const logger = createLogger();
const repoLogger = createChildLogger(logger, { module: 'chunk-repository' });

// ────────────────────────────────────────────────────────────
// pgvector string parsing
// ────────────────────────────────────────────────────────────

/**
 * Parses a pgvector string representation `[0.1,0.2,...]` into a `number[]`.
 * Returns `null` for null/undefined input.
 */
function parseVectorString(vectorStr: string | null | undefined): number[] | null {
	if (vectorStr === null || vectorStr === undefined) {
		return null;
	}
	const trimmed = vectorStr.replace(/^\[/, '').replace(/]$/, '');
	if (trimmed.length === 0) {
		return null;
	}
	return trimmed.split(',').map(Number);
}

// ────────────────────────────────────────────────────────────
// Row mapper (snake_case DB → camelCase TS)
// ────────────────────────────────────────────────────────────

/** Maps a database row to a domain `Chunk` object. */
export function mapChunkRow(row: ChunkRow): Chunk {
	return {
		id: row.id,
		storyId: row.story_id,
		content: row.content,
		chunkIndex: row.chunk_index,
		pageStart: row.page_start,
		pageEnd: row.page_end,
		embedding: parseVectorString(row.embedding),
		isQuestion: row.is_question,
		parentChunkId: row.parent_chunk_id,
		metadata: row.metadata ?? {},
		provenance: mapArtifactProvenanceFromDb(row.provenance),
		sensitivityLevel: row.sensitivity_level ?? 'internal',
		sensitivityMetadata: normalizeSensitivityMetadata(row.sensitivity_metadata, row.sensitivity_level ?? 'internal'),
		createdAt: row.created_at,
	};
}

// ────────────────────────────────────────────────────────────
// Embedding formatting
// ────────────────────────────────────────────────────────────

/**
 * Formats a `number[]` embedding as a pgvector literal string `[0.1,0.2,...]`.
 * Returns `null` for null/undefined input.
 */
function formatEmbedding(embedding: number[] | null | undefined): string | null {
	if (embedding === null || embedding === undefined) {
		return null;
	}
	return `[${embedding.join(',')}]`;
}

// ────────────────────────────────────────────────────────────
// Single chunk CRUD
// ────────────────────────────────────────────────────────────

/**
 * Creates a single chunk record. Idempotent via `ON CONFLICT (id) DO UPDATE`.
 */
export async function createChunk(pool: pg.Pool, input: CreateChunkInput): Promise<Chunk> {
	const embeddingLiteral = formatEmbedding(input.embedding);
	const hasExplicitId = input.id !== undefined;
	const sensitivityLevel = input.sensitivityLevel ?? 'internal';
	const sql = hasExplicitId
		? `
    INSERT INTO chunks (id, story_id, content, chunk_index, page_start, page_end, embedding, is_question, parent_chunk_id, metadata, provenance, sensitivity_level, sensitivity_metadata)
    VALUES ($1, $2, $3, $4, $5, $6, $7::vector, $8, $9, $10, $11::jsonb, $12, $13::jsonb)
    ON CONFLICT (id) DO UPDATE SET
      content = EXCLUDED.content,
      embedding = EXCLUDED.embedding,
      metadata = EXCLUDED.metadata,
      provenance = ${mergeArtifactProvenanceSql('chunks.provenance', 'EXCLUDED.provenance')},
      sensitivity_level = EXCLUDED.sensitivity_level,
      sensitivity_metadata = EXCLUDED.sensitivity_metadata
    RETURNING *, embedding::text
  `
		: `
    INSERT INTO chunks (story_id, content, chunk_index, page_start, page_end, embedding, is_question, parent_chunk_id, metadata, provenance, sensitivity_level, sensitivity_metadata)
    VALUES ($1, $2, $3, $4, $5, $6::vector, $7, $8, $9, $10::jsonb, $11, $12::jsonb)
    RETURNING *, embedding::text
  `;
	const legacySql = hasExplicitId
		? `
    INSERT INTO chunks (id, story_id, content, chunk_index, page_start, page_end, embedding, is_question, parent_chunk_id, metadata, provenance)
    VALUES ($1, $2, $3, $4, $5, $6, $7::vector, $8, $9, $10, $11::jsonb)
    ON CONFLICT (id) DO UPDATE SET
      content = EXCLUDED.content,
      embedding = EXCLUDED.embedding,
      metadata = EXCLUDED.metadata,
      provenance = ${mergeArtifactProvenanceSql('chunks.provenance', 'EXCLUDED.provenance')}
    RETURNING *, embedding::text
  `
		: `
    INSERT INTO chunks (story_id, content, chunk_index, page_start, page_end, embedding, is_question, parent_chunk_id, metadata, provenance)
    VALUES ($1, $2, $3, $4, $5, $6::vector, $7, $8, $9, $10::jsonb)
    RETURNING *, embedding::text
  `;
	const baseParams = [
		input.storyId,
		input.content,
		input.chunkIndex,
		input.pageStart ?? null,
		input.pageEnd ?? null,
		embeddingLiteral,
		input.isQuestion ?? false,
		input.parentChunkId ?? null,
		JSON.stringify(input.metadata ?? {}),
		stringifyArtifactProvenance(input.provenance),
		sensitivityLevel,
		stringifySensitivityMetadata(input.sensitivityMetadata, sensitivityLevel),
	];
	const params = hasExplicitId ? [input.id, ...baseParams] : baseParams;
	const legacyBaseParams = baseParams.slice(0, -2);
	const legacyParams = hasExplicitId ? [input.id, ...legacyBaseParams] : legacyBaseParams;

	try {
		const result = await queryWithSensitivityColumnFallback<ChunkRow>(pool, sql, params, legacySql, legacyParams);
		const row = result.rows[0];
		repoLogger.debug({ chunkId: row.id, storyId: input.storyId }, 'Chunk created');
		return mapChunkRow(row);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to create chunk', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { storyId: input.storyId, chunkIndex: input.chunkIndex },
		});
	}
}

/**
 * Batch-creates multiple chunks in a single multi-row INSERT.
 *
 * Uses `unnest` arrays for performance (50+ chunks per story is common).
 * Idempotent via `ON CONFLICT (story_id, chunk_index, is_question) DO UPDATE`
 * to handle re-runs.
 */
export async function createChunks(pool: pg.Pool, inputs: CreateChunkInput[]): Promise<Chunk[]> {
	if (inputs.length === 0) {
		return [];
	}

	// Build arrays for unnest
	const storyIds: string[] = [];
	const contents: string[] = [];
	const chunkIndexes: number[] = [];
	const pageStarts: (number | null)[] = [];
	const pageEnds: (number | null)[] = [];
	const embeddings: (string | null)[] = [];
	const isQuestions: boolean[] = [];
	const parentChunkIds: (string | null)[] = [];
	const metadatas: string[] = [];
	const provenances: string[] = [];
	const sensitivityLevels: string[] = [];
	const sensitivityMetadatas: string[] = [];

	for (const input of inputs) {
		storyIds.push(input.storyId);
		contents.push(input.content);
		chunkIndexes.push(input.chunkIndex);
		pageStarts.push(input.pageStart ?? null);
		pageEnds.push(input.pageEnd ?? null);
		embeddings.push(formatEmbedding(input.embedding));
		isQuestions.push(input.isQuestion ?? false);
		parentChunkIds.push(input.parentChunkId ?? null);
		metadatas.push(JSON.stringify(input.metadata ?? {}));
		provenances.push(stringifyArtifactProvenance(input.provenance));
		const sensitivityLevel = input.sensitivityLevel ?? 'internal';
		sensitivityLevels.push(sensitivityLevel);
		sensitivityMetadatas.push(stringifySensitivityMetadata(input.sensitivityMetadata, sensitivityLevel));
	}

	const sql = `
    INSERT INTO chunks (story_id, content, chunk_index, page_start, page_end, embedding, is_question, parent_chunk_id, metadata, provenance, sensitivity_level, sensitivity_metadata)
    SELECT
      unnest($1::uuid[]),
      unnest($2::text[]),
      unnest($3::integer[]),
      unnest($4::integer[]),
      unnest($5::integer[]),
      unnest($6::vector[]),
      unnest($7::boolean[]),
      unnest($8::uuid[]),
      unnest($9::jsonb[]),
      unnest($10::jsonb[]),
      unnest($11::text[]),
      unnest($12::jsonb[])
    RETURNING *, embedding::text
  `;

	try {
		const result = await pool.query<ChunkRow>(sql, [
			storyIds,
			contents,
			chunkIndexes,
			pageStarts,
			pageEnds,
			embeddings,
			isQuestions,
			parentChunkIds,
			metadatas,
			provenances,
			sensitivityLevels,
			sensitivityMetadatas,
		]);
		repoLogger.debug({ count: result.rows.length, storyId: inputs[0].storyId }, 'Batch chunks created');
		return result.rows.map(mapChunkRow);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to batch create chunks', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { count: inputs.length, storyId: inputs[0].storyId },
		});
	}
}

// ────────────────────────────────────────────────────────────
// Read operations
// ────────────────────────────────────────────────────────────

/**
 * Finds a chunk by its UUID.
 *
 * @returns The chunk, or `null` if not found.
 */
export async function findChunkById(
	pool: pg.Pool,
	id: string,
	options?: { includeDeleted?: boolean },
): Promise<Chunk | null> {
	const sql = `
    SELECT c.*, c.embedding::text
    FROM chunks c
    JOIN stories s ON s.id = c.story_id
    JOIN sources src ON src.id = s.source_id
    WHERE c.id = $1
      ${options?.includeDeleted ? '' : "AND src.deletion_status NOT IN ('soft_deleted', 'purging', 'purged')"}
  `;
	const legacySql = `
    SELECT c.*, c.embedding::text
    FROM chunks c
    JOIN stories s ON s.id = c.story_id
    JOIN sources src ON src.id = s.source_id
    WHERE c.id = $1
  `;

	try {
		const result = await queryWithSourceDeletionStatusFallback<ChunkRow>(pool, sql, [id], legacySql, [id]);
		if (result.rows.length === 0) {
			return null;
		}
		return mapChunkRow(result.rows[0]);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to find chunk by ID', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { id },
		});
	}
}

/**
 * Finds all chunks belonging to a story, ordered by chunk_index.
 *
 * Supports optional filtering by `isQuestion` flag.
 */
export async function findChunksByStoryId(
	pool: pg.Pool,
	storyId: string,
	filter?: { isQuestion?: boolean; includeDeleted?: boolean },
): Promise<Chunk[]> {
	const conditions = ['c.story_id = $1'];
	const params: unknown[] = [storyId];
	let paramIndex = 2;

	if (filter?.isQuestion !== undefined) {
		conditions.push(`c.is_question = $${paramIndex}`);
		params.push(filter.isQuestion);
		paramIndex++;
	}
	const legacyConditions = [...conditions];
	if (!filter?.includeDeleted) {
		conditions.push("src.deletion_status NOT IN ('soft_deleted', 'purging', 'purged')");
	}

	const sql = `
    SELECT c.*, c.embedding::text
    FROM chunks c
    JOIN stories s ON s.id = c.story_id
    JOIN sources src ON src.id = s.source_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY c.chunk_index ASC
  `;
	const legacySql = `
    SELECT c.*, c.embedding::text
    FROM chunks c
    JOIN stories s ON s.id = c.story_id
    JOIN sources src ON src.id = s.source_id
    WHERE ${legacyConditions.join(' AND ')}
    ORDER BY c.chunk_index ASC
  `;

	try {
		const result = await queryWithSourceDeletionStatusFallback<ChunkRow>(pool, sql, params, legacySql, params);
		return result.rows.map(mapChunkRow);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to find chunks by story ID', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { storyId },
		});
	}
}

/**
 * Finds all chunks belonging to a source (via stories JOIN).
 */
export async function findChunksBySourceId(
	pool: pg.Pool,
	sourceId: string,
	options?: { includeDeleted?: boolean },
): Promise<Chunk[]> {
	const sql = `
    SELECT c.*, c.embedding::text
    FROM chunks c
    JOIN stories s ON s.id = c.story_id
    JOIN sources src ON src.id = s.source_id
    WHERE s.source_id = $1
      ${options?.includeDeleted ? '' : "AND src.deletion_status NOT IN ('soft_deleted', 'purging', 'purged')"}
    ORDER BY c.chunk_index ASC
  `;
	const legacySql = `
    SELECT c.*, c.embedding::text
    FROM chunks c
    JOIN stories s ON s.id = c.story_id
    JOIN sources src ON src.id = s.source_id
    WHERE s.source_id = $1
    ORDER BY c.chunk_index ASC
  `;

	try {
		const result = await queryWithSourceDeletionStatusFallback<ChunkRow>(pool, sql, [sourceId], legacySql, [sourceId]);
		return result.rows.map(mapChunkRow);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to find chunks by source ID', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { sourceId },
		});
	}
}

/**
 * Counts chunks matching the given filter.
 */
export async function countChunks(pool: pg.Pool, filter?: ChunkFilter): Promise<number> {
	const conditions: string[] = [];
	const params: unknown[] = [];
	let paramIndex = 1;

	if (filter?.storyId) {
		conditions.push(`c.story_id = $${paramIndex}`);
		params.push(filter.storyId);
		paramIndex++;
	}

	if (filter?.isQuestion !== undefined) {
		conditions.push(`c.is_question = $${paramIndex}`);
		params.push(filter.isQuestion);
		paramIndex++;
	}
	const legacyConditions = [...conditions];
	if (!filter?.includeDeleted) {
		conditions.push("src.deletion_status NOT IN ('soft_deleted', 'purging', 'purged')");
	}

	const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
	const legacyWhereClause = legacyConditions.length > 0 ? `WHERE ${legacyConditions.join(' AND ')}` : '';
	const sql = `
    SELECT COUNT(*)
    FROM chunks c
    JOIN stories s ON s.id = c.story_id
    JOIN sources src ON src.id = s.source_id
    ${whereClause}
  `;
	const legacySql = `
    SELECT COUNT(*)
    FROM chunks c
    JOIN stories s ON s.id = c.story_id
    JOIN sources src ON src.id = s.source_id
    ${legacyWhereClause}
	`;

	try {
		const result = await queryWithSourceDeletionStatusFallback<{ count: string }>(pool, sql, params, legacySql, params);
		return Number.parseInt(result.rows[0].count, 10);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to count chunks', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { filter },
		});
	}
}

// ────────────────────────────────────────────────────────────
// Delete operations
// ────────────────────────────────────────────────────────────

/**
 * Deletes all chunks belonging to a story. Critical for `--force` re-embed.
 *
 * @returns The number of deleted chunks.
 */
export async function deleteChunksByStoryId(pool: pg.Pool, storyId: string): Promise<number> {
	const sql = 'DELETE FROM chunks WHERE story_id = $1';

	try {
		const result = await pool.query(sql, [storyId]);
		const count = result.rowCount ?? 0;
		if (count > 0) {
			repoLogger.debug({ storyId, count }, 'Chunks deleted for story');
		}
		return count;
	} catch (error: unknown) {
		throw new DatabaseError('Failed to delete chunks by story ID', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { storyId },
		});
	}
}

/**
 * Deletes all chunks belonging to a source (via stories subquery).
 *
 * @returns The number of deleted chunks.
 */
export async function deleteChunksBySourceId(pool: pg.Pool, sourceId: string): Promise<number> {
	const sql = 'DELETE FROM chunks WHERE story_id IN (SELECT id FROM stories WHERE source_id = $1)';

	try {
		const result = await pool.query(sql, [sourceId]);
		const count = result.rowCount ?? 0;
		if (count > 0) {
			repoLogger.debug({ sourceId, count }, 'Chunks deleted for source');
		}
		return count;
	} catch (error: unknown) {
		throw new DatabaseError('Failed to delete chunks by source ID', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { sourceId },
		});
	}
}

// ────────────────────────────────────────────────────────────
// Update operations
// ────────────────────────────────────────────────────────────

/**
 * Updates the embedding vector for a single chunk.
 * Used when embedding is generated after chunk creation.
 */
export async function updateChunkEmbedding(pool: pg.Pool, chunkId: string, embedding: number[]): Promise<void> {
	const sql = 'UPDATE chunks SET embedding = $2::vector WHERE id = $1';
	const embeddingLiteral = formatEmbedding(embedding);

	try {
		const result = await pool.query(sql, [chunkId, embeddingLiteral]);
		if ((result.rowCount ?? 0) === 0) {
			throw new DatabaseError(`Chunk not found: ${chunkId}`, DATABASE_ERROR_CODES.DB_NOT_FOUND, {
				context: { chunkId },
			});
		}
		repoLogger.debug({ chunkId }, 'Chunk embedding updated');
	} catch (error: unknown) {
		if (error instanceof DatabaseError) {
			throw error;
		}
		throw new DatabaseError('Failed to update chunk embedding', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { chunkId },
		});
	}
}

// ────────────────────────────────────────────────────────────
// Vector search
// ────────────────────────────────────────────────────────────

/**
 * Searches for similar chunks by cosine distance using the HNSW index.
 *
 * Uses the `<=>` operator (cosine distance). Distance → similarity: `1 - distance`.
 * Results are ordered by similarity descending (closest first).
 */
export async function searchByVector(
	pool: pg.Pool,
	queryEmbedding: number[],
	limit: number,
	filter?: { storyIds?: string[] },
): Promise<VectorSearchResult[]> {
	const embeddingLiteral = formatEmbedding(queryEmbedding);
	const conditions = ['chunks.embedding IS NOT NULL'];
	const params: unknown[] = [embeddingLiteral, limit];
	let paramIndex = 3;

	if (filter?.storyIds && filter.storyIds.length > 0) {
		conditions.push(`chunks.story_id = ANY($${paramIndex}::uuid[])`);
		params.push(filter.storyIds);
		paramIndex++;
	}

	const whereClause = conditions.join(' AND ');
	const sql = `
    SELECT chunks.*, chunks.embedding::text, (chunks.embedding <=> $1::vector) AS distance
    FROM chunks
    JOIN stories ON stories.id = chunks.story_id
    JOIN sources ON sources.id = stories.source_id
    WHERE ${whereClause}
      AND sources.deletion_status NOT IN ('soft_deleted', 'purging', 'purged')
    ORDER BY chunks.embedding <=> $1::vector
    LIMIT $2
  `;

	try {
		const result = await pool.query<ChunkRow & { distance: number }>(sql, params);
		return result.rows.map((row) => {
			const distance = Number(row.distance);
			return {
				chunk: mapChunkRow(row),
				distance,
				similarity: 1 - distance,
			};
		});
	} catch (error: unknown) {
		throw new DatabaseError('Failed to search chunks by vector', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { limit, hasFilter: !!filter?.storyIds },
		});
	}
}

/**
 * Same as `searchByVector` but sets `hnsw.ef_search` on the connection
 * for the duration of the query. Use when the retrieval layer needs higher
 * recall than the global default. Higher `efSearch` trades query speed
 * for recall quality.
 *
 * Implementation notes:
 *   - Acquires a dedicated client from the pool so that `SET LOCAL` applies
 *     to the same session as the SELECT (sessions in pg's pool are not
 *     shared across queries).
 *   - Wraps the SET + SELECT in a single transaction so `SET LOCAL` is
 *     scoped correctly and rolled back on error.
 *   - The `efSearch` value is interpolated into the SQL string because
 *     PostgreSQL `SET` does not accept bind parameters. To prevent SQL
 *     injection, the caller-provided value is validated as a finite
 *     positive integer before interpolation. This is the only place in
 *     the codebase where SQL interpolation is unavoidable.
 */
export async function searchByVectorWithEfSearch(
	pool: pg.Pool,
	queryEmbedding: number[],
	limit: number,
	efSearch: number,
	filter?: { storyIds?: string[] },
): Promise<VectorSearchResult[]> {
	// SQL-injection guard: SET cannot use bind parameters, so we must validate
	// the integer client-side before string-interpolating it into the SQL.
	if (!Number.isInteger(efSearch) || efSearch <= 0) {
		throw new DatabaseError(
			`Invalid hnsw.ef_search value: must be a positive integer, got ${String(efSearch)}`,
			DATABASE_ERROR_CODES.DB_QUERY_FAILED,
			{ context: { efSearch } },
		);
	}

	const embeddingLiteral = formatEmbedding(queryEmbedding);
	const conditions = ['chunks.embedding IS NOT NULL'];
	const params: unknown[] = [embeddingLiteral, limit];
	let paramIndex = 3;

	if (filter?.storyIds && filter.storyIds.length > 0) {
		conditions.push(`chunks.story_id = ANY($${paramIndex}::uuid[])`);
		params.push(filter.storyIds);
		paramIndex++;
	}

	const whereClause = conditions.join(' AND ');
	const sql = `
    SELECT chunks.*, chunks.embedding::text, (chunks.embedding <=> $1::vector) AS distance
    FROM chunks
    JOIN stories ON stories.id = chunks.story_id
    JOIN sources ON sources.id = stories.source_id
    WHERE ${whereClause}
      AND sources.deletion_status NOT IN ('soft_deleted', 'purging', 'purged')
    ORDER BY chunks.embedding <=> $1::vector
    LIMIT $2
  `;

	const client = await pool.connect();
	try {
		await client.query('BEGIN');
		try {
			// Safe interpolation: efSearch was validated above as a positive integer.
			await client.query(`SET LOCAL hnsw.ef_search = ${efSearch}`);
			const result = await client.query<ChunkRow & { distance: number }>(sql, params);
			await client.query('COMMIT');
			return result.rows.map((row) => {
				const distance = Number(row.distance);
				return {
					chunk: mapChunkRow(row),
					distance,
					similarity: 1 - distance,
				};
			});
		} catch (innerError: unknown) {
			await client.query('ROLLBACK');
			throw innerError;
		}
	} catch (error: unknown) {
		if (error instanceof DatabaseError) {
			throw error;
		}
		throw new DatabaseError('Failed to search chunks by vector with ef_search', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { limit, efSearch, hasFilter: !!filter?.storyIds },
		});
	} finally {
		client.release();
	}
}

// ────────────────────────────────────────────────────────────
// Full-text search
// ────────────────────────────────────────────────────────────

/**
 * Searches chunks by full-text query using the generated `fts_vector` column.
 *
 * Uses `plainto_tsquery('simple', ...)` matching the generated column's
 * `to_tsvector('simple', content)`.
 *
 * The optional `filter.excludeQuestions` flag appends a WHERE clause
 * restricting results to content chunks (`is_question = false`). It defaults
 * to `false` so the legacy 3-arg call signature `searchByFts(pool, q, limit)`
 * continues to return chunks regardless of `is_question`. The retrieval-layer
 * wrapper (`@mulder/retrieval#fulltextSearch`) enables this flag by default
 * per functional spec §5.1.
 */
export async function searchByFts(
	pool: pg.Pool,
	query: string,
	limit: number,
	filter?: { storyIds?: string[]; excludeQuestions?: boolean },
): Promise<FtsSearchResult[]> {
	const conditions = ["chunks.fts_vector @@ plainto_tsquery('simple', $1)"];
	const params: unknown[] = [query, limit];
	let paramIndex = 3;

	if (filter?.storyIds && filter.storyIds.length > 0) {
		conditions.push(`chunks.story_id = ANY($${paramIndex}::uuid[])`);
		params.push(filter.storyIds);
		paramIndex++;
	}

	if (filter?.excludeQuestions === true) {
		// Literal boolean predicate — no bind parameter needed and no SQL
		// injection risk because the value is not user-controlled.
		conditions.push('chunks.is_question = false');
	}

	const whereClause = conditions.join(' AND ');
	const sql = `
    SELECT chunks.*, chunks.embedding::text,
      ts_rank(chunks.fts_vector, plainto_tsquery('simple', $1)) AS rank
    FROM chunks
    JOIN stories ON stories.id = chunks.story_id
    JOIN sources ON sources.id = stories.source_id
    WHERE ${whereClause}
      AND sources.deletion_status NOT IN ('soft_deleted', 'purging', 'purged')
    ORDER BY ts_rank(chunks.fts_vector, plainto_tsquery('simple', $1)) DESC
    LIMIT $2
  `;

	try {
		const result = await pool.query<ChunkRow & { rank: number }>(sql, params);
		return result.rows.map((row) => ({
			chunk: mapChunkRow(row),
			rank: Number(row.rank),
		}));
	} catch (error: unknown) {
		throw new DatabaseError('Failed to search chunks by FTS', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: {
				query,
				limit,
				hasFilter: !!filter?.storyIds,
				excludeQuestions: filter?.excludeQuestions === true,
			},
		});
	}
}
