/**
 * Story repository — CRUD operations for the `stories` table.
 *
 * Plain functions that accept a `pg.Pool` as the first argument (same pattern
 * as `source.repository.ts`). No class wrapper — keeps it simple and testable.
 *
 * All queries use parameterized SQL. Inserts are idempotent via ON CONFLICT.
 *
 * @see docs/specs/22_story_repository.spec.md §4.1
 * @see docs/functional-spec.md §4.3
 */

import type pg from 'pg';
import { DATABASE_ERROR_CODES, DatabaseError } from '../../shared/errors.js';
import { createChildLogger, createLogger } from '../../shared/logger.js';
import type { CreateStoryInput, Story, StoryFilter, StoryStatus, UpdateStoryInput } from './story.types.js';

const logger = createLogger();
const repoLogger = createChildLogger(logger, { module: 'story-repository' });

// ────────────────────────────────────────────────────────────
// Row mapper (snake_case DB → camelCase TS)
// ────────────────────────────────────────────────────────────

/** @internal Exported for use by related repositories (story-entity). */
export interface StoryRow {
	id: string;
	source_id: string;
	title: string;
	subtitle: string | null;
	language: string | null;
	category: string | null;
	page_start: number | null;
	page_end: number | null;
	gcs_markdown_uri: string;
	gcs_metadata_uri: string;
	chunk_count: number;
	extraction_confidence: number | null;
	status: StoryStatus;
	metadata: Record<string, unknown>;
	created_at: Date;
	updated_at: Date;
}

/** @internal Exported for use by related repositories (story-entity). */
export function mapStoryRow(row: StoryRow): Story {
	return {
		id: row.id,
		sourceId: row.source_id,
		title: row.title,
		subtitle: row.subtitle,
		language: row.language,
		category: row.category,
		pageStart: row.page_start,
		pageEnd: row.page_end,
		gcsMarkdownUri: row.gcs_markdown_uri,
		gcsMetadataUri: row.gcs_metadata_uri,
		chunkCount: row.chunk_count,
		extractionConfidence: row.extraction_confidence,
		status: row.status,
		metadata: row.metadata ?? {},
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

// ────────────────────────────────────────────────────────────
// Story CRUD
// ────────────────────────────────────────────────────────────

/**
 * Creates a new story record. Idempotent via `ON CONFLICT (id) DO UPDATE`.
 *
 * Since stories don't have a natural unique key like file_hash, the segment
 * step generates UUIDs and may re-run. On conflict (same ID), the existing
 * record is returned with an updated `updated_at` timestamp.
 */
export async function createStory(pool: pg.Pool, input: CreateStoryInput): Promise<Story> {
	// When an explicit ID is provided (e.g. from the segment step), include it
	// in the INSERT so the DB record matches GCS paths and metadata JSON.
	const hasExplicitId = input.id !== undefined;
	const sql = hasExplicitId
		? `
    INSERT INTO stories (id, source_id, title, subtitle, language, category, page_start, page_end, gcs_markdown_uri, gcs_metadata_uri, extraction_confidence, metadata)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    ON CONFLICT (id) DO UPDATE SET updated_at = now()
    RETURNING *
  `
		: `
    INSERT INTO stories (source_id, title, subtitle, language, category, page_start, page_end, gcs_markdown_uri, gcs_metadata_uri, extraction_confidence, metadata)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    ON CONFLICT (id) DO UPDATE SET updated_at = now()
    RETURNING *
  `;
	const baseParams = [
		input.sourceId,
		input.title,
		input.subtitle ?? null,
		input.language ?? null,
		input.category ?? null,
		input.pageStart ?? null,
		input.pageEnd ?? null,
		input.gcsMarkdownUri,
		input.gcsMetadataUri,
		input.extractionConfidence ?? null,
		JSON.stringify(input.metadata ?? {}),
	];
	const params = hasExplicitId ? [input.id, ...baseParams] : baseParams;

	try {
		const result = await pool.query<StoryRow>(sql, params);
		const row = result.rows[0];
		repoLogger.debug({ storyId: row.id, sourceId: input.sourceId }, 'Story created or found');
		return mapStoryRow(row);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to create story', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { sourceId: input.sourceId, title: input.title },
		});
	}
}

/**
 * Finds a story by its UUID.
 *
 * @returns The story, or `null` if not found.
 */
export async function findStoryById(pool: pg.Pool, id: string): Promise<Story | null> {
	const sql = 'SELECT * FROM stories WHERE id = $1';

	try {
		const result = await pool.query<StoryRow>(sql, [id]);
		if (result.rows.length === 0) {
			return null;
		}
		return mapStoryRow(result.rows[0]);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to find story by ID', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { id },
		});
	}
}

/**
 * Finds all stories belonging to a source, ordered by page position.
 *
 * Stories from the same source appear in page order (page_start ASC),
 * with nulls last. Ties broken by created_at ASC.
 */
export async function findStoriesBySourceId(pool: pg.Pool, sourceId: string): Promise<Story[]> {
	const sql = 'SELECT * FROM stories WHERE source_id = $1 ORDER BY page_start ASC NULLS LAST, created_at ASC';

	try {
		const result = await pool.query<StoryRow>(sql, [sourceId]);
		return result.rows.map(mapStoryRow);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to find stories by source ID', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { sourceId },
		});
	}
}

/**
 * Finds all stories matching the given filter.
 *
 * Supports filtering by sourceId, status, category, and language,
 * with pagination via limit/offset. Results ordered by created_at DESC.
 */
export async function findAllStories(pool: pg.Pool, filter?: StoryFilter): Promise<Story[]> {
	const conditions: string[] = [];
	const params: unknown[] = [];
	let paramIndex = 1;

	if (filter?.sourceId) {
		conditions.push(`source_id = $${paramIndex}`);
		params.push(filter.sourceId);
		paramIndex++;
	}

	if (filter?.status) {
		conditions.push(`status = $${paramIndex}`);
		params.push(filter.status);
		paramIndex++;
	}

	if (filter?.category) {
		conditions.push(`category = $${paramIndex}`);
		params.push(filter.category);
		paramIndex++;
	}

	if (filter?.language) {
		conditions.push(`language = $${paramIndex}`);
		params.push(filter.language);
		paramIndex++;
	}

	const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

	const limit = filter?.limit ?? 100;
	const offset = filter?.offset ?? 0;

	const sql = `SELECT * FROM stories ${whereClause} ORDER BY created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
	params.push(limit, offset);

	try {
		const result = await pool.query<StoryRow>(sql, params);
		return result.rows.map(mapStoryRow);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to find stories', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { filter },
		});
	}
}

/**
 * Counts stories matching the given filter. For pagination and status overview.
 */
export async function countStories(pool: pg.Pool, filter?: StoryFilter): Promise<number> {
	const conditions: string[] = [];
	const params: unknown[] = [];
	let paramIndex = 1;

	if (filter?.sourceId) {
		conditions.push(`source_id = $${paramIndex}`);
		params.push(filter.sourceId);
		paramIndex++;
	}

	if (filter?.status) {
		conditions.push(`status = $${paramIndex}`);
		params.push(filter.status);
		paramIndex++;
	}

	if (filter?.category) {
		conditions.push(`category = $${paramIndex}`);
		params.push(filter.category);
		paramIndex++;
	}

	if (filter?.language) {
		conditions.push(`language = $${paramIndex}`);
		params.push(filter.language);
		paramIndex++;
	}

	const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
	const sql = `SELECT COUNT(*) FROM stories ${whereClause}`;

	try {
		const result = await pool.query<{ count: string }>(sql, params);
		return Number.parseInt(result.rows[0].count, 10);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to count stories', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { filter },
		});
	}
}

/**
 * Updates a story record. Only provided fields are updated.
 * Sets `updated_at = now()` automatically.
 *
 * @throws {DatabaseError} with `DB_NOT_FOUND` if the story does not exist.
 */
export async function updateStory(pool: pg.Pool, id: string, input: UpdateStoryInput): Promise<Story> {
	const setClauses: string[] = [];
	const params: unknown[] = [];
	let paramIndex = 1;

	const fieldMap: Array<[keyof UpdateStoryInput, string]> = [
		['title', 'title'],
		['subtitle', 'subtitle'],
		['language', 'language'],
		['category', 'category'],
		['pageStart', 'page_start'],
		['pageEnd', 'page_end'],
		['gcsMarkdownUri', 'gcs_markdown_uri'],
		['gcsMetadataUri', 'gcs_metadata_uri'],
		['chunkCount', 'chunk_count'],
		['extractionConfidence', 'extraction_confidence'],
		['status', 'status'],
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

	// Always update the timestamp
	setClauses.push('updated_at = now()');

	params.push(id);
	const sql = `UPDATE stories SET ${setClauses.join(', ')} WHERE id = $${paramIndex} RETURNING *`;

	try {
		const result = await pool.query<StoryRow>(sql, params);
		if (result.rows.length === 0) {
			throw new DatabaseError(`Story not found: ${id}`, DATABASE_ERROR_CODES.DB_NOT_FOUND, {
				context: { id },
			});
		}
		repoLogger.debug({ storyId: id }, 'Story updated');
		return mapStoryRow(result.rows[0]);
	} catch (error: unknown) {
		if (error instanceof DatabaseError) {
			throw error;
		}
		throw new DatabaseError('Failed to update story', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { id, fields: Object.keys(input) },
		});
	}
}

/**
 * Convenience function to update only the story status.
 * Sets `updated_at = now()` automatically.
 *
 * @throws {DatabaseError} with `DB_NOT_FOUND` if the story does not exist.
 */
export async function updateStoryStatus(pool: pg.Pool, id: string, status: StoryStatus): Promise<Story> {
	const sql = 'UPDATE stories SET status = $1, updated_at = now() WHERE id = $2 RETURNING *';

	try {
		const result = await pool.query<StoryRow>(sql, [status, id]);
		if (result.rows.length === 0) {
			throw new DatabaseError(`Story not found: ${id}`, DATABASE_ERROR_CODES.DB_NOT_FOUND, {
				context: { id, status },
			});
		}
		repoLogger.debug({ storyId: id, status }, 'Story status updated');
		return mapStoryRow(result.rows[0]);
	} catch (error: unknown) {
		if (error instanceof DatabaseError) {
			throw error;
		}
		throw new DatabaseError('Failed to update story status', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { id, status },
		});
	}
}

/**
 * Deletes a story by ID. Cascades to child tables via ON DELETE CASCADE.
 *
 * @returns `true` if the story was deleted, `false` if it didn't exist.
 */
export async function deleteStory(pool: pg.Pool, id: string): Promise<boolean> {
	const sql = 'DELETE FROM stories WHERE id = $1';

	try {
		const result = await pool.query(sql, [id]);
		const deleted = (result.rowCount ?? 0) > 0;
		if (deleted) {
			repoLogger.debug({ storyId: id }, 'Story deleted');
		}
		return deleted;
	} catch (error: unknown) {
		throw new DatabaseError('Failed to delete story', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { id },
		});
	}
}

/**
 * Deletes all stories belonging to a source. Critical for `--force`
 * re-segmentation (delete all stories for a source before re-creating).
 *
 * @returns The number of deleted stories.
 */
export async function deleteStoriesBySourceId(pool: pg.Pool, sourceId: string): Promise<number> {
	const sql = 'DELETE FROM stories WHERE source_id = $1';

	try {
		const result = await pool.query(sql, [sourceId]);
		const count = result.rowCount ?? 0;
		if (count > 0) {
			repoLogger.debug({ sourceId, count }, 'Stories deleted for source');
		}
		return count;
	} catch (error: unknown) {
		throw new DatabaseError('Failed to delete stories by source ID', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { sourceId },
		});
	}
}
