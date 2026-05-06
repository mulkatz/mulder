/**
 * Edge repository -- CRUD operations for the `entity_edges` table.
 *
 * Plain functions that accept a `pg.Pool` as the first argument (same pattern
 * as `entity.repository.ts`). No class wrapper.
 *
 * All queries use parameterized SQL. Upserts are idempotent via a partial
 * unique index (migration 016) on edges WITH a story_id.
 *
 * @see docs/specs/25_edge_repository.spec.md §4.2
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
import type { CreateEdgeInput, EdgeFilter, EdgeType, EntityEdge, UpdateEdgeInput } from './edge.types.js';
import { queryWithSensitivityColumnFallback, queryWithSourceDeletionStatusFallback } from './schema-compat.js';

const logger = createLogger();
const repoLogger = createChildLogger(logger, { module: 'edge-repository' });

function edgeActiveSourceClause(edgeAlias: string): string {
	return `
    (
      EXISTS (
        SELECT 1
        FROM jsonb_array_elements_text(COALESCE(${edgeAlias}.provenance->'source_document_ids', '[]'::jsonb)) AS edge_sources(source_id)
        JOIN sources edge_src ON edge_src.id::text = edge_sources.source_id
        WHERE edge_src.deletion_status NOT IN ('soft_deleted', 'purging', 'purged')
      )
      OR EXISTS (
        SELECT 1
        FROM stories edge_story
        JOIN sources edge_story_src ON edge_story_src.id = edge_story.source_id
        WHERE edge_story.id = ${edgeAlias}.story_id
          AND edge_story_src.deletion_status NOT IN ('soft_deleted', 'purging', 'purged')
      )
      OR (
        ${edgeAlias}.story_id IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(COALESCE(${edgeAlias}.provenance->'source_document_ids', '[]'::jsonb)) AS edge_sources(source_id)
        )
      )
    )
  `;
}

// ────────────────────────────────────────────────────────────
// Row mapper (snake_case DB -> camelCase TS)
// ────────────────────────────────────────────────────────────

interface EdgeRow {
	id: string;
	source_entity_id: string;
	target_entity_id: string;
	relationship: string;
	attributes: Record<string, unknown>;
	confidence: number | null;
	story_id: string | null;
	edge_type: EdgeType;
	analysis: Record<string, unknown> | null;
	provenance: unknown;
	sensitivity_level: EntityEdge['sensitivityLevel'];
	sensitivity_metadata: unknown;
	created_at: Date;
}

function mapEdgeRow(row: EdgeRow): EntityEdge {
	return {
		id: row.id,
		sourceEntityId: row.source_entity_id,
		targetEntityId: row.target_entity_id,
		relationship: row.relationship,
		attributes: row.attributes ?? {},
		confidence: row.confidence,
		storyId: row.story_id,
		edgeType: row.edge_type,
		analysis: row.analysis,
		provenance: mapArtifactProvenanceFromDb(row.provenance),
		sensitivityLevel: row.sensitivity_level ?? 'internal',
		sensitivityMetadata: normalizeSensitivityMetadata(row.sensitivity_metadata, row.sensitivity_level ?? 'internal'),
		createdAt: row.created_at,
	};
}

// ────────────────────────────────────────────────────────────
// Edge CRUD
// ────────────────────────────────────────────────────────────

/**
 * Creates a new edge record. Plain INSERT with optional pre-generated UUID.
 */
export async function createEdge(pool: pg.Pool, input: CreateEdgeInput): Promise<EntityEdge> {
	const hasExplicitId = input.id !== undefined;
	const sensitivityLevel = input.sensitivityLevel ?? 'internal';
	const sql = hasExplicitId
		? `
    INSERT INTO entity_edges (id, source_entity_id, target_entity_id, relationship, attributes, confidence, story_id, edge_type, analysis, provenance, sensitivity_level, sensitivity_metadata)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12::jsonb)
    RETURNING *
  `
		: `
    INSERT INTO entity_edges (source_entity_id, target_entity_id, relationship, attributes, confidence, story_id, edge_type, analysis, provenance, sensitivity_level, sensitivity_metadata)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11::jsonb)
    RETURNING *
  `;
	const legacySql = hasExplicitId
		? `
    INSERT INTO entity_edges (id, source_entity_id, target_entity_id, relationship, attributes, confidence, story_id, edge_type, analysis, provenance)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
    RETURNING *
  `
		: `
    INSERT INTO entity_edges (source_entity_id, target_entity_id, relationship, attributes, confidence, story_id, edge_type, analysis, provenance)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
    RETURNING *
  `;

	const baseParams = [
		input.sourceEntityId,
		input.targetEntityId,
		input.relationship,
		JSON.stringify(input.attributes ?? {}),
		input.confidence ?? null,
		input.storyId ?? null,
		input.edgeType ?? 'RELATIONSHIP',
		input.analysis ? JSON.stringify(input.analysis) : null,
		stringifyArtifactProvenance(input.provenance),
		sensitivityLevel,
		stringifySensitivityMetadata(input.sensitivityMetadata, sensitivityLevel),
	];
	const params = hasExplicitId ? [input.id, ...baseParams] : baseParams;
	const legacyBaseParams = baseParams.slice(0, -2);
	const legacyParams = hasExplicitId ? [input.id, ...legacyBaseParams] : legacyBaseParams;

	try {
		const result = await queryWithSensitivityColumnFallback<EdgeRow>(pool, sql, params, legacySql, legacyParams);
		const row = result.rows[0];
		repoLogger.debug({ edgeId: row.id, relationship: input.relationship, edgeType: row.edge_type }, 'Edge created');
		return mapEdgeRow(row);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to create edge', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: {
				sourceEntityId: input.sourceEntityId,
				targetEntityId: input.targetEntityId,
				relationship: input.relationship,
			},
		});
	}
}

/**
 * Upserts an edge for idempotent graph step re-runs.
 *
 * Uses the partial unique index `idx_entity_edges_upsert` on
 * (source_entity_id, target_entity_id, relationship, edge_type, story_id)
 * WHERE story_id IS NOT NULL.
 *
 * When `storyId` is not provided (null), falls back to plain `createEdge`
 * behavior (INSERT only, no upsert) because edges without a story_id
 * don't have a natural upsert key.
 */
export async function upsertEdge(pool: pg.Pool, input: CreateEdgeInput): Promise<EntityEdge> {
	// No story_id means no natural upsert key — fall back to plain insert
	if (!input.storyId) {
		return createEdge(pool, input);
	}

	const sensitivityLevel = input.sensitivityLevel ?? 'internal';
	const sql = `
    INSERT INTO entity_edges (source_entity_id, target_entity_id, relationship, attributes, confidence, story_id, edge_type, analysis, provenance, sensitivity_level, sensitivity_metadata)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11::jsonb)
    ON CONFLICT (source_entity_id, target_entity_id, relationship, edge_type, story_id)
    WHERE story_id IS NOT NULL
    DO UPDATE SET
      attributes = EXCLUDED.attributes,
      confidence = EXCLUDED.confidence,
      analysis = EXCLUDED.analysis,
      provenance = ${mergeArtifactProvenanceSql('entity_edges.provenance', 'EXCLUDED.provenance')},
      sensitivity_level = EXCLUDED.sensitivity_level,
      sensitivity_metadata = EXCLUDED.sensitivity_metadata
    RETURNING *
  `;
	const legacySql = `
    INSERT INTO entity_edges (source_entity_id, target_entity_id, relationship, attributes, confidence, story_id, edge_type, analysis, provenance)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
    ON CONFLICT (source_entity_id, target_entity_id, relationship, edge_type, story_id)
    WHERE story_id IS NOT NULL
    DO UPDATE SET
      attributes = EXCLUDED.attributes,
      confidence = EXCLUDED.confidence,
      analysis = EXCLUDED.analysis,
      provenance = ${mergeArtifactProvenanceSql('entity_edges.provenance', 'EXCLUDED.provenance')}
    RETURNING *
  `;

	const params = [
		input.sourceEntityId,
		input.targetEntityId,
		input.relationship,
		JSON.stringify(input.attributes ?? {}),
		input.confidence ?? null,
		input.storyId,
		input.edgeType ?? 'RELATIONSHIP',
		input.analysis ? JSON.stringify(input.analysis) : null,
		stringifyArtifactProvenance(input.provenance),
		sensitivityLevel,
		stringifySensitivityMetadata(input.sensitivityMetadata, sensitivityLevel),
	];
	const legacyParams = params.slice(0, -2);

	try {
		const result = await queryWithSensitivityColumnFallback<EdgeRow>(pool, sql, params, legacySql, legacyParams);
		const row = result.rows[0];
		repoLogger.debug({ edgeId: row.id, relationship: input.relationship, edgeType: row.edge_type }, 'Edge upserted');
		return mapEdgeRow(row);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to upsert edge', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: {
				sourceEntityId: input.sourceEntityId,
				targetEntityId: input.targetEntityId,
				relationship: input.relationship,
				storyId: input.storyId,
			},
		});
	}
}

/**
 * Finds an edge by its UUID.
 *
 * @returns The edge, or `null` if not found.
 */
export async function findEdgeById(
	pool: pg.Pool,
	id: string,
	options?: { includeDeleted?: boolean },
): Promise<EntityEdge | null> {
	const sql = `
    SELECT ee.*
    FROM entity_edges ee
    WHERE ee.id = $1
      ${options?.includeDeleted ? '' : `AND ${edgeActiveSourceClause('ee')}`}
  `;
	const legacySql = `
    SELECT ee.*
    FROM entity_edges ee
    WHERE ee.id = $1
  `;

	try {
		const result = await queryWithSourceDeletionStatusFallback<EdgeRow>(pool, sql, [id], legacySql, [id]);
		if (result.rows.length === 0) {
			return null;
		}
		return mapEdgeRow(result.rows[0]);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to find edge by ID', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { id },
		});
	}
}

/**
 * Finds all outgoing edges from a source entity, ordered by creation time.
 */
export async function findEdgesBySourceEntityId(
	pool: pg.Pool,
	sourceEntityId: string,
	options?: { includeDeleted?: boolean },
): Promise<EntityEdge[]> {
	const sql = `
    SELECT ee.*
    FROM entity_edges ee
    WHERE ee.source_entity_id = $1
      ${options?.includeDeleted ? '' : `AND ${edgeActiveSourceClause('ee')}`}
    ORDER BY ee.created_at
  `;

	try {
		const result = await pool.query<EdgeRow>(sql, [sourceEntityId]);
		return result.rows.map(mapEdgeRow);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to find edges by source entity ID', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { sourceEntityId },
		});
	}
}

/**
 * Finds all incoming edges to a target entity, ordered by creation time.
 */
export async function findEdgesByTargetEntityId(
	pool: pg.Pool,
	targetEntityId: string,
	options?: { includeDeleted?: boolean },
): Promise<EntityEdge[]> {
	const sql = `
    SELECT ee.*
    FROM entity_edges ee
    WHERE ee.target_entity_id = $1
      ${options?.includeDeleted ? '' : `AND ${edgeActiveSourceClause('ee')}`}
    ORDER BY ee.created_at
  `;

	try {
		const result = await pool.query<EdgeRow>(sql, [targetEntityId]);
		return result.rows.map(mapEdgeRow);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to find edges by target entity ID', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { targetEntityId },
		});
	}
}

/**
 * Finds all edges connected to an entity (both directions), ordered by creation time.
 */
export async function findEdgesByEntityId(
	pool: pg.Pool,
	entityId: string,
	options?: { includeDeleted?: boolean },
): Promise<EntityEdge[]> {
	const sql = `
    SELECT ee.*
    FROM entity_edges ee
    WHERE (ee.source_entity_id = $1 OR ee.target_entity_id = $1)
      ${options?.includeDeleted ? '' : `AND ${edgeActiveSourceClause('ee')}`}
    ORDER BY ee.created_at
  `;

	try {
		const result = await pool.query<EdgeRow>(sql, [entityId]);
		return result.rows.map(mapEdgeRow);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to find edges by entity ID', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { entityId },
		});
	}
}

/**
 * Finds all edges referencing a specific story, ordered by creation time.
 */
export async function findEdgesByStoryId(
	pool: pg.Pool,
	storyId: string,
	options?: { includeDeleted?: boolean },
): Promise<EntityEdge[]> {
	const sql = `
    SELECT ee.*
    FROM entity_edges ee
    WHERE ee.story_id = $1
      ${options?.includeDeleted ? '' : `AND ${edgeActiveSourceClause('ee')}`}
    ORDER BY ee.created_at
  `;

	try {
		const result = await pool.query<EdgeRow>(sql, [storyId]);
		return result.rows.map(mapEdgeRow);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to find edges by story ID', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { storyId },
		});
	}
}

/**
 * Finds all edges of a specific type (e.g., all POTENTIAL_CONTRADICTION edges).
 */
export async function findEdgesByType(
	pool: pg.Pool,
	edgeType: EdgeType,
	options?: { includeDeleted?: boolean },
): Promise<EntityEdge[]> {
	const sql = `
    SELECT ee.*
    FROM entity_edges ee
    WHERE ee.edge_type = $1
      ${options?.includeDeleted ? '' : `AND ${edgeActiveSourceClause('ee')}`}
    ORDER BY ee.created_at
  `;

	try {
		const result = await pool.query<EdgeRow>(sql, [edgeType]);
		return result.rows.map(mapEdgeRow);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to find edges by type', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { edgeType },
		});
	}
}

/**
 * Finds all edges between two entities regardless of direction.
 */
export async function findEdgesBetweenEntities(
	pool: pg.Pool,
	entityIdA: string,
	entityIdB: string,
	options?: { includeDeleted?: boolean },
): Promise<EntityEdge[]> {
	const sql = `
    SELECT ee.*
    FROM entity_edges ee
    WHERE (
      (ee.source_entity_id = $1 AND ee.target_entity_id = $2)
      OR (ee.source_entity_id = $2 AND ee.target_entity_id = $1)
    )
      ${options?.includeDeleted ? '' : `AND ${edgeActiveSourceClause('ee')}`}
    ORDER BY ee.created_at
  `;

	try {
		const result = await pool.query<EdgeRow>(sql, [entityIdA, entityIdB]);
		return result.rows.map(mapEdgeRow);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to find edges between entities', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { entityIdA, entityIdB },
		});
	}
}

/**
 * Finds all edges matching the given filter with pagination.
 *
 * Supports combining multiple filter fields (e.g., edgeType + storyId).
 */
export async function findAllEdges(pool: pg.Pool, filter?: EdgeFilter): Promise<EntityEdge[]> {
	const conditions: string[] = [];
	const params: unknown[] = [];
	let paramIndex = 1;

	if (filter?.sourceEntityId) {
		conditions.push(`ee.source_entity_id = $${paramIndex}`);
		params.push(filter.sourceEntityId);
		paramIndex++;
	}

	if (filter?.targetEntityId) {
		conditions.push(`ee.target_entity_id = $${paramIndex}`);
		params.push(filter.targetEntityId);
		paramIndex++;
	}

	if (filter?.edgeType) {
		conditions.push(`ee.edge_type = $${paramIndex}`);
		params.push(filter.edgeType);
		paramIndex++;
	}

	if (filter?.storyId) {
		conditions.push(`ee.story_id = $${paramIndex}`);
		params.push(filter.storyId);
		paramIndex++;
	}

	if (filter?.relationship) {
		conditions.push(`ee.relationship = $${paramIndex}`);
		params.push(filter.relationship);
		paramIndex++;
	}
	if (!filter?.includeDeleted) {
		conditions.push(edgeActiveSourceClause('ee'));
	}

	const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

	const limit = filter?.limit ?? 100;
	const offset = filter?.offset ?? 0;

	const sql = `SELECT ee.* FROM entity_edges ee ${whereClause} ORDER BY ee.created_at ASC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
	params.push(limit, offset);

	try {
		const result = await pool.query<EdgeRow>(sql, params);
		return result.rows.map(mapEdgeRow);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to find edges', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { filter },
		});
	}
}

export interface EdgeTypePageFilter {
	edgeTypes: EdgeType[];
	includeDeleted?: boolean;
	limit?: number;
	offset?: number;
}

/**
 * Finds all edges matching any of the provided edge types with pagination.
 */
export async function findAllEdgesByTypes(pool: pg.Pool, filter: EdgeTypePageFilter): Promise<EntityEdge[]> {
	if (filter.edgeTypes.length === 0) {
		return [];
	}

	const limit = filter.limit ?? 100;
	const offset = filter.offset ?? 0;
	const sql = `
    SELECT ee.*
    FROM entity_edges ee
    WHERE ee.edge_type = ANY($1::text[])
      ${filter.includeDeleted ? '' : `AND ${edgeActiveSourceClause('ee')}`}
    ORDER BY ee.created_at ASC, ee.id ASC
    LIMIT $2 OFFSET $3
  `;

	try {
		const result = await pool.query<EdgeRow>(sql, [filter.edgeTypes, limit, offset]);
		return result.rows.map(mapEdgeRow);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to find edges by type list', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { filter },
		});
	}
}

/**
 * Counts edges matching any of the provided edge types.
 */
export async function countEdgesByTypes(
	pool: pg.Pool,
	edgeTypes: EdgeType[],
	options?: { includeDeleted?: boolean },
): Promise<number> {
	if (edgeTypes.length === 0) {
		return 0;
	}

	const sql = `
    SELECT COUNT(*)
    FROM entity_edges ee
    WHERE ee.edge_type = ANY($1::text[])
      ${options?.includeDeleted ? '' : `AND ${edgeActiveSourceClause('ee')}`}
  `;

	try {
		const result = await pool.query<{ count: string }>(sql, [edgeTypes]);
		return Number.parseInt(result.rows[0].count, 10);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to count edges by type list', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { edgeTypes },
		});
	}
}

/**
 * Counts edges matching the given filter. For pagination and status overview.
 */
export async function countEdges(pool: pg.Pool, filter?: EdgeFilter): Promise<number> {
	const conditions: string[] = [];
	const params: unknown[] = [];
	let paramIndex = 1;

	if (filter?.sourceEntityId) {
		conditions.push(`ee.source_entity_id = $${paramIndex}`);
		params.push(filter.sourceEntityId);
		paramIndex++;
	}

	if (filter?.targetEntityId) {
		conditions.push(`ee.target_entity_id = $${paramIndex}`);
		params.push(filter.targetEntityId);
		paramIndex++;
	}

	if (filter?.edgeType) {
		conditions.push(`ee.edge_type = $${paramIndex}`);
		params.push(filter.edgeType);
		paramIndex++;
	}

	if (filter?.storyId) {
		conditions.push(`ee.story_id = $${paramIndex}`);
		params.push(filter.storyId);
		paramIndex++;
	}

	if (filter?.relationship) {
		conditions.push(`ee.relationship = $${paramIndex}`);
		params.push(filter.relationship);
		paramIndex++;
	}
	if (!filter?.includeDeleted) {
		conditions.push(edgeActiveSourceClause('ee'));
	}

	const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
	const sql = `SELECT COUNT(*) FROM entity_edges ee ${whereClause}`;

	try {
		const result = await pool.query<{ count: string }>(sql, params);
		return Number.parseInt(result.rows[0].count, 10);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to count edges', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { filter },
		});
	}
}

/**
 * Updates an edge record. Only provided fields are updated.
 *
 * @throws {DatabaseError} with `DB_NOT_FOUND` if the edge does not exist.
 */
export async function updateEdge(pool: pg.Pool, id: string, input: UpdateEdgeInput): Promise<EntityEdge> {
	const setClauses: string[] = [];
	const params: unknown[] = [];
	let paramIndex = 1;

	if (input.confidence !== undefined) {
		setClauses.push(`confidence = $${paramIndex}`);
		params.push(input.confidence);
		paramIndex++;
	}

	if (input.edgeType !== undefined) {
		setClauses.push(`edge_type = $${paramIndex}`);
		params.push(input.edgeType);
		paramIndex++;
	}

	// attributes needs JSON.stringify
	if (input.attributes !== undefined) {
		setClauses.push(`attributes = $${paramIndex}`);
		params.push(JSON.stringify(input.attributes));
		paramIndex++;
	}

	// analysis: explicit null clears the field, undefined skips it
	if (input.analysis !== undefined) {
		setClauses.push(`analysis = $${paramIndex}`);
		params.push(input.analysis ? JSON.stringify(input.analysis) : null);
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
		// Nothing to update — just return the existing edge
		const existing = await findEdgeById(pool, id);
		if (!existing) {
			throw new DatabaseError(`Edge not found: ${id}`, DATABASE_ERROR_CODES.DB_NOT_FOUND, {
				context: { id },
			});
		}
		return existing;
	}

	params.push(id);
	const sql = `UPDATE entity_edges SET ${setClauses.join(', ')} WHERE id = $${paramIndex} RETURNING *`;

	try {
		const result = await pool.query<EdgeRow>(sql, params);
		if (result.rows.length === 0) {
			throw new DatabaseError(`Edge not found: ${id}`, DATABASE_ERROR_CODES.DB_NOT_FOUND, {
				context: { id },
			});
		}
		repoLogger.debug({ edgeId: id }, 'Edge updated');
		return mapEdgeRow(result.rows[0]);
	} catch (error: unknown) {
		if (error instanceof DatabaseError) {
			throw error;
		}
		throw new DatabaseError('Failed to update edge', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { id, fields: Object.keys(input) },
		});
	}
}

/**
 * Deletes an edge by ID.
 *
 * @returns `true` if the edge was deleted, `false` if it didn't exist.
 */
export async function deleteEdge(pool: pg.Pool, id: string): Promise<boolean> {
	const sql = 'DELETE FROM entity_edges WHERE id = $1';

	try {
		const result = await pool.query(sql, [id]);
		const deleted = (result.rowCount ?? 0) > 0;
		if (deleted) {
			repoLogger.debug({ edgeId: id }, 'Edge deleted');
		}
		return deleted;
	} catch (error: unknown) {
		throw new DatabaseError('Failed to delete edge', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { id },
		});
	}
}

/**
 * Deletes all edges referencing a story. Used for re-enrichment cleanup.
 *
 * @returns The number of deleted edges.
 */
export async function deleteEdgesByStoryId(pool: pg.Pool, storyId: string): Promise<number> {
	const sql = 'DELETE FROM entity_edges WHERE story_id = $1';

	try {
		const result = await pool.query(sql, [storyId]);
		const count = result.rowCount ?? 0;
		if (count > 0) {
			repoLogger.debug({ storyId, count }, 'Edges deleted for story');
		}
		return count;
	} catch (error: unknown) {
		throw new DatabaseError('Failed to delete edges by story ID', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { storyId },
		});
	}
}

/**
 * Deletes all edges for all stories belonging to a source.
 * Used for `--force` cleanup at source level.
 *
 * @returns The number of deleted edges.
 */
export async function deleteEdgesBySourceId(pool: pg.Pool, sourceId: string): Promise<number> {
	const sql = `
    DELETE FROM entity_edges
    WHERE story_id IN (SELECT id FROM stories WHERE source_id = $1)
  `;

	try {
		const result = await pool.query(sql, [sourceId]);
		const count = result.rowCount ?? 0;
		if (count > 0) {
			repoLogger.debug({ sourceId, count }, 'Edges deleted for source');
		}
		return count;
	} catch (error: unknown) {
		throw new DatabaseError('Failed to delete edges by source ID', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { sourceId },
		});
	}
}

/**
 * Deletes graph-derived edges for all stories belonging to a source while
 * preserving RELATIONSHIP edges emitted by enrichment.
 *
 * Used by selective reprocessing when graph artifacts need refreshing without
 * discarding the freshly extracted relationship graph.
 *
 * @returns The number of deleted edges.
 */
export async function deleteGraphDerivedEdgesBySourceId(pool: pg.Pool, sourceId: string): Promise<number> {
	const sql = `
    WITH source_story_ids AS (
      SELECT id::text AS id FROM stories WHERE source_id = $1
    )
    DELETE FROM entity_edges
    WHERE (
        story_id::text IN (SELECT id FROM source_story_ids)
        OR attributes->>'storyIdA' IN (SELECT id FROM source_story_ids)
        OR attributes->>'storyIdB' IN (SELECT id FROM source_story_ids)
      )
      AND (
        edge_type IN ('DUPLICATE_OF', 'POTENTIAL_CONTRADICTION', 'CONFIRMED_CONTRADICTION', 'DISMISSED_CONTRADICTION')
        OR (
          edge_type = 'RELATIONSHIP'
          AND attributes->>'generatedBy' = 'graph.cooccurrence_fallback'
        )
      )
  `;

	try {
		const result = await pool.query(sql, [sourceId]);
		const count = result.rowCount ?? 0;
		if (count > 0) {
			repoLogger.debug({ sourceId, count }, 'Graph-derived edges deleted for source');
		}
		return count;
	} catch (error: unknown) {
		throw new DatabaseError('Failed to delete graph-derived edges by source ID', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { sourceId },
		});
	}
}
