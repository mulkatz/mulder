/**
 * Entity repository -- CRUD operations for the `entities` table.
 *
 * Plain functions that accept a `pg.Pool` as the first argument (same pattern
 * as `source.repository.ts` and `story.repository.ts`). No class wrapper.
 *
 * All queries use parameterized SQL. Inserts are idempotent via ON CONFLICT.
 *
 * @see docs/specs/24_entity_alias_repositories.spec.md §4.2
 * @see docs/functional-spec.md §4.3
 */

import type pg from 'pg';
import { DATABASE_ERROR_CODES, DatabaseError } from '../../shared/errors.js';
import { createChildLogger, createLogger } from '../../shared/logger.js';
import type { CreateEntityInput, Entity, EntityFilter, TaxonomyStatus, UpdateEntityInput } from './entity.types.js';

const logger = createLogger();
const repoLogger = createChildLogger(logger, { module: 'entity-repository' });

// ────────────────────────────────────────────────────────────
// Row mapper (snake_case DB -> camelCase TS)
// ────────────────────────────────────────────────────────────

/** @internal Exported for use by related repositories (alias, story-entity). */
export interface EntityRow {
	id: string;
	canonical_id: string | null;
	name: string;
	type: string;
	attributes: Record<string, unknown>;
	corroboration_score: number | null;
	source_count: number;
	taxonomy_status: TaxonomyStatus;
	created_at: Date;
	updated_at: Date;
}

/** @internal Exported for use by entity-alias.repository.ts */
export function mapEntityRow(row: EntityRow): Entity {
	return {
		id: row.id,
		canonicalId: row.canonical_id,
		name: row.name,
		type: row.type,
		attributes: row.attributes ?? {},
		corroborationScore: row.corroboration_score,
		sourceCount: row.source_count,
		taxonomyStatus: row.taxonomy_status,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

// ────────────────────────────────────────────────────────────
// Entity CRUD
// ────────────────────────────────────────────────────────────

/**
 * Creates a new entity record. Idempotent via `ON CONFLICT (id) DO UPDATE`.
 *
 * When an explicit ID is provided, includes it in the INSERT.
 * On conflict (same ID), the existing record is returned with an
 * updated `updated_at` timestamp.
 */
export async function createEntity(pool: pg.Pool, input: CreateEntityInput): Promise<Entity> {
	const hasExplicitId = input.id !== undefined;
	const sql = hasExplicitId
		? `
    INSERT INTO entities (id, name, type, canonical_id, attributes, taxonomy_status)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (id) DO UPDATE SET updated_at = now()
    RETURNING *
  `
		: `
    INSERT INTO entities (name, type, canonical_id, attributes, taxonomy_status)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (id) DO UPDATE SET updated_at = now()
    RETURNING *
  `;
	const baseParams = [
		input.name,
		input.type,
		input.canonicalId ?? null,
		JSON.stringify(input.attributes ?? {}),
		input.taxonomyStatus ?? 'auto',
	];
	const params = hasExplicitId ? [input.id, ...baseParams] : baseParams;

	try {
		const result = await pool.query<EntityRow>(sql, params);
		const row = result.rows[0];
		repoLogger.debug({ entityId: row.id, name: input.name, type: input.type }, 'Entity created or found');
		return mapEntityRow(row);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to create entity', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { name: input.name, type: input.type },
		});
	}
}

/**
 * Upserts an entity by name+type for idempotent enrichment.
 *
 * Uses the partial unique index `idx_entities_name_type_canonical`
 * (WHERE canonical_id IS NULL) so only canonical entities conflict.
 * On conflict, updates attributes and taxonomy_status if provided,
 * and bumps `updated_at`.
 */
export async function upsertEntityByNameType(pool: pg.Pool, input: CreateEntityInput): Promise<Entity> {
	const sql = `
    INSERT INTO entities (name, type, canonical_id, attributes, taxonomy_status)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (name, type) WHERE canonical_id IS NULL DO UPDATE SET
      attributes = COALESCE(NULLIF($4::jsonb, '{}'::jsonb), entities.attributes),
      taxonomy_status = COALESCE($5, entities.taxonomy_status),
      updated_at = now()
    RETURNING *
  `;
	const params = [
		input.name,
		input.type,
		input.canonicalId ?? null,
		JSON.stringify(input.attributes ?? {}),
		input.taxonomyStatus ?? 'auto',
	];

	try {
		const result = await pool.query<EntityRow>(sql, params);
		const row = result.rows[0];
		repoLogger.debug({ entityId: row.id, name: input.name, type: input.type }, 'Entity upserted by name+type');
		return mapEntityRow(row);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to upsert entity by name+type', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { name: input.name, type: input.type },
		});
	}
}

/**
 * Finds an entity by its UUID.
 *
 * @returns The entity, or `null` if not found.
 */
export async function findEntityById(pool: pg.Pool, id: string): Promise<Entity | null> {
	const sql = 'SELECT * FROM entities WHERE id = $1';

	try {
		const result = await pool.query<EntityRow>(sql, [id]);
		if (result.rows.length === 0) {
			return null;
		}
		return mapEntityRow(result.rows[0]);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to find entity by ID', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { id },
		});
	}
}

/**
 * Finds all entities of a given type, ordered by name.
 */
export async function findEntitiesByType(pool: pg.Pool, type: string): Promise<Entity[]> {
	const sql = 'SELECT * FROM entities WHERE type = $1 ORDER BY name';

	try {
		const result = await pool.query<EntityRow>(sql, [type]);
		return result.rows.map(mapEntityRow);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to find entities by type', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { type },
		});
	}
}

/**
 * Finds all entities pointing to a canonical entity (merged entities).
 */
export async function findEntitiesByCanonicalId(pool: pg.Pool, canonicalId: string): Promise<Entity[]> {
	const sql = 'SELECT * FROM entities WHERE canonical_id = $1 ORDER BY name';

	try {
		const result = await pool.query<EntityRow>(sql, [canonicalId]);
		return result.rows.map(mapEntityRow);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to find entities by canonical ID', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { canonicalId },
		});
	}
}

/**
 * Finds all entities matching the given filter.
 *
 * Supports filtering by type, canonicalId, and taxonomyStatus,
 * with pagination via limit/offset. Results ordered by name ASC.
 */
export async function findAllEntities(pool: pg.Pool, filter?: EntityFilter): Promise<Entity[]> {
	const conditions: string[] = [];
	const params: unknown[] = [];
	let paramIndex = 1;

	if (filter?.type) {
		conditions.push(`type = $${paramIndex}`);
		params.push(filter.type);
		paramIndex++;
	}

	if (filter?.canonicalId) {
		conditions.push(`canonical_id = $${paramIndex}`);
		params.push(filter.canonicalId);
		paramIndex++;
	}

	if (filter?.taxonomyStatus) {
		conditions.push(`taxonomy_status = $${paramIndex}`);
		params.push(filter.taxonomyStatus);
		paramIndex++;
	}

	const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

	const limit = filter?.limit ?? 100;
	const offset = filter?.offset ?? 0;

	const sql = `SELECT * FROM entities ${whereClause} ORDER BY name ASC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
	params.push(limit, offset);

	try {
		const result = await pool.query<EntityRow>(sql, params);
		return result.rows.map(mapEntityRow);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to find entities', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { filter },
		});
	}
}

/**
 * Counts entities matching the given filter. For pagination and status overview.
 */
export async function countEntities(pool: pg.Pool, filter?: EntityFilter): Promise<number> {
	const conditions: string[] = [];
	const params: unknown[] = [];
	let paramIndex = 1;

	if (filter?.type) {
		conditions.push(`type = $${paramIndex}`);
		params.push(filter.type);
		paramIndex++;
	}

	if (filter?.canonicalId) {
		conditions.push(`canonical_id = $${paramIndex}`);
		params.push(filter.canonicalId);
		paramIndex++;
	}

	if (filter?.taxonomyStatus) {
		conditions.push(`taxonomy_status = $${paramIndex}`);
		params.push(filter.taxonomyStatus);
		paramIndex++;
	}

	const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
	const sql = `SELECT COUNT(*) FROM entities ${whereClause}`;

	try {
		const result = await pool.query<{ count: string }>(sql, params);
		return Number.parseInt(result.rows[0].count, 10);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to count entities', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { filter },
		});
	}
}

/**
 * Updates an entity record. Only provided fields are updated.
 * Sets `updated_at = now()` automatically.
 *
 * @throws {DatabaseError} with `DB_NOT_FOUND` if the entity does not exist.
 */
export async function updateEntity(pool: pg.Pool, id: string, input: UpdateEntityInput): Promise<Entity> {
	const setClauses: string[] = [];
	const params: unknown[] = [];
	let paramIndex = 1;

	const fieldMap: Array<[keyof UpdateEntityInput, string]> = [
		['name', 'name'],
		['type', 'type'],
		['corroborationScore', 'corroboration_score'],
		['sourceCount', 'source_count'],
		['taxonomyStatus', 'taxonomy_status'],
	];

	for (const [tsKey, dbKey] of fieldMap) {
		if (input[tsKey] !== undefined) {
			setClauses.push(`${dbKey} = $${paramIndex}`);
			params.push(input[tsKey]);
			paramIndex++;
		}
	}

	// canonicalId: explicit null clears the field, undefined skips it
	if (input.canonicalId !== undefined) {
		setClauses.push(`canonical_id = $${paramIndex}`);
		params.push(input.canonicalId);
		paramIndex++;
	}

	// attributes needs JSON.stringify
	if (input.attributes !== undefined) {
		setClauses.push(`attributes = $${paramIndex}`);
		params.push(JSON.stringify(input.attributes));
		paramIndex++;
	}

	// Always update the timestamp
	setClauses.push('updated_at = now()');

	params.push(id);
	const sql = `UPDATE entities SET ${setClauses.join(', ')} WHERE id = $${paramIndex} RETURNING *`;

	try {
		const result = await pool.query<EntityRow>(sql, params);
		if (result.rows.length === 0) {
			throw new DatabaseError(`Entity not found: ${id}`, DATABASE_ERROR_CODES.DB_NOT_FOUND, {
				context: { id },
			});
		}
		repoLogger.debug({ entityId: id }, 'Entity updated');
		return mapEntityRow(result.rows[0]);
	} catch (error: unknown) {
		if (error instanceof DatabaseError) {
			throw error;
		}
		throw new DatabaseError('Failed to update entity', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { id, fields: Object.keys(input) },
		});
	}
}

/**
 * Deletes an entity by ID. Cascades to `entity_aliases` via ON DELETE CASCADE.
 *
 * @returns `true` if the entity was deleted, `false` if it didn't exist.
 */
export async function deleteEntity(pool: pg.Pool, id: string): Promise<boolean> {
	const sql = 'DELETE FROM entities WHERE id = $1';

	try {
		const result = await pool.query(sql, [id]);
		const deleted = (result.rowCount ?? 0) > 0;
		if (deleted) {
			repoLogger.debug({ entityId: id }, 'Entity deleted');
		}
		return deleted;
	} catch (error: unknown) {
		throw new DatabaseError('Failed to delete entity', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { id },
		});
	}
}

/**
 * Deletes entities that are ONLY linked to stories of the given source.
 * Entities linked to other sources are preserved.
 *
 * Runs in a transaction:
 * 1. Capture entity IDs linked to this source's stories
 * 2. Delete story_entities junctions for stories of this source
 * 3. Delete orphaned entities (no remaining story_entities links)
 *
 * @returns The number of deleted entities.
 */
export async function deleteEntitiesBySourceId(pool: pg.Pool, sourceId: string): Promise<number> {
	const client = await pool.connect();

	try {
		await client.query('BEGIN');

		// Step 1: Capture entity IDs linked to this source's stories BEFORE deletion
		const entityIdsResult = await client.query<{ entity_id: string }>(
			`SELECT DISTINCT se.entity_id
       FROM story_entities se
       JOIN stories s ON s.id = se.story_id
       WHERE s.source_id = $1`,
			[sourceId],
		);
		const entityIds = entityIdsResult.rows.map((r) => r.entity_id);

		if (entityIds.length === 0) {
			await client.query('COMMIT');
			return 0;
		}

		// Step 2: Delete story_entities junctions for stories belonging to this source
		await client.query(
			`DELETE FROM story_entities
       WHERE story_id IN (SELECT id FROM stories WHERE source_id = $1)`,
			[sourceId],
		);

		// Step 3: Delete entities that are now orphaned (no remaining story_entities links)
		const deleteResult = await client.query(
			`DELETE FROM entities
       WHERE id = ANY($1)
         AND id NOT IN (SELECT DISTINCT entity_id FROM story_entities)`,
			[entityIds],
		);

		await client.query('COMMIT');

		const count = deleteResult.rowCount ?? 0;
		if (count > 0) {
			repoLogger.debug({ sourceId, count }, 'Orphaned entities deleted for source');
		}
		return count;
	} catch (error: unknown) {
		await client.query('ROLLBACK').catch(() => {});
		throw new DatabaseError('Failed to delete entities by source ID', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { sourceId },
		});
	} finally {
		client.release();
	}
}

// ────────────────────────────────────────────────────────────
// Candidate search (cross-lingual entity resolution)
// ────────────────────────────────────────────────────────────

/** Row shape for attribute candidate queries, extends EntityRow with match_detail. */
interface AttributeCandidateRow extends EntityRow {
	match_detail: string;
}

/** Row shape for embedding candidate queries, extends EntityRow with similarity. */
interface EmbeddingCandidateRow extends EntityRow {
	similarity: number;
}

/** Result from attribute-based candidate search. */
export interface AttributeCandidate {
	entity: Entity;
	matchDetail: string;
}

/** Result from embedding-based candidate search. */
export interface EmbeddingCandidate {
	entity: Entity;
	similarity: number;
}

/**
 * Finds candidate entities by matching structured attributes (Tier 1).
 *
 * Searches same-type entities for overlapping identifier attributes:
 * - `wikidata_id`: exact JSONB containment
 * - `geo_point`: PostGIS proximity within 100m
 * - `iso_date`: exact JSONB containment
 *
 * Only searches for attribute keys that the incoming entity actually has.
 *
 * @param pool - PostgreSQL connection pool
 * @param entityType - Entity type to search within
 * @param attributes - The incoming entity's attributes
 * @param excludeId - Entity ID to exclude from results (the entity itself)
 * @param limit - Maximum candidates to return (default 10)
 */
export async function findCandidatesByAttributes(
	pool: pg.Pool,
	entityType: string,
	attributes: Record<string, unknown>,
	excludeId: string,
	limit = 10,
): Promise<AttributeCandidate[]> {
	const conditions: string[] = [];
	const params: unknown[] = [entityType, excludeId];
	let paramIndex = 3;

	// Wikidata ID exact match
	if (typeof attributes.wikidata_id === 'string') {
		conditions.push(`attributes @> $${paramIndex}::jsonb`);
		params.push(JSON.stringify({ wikidata_id: attributes.wikidata_id }));
		paramIndex++;
	}

	// ISO date exact match
	if (typeof attributes.iso_date === 'string') {
		conditions.push(`attributes @> $${paramIndex}::jsonb`);
		params.push(JSON.stringify({ iso_date: attributes.iso_date }));
		paramIndex++;
	}

	// Geo point proximity (100m radius via PostGIS)
	const geoPoint = attributes.geo_point;
	if (geoPoint !== null && typeof geoPoint === 'object' && !Array.isArray(geoPoint)) {
		const geo = geoPoint as Record<string, unknown>;
		if (typeof geo.lat === 'number' && typeof geo.lng === 'number') {
			conditions.push(
				`ST_DWithin(
					ST_MakePoint((attributes->>'lng')::float, (attributes->>'lat')::float)::geography,
					ST_MakePoint($${paramIndex}, $${paramIndex + 1})::geography,
					100
				)`,
			);
			params.push(geo.lng, geo.lat);
			paramIndex += 2;
		}
	}

	// No matchable attributes — return empty
	if (conditions.length === 0) {
		return [];
	}

	const whereClause = conditions.map((c) => `(${c})`).join(' OR ');
	const sql = `
		SELECT *, 'attribute_match' AS match_detail
		FROM entities
		WHERE type = $1 AND id != $2 AND canonical_id IS NULL AND (${whereClause})
		LIMIT $${paramIndex}
	`;
	params.push(limit);

	try {
		const result = await pool.query<AttributeCandidateRow>(sql, params);
		return result.rows.map((row) => ({
			entity: mapEntityRow(row),
			matchDetail: row.match_detail,
		}));
	} catch (error: unknown) {
		throw new DatabaseError('Failed to find candidates by attributes', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { entityType, attributeKeys: Object.keys(attributes) },
		});
	}
}

/**
 * Finds candidate entities by embedding cosine similarity (Tier 2).
 *
 * Queries pgvector HNSW index on `name_embedding` column.
 * Uses `1 - (name_embedding <=> $embedding)` for cosine similarity.
 *
 * @param pool - PostgreSQL connection pool
 * @param entityType - Entity type to search within
 * @param embedding - The query embedding vector (768-dim)
 * @param threshold - Minimum cosine similarity threshold (0-1)
 * @param excludeId - Entity ID to exclude from results
 * @param limit - Maximum candidates to return (default 10)
 */
export async function findCandidatesByEmbedding(
	pool: pg.Pool,
	entityType: string,
	embedding: number[],
	threshold: number,
	excludeId: string,
	limit = 10,
): Promise<EmbeddingCandidate[]> {
	const embeddingStr = `[${embedding.join(',')}]`;
	const sql = `
		SELECT *, 1 - (name_embedding <=> $1::vector) AS similarity
		FROM entities
		WHERE type = $2
		  AND id != $3
		  AND canonical_id IS NULL
		  AND name_embedding IS NOT NULL
		  AND 1 - (name_embedding <=> $1::vector) > $4
		ORDER BY name_embedding <=> $1::vector ASC
		LIMIT $5
	`;
	const params = [embeddingStr, entityType, excludeId, threshold, limit];

	try {
		const result = await pool.query<EmbeddingCandidateRow>(sql, params);
		return result.rows.map((row) => ({
			entity: mapEntityRow(row),
			similarity: Number(row.similarity),
		}));
	} catch (error: unknown) {
		throw new DatabaseError('Failed to find candidates by embedding', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { entityType, threshold },
		});
	}
}

/**
 * Updates the name embedding vector for an entity (Tier 2 storage).
 *
 * @param pool - PostgreSQL connection pool
 * @param entityId - The entity UUID
 * @param embedding - The embedding vector (768-dim)
 */
export async function updateEntityEmbedding(pool: pg.Pool, entityId: string, embedding: number[]): Promise<void> {
	const embeddingStr = `[${embedding.join(',')}]`;
	const sql = 'UPDATE entities SET name_embedding = $1::vector, updated_at = now() WHERE id = $2';

	try {
		const result = await pool.query(sql, [embeddingStr, entityId]);
		if ((result.rowCount ?? 0) === 0) {
			throw new DatabaseError(`Entity not found: ${entityId}`, DATABASE_ERROR_CODES.DB_NOT_FOUND, {
				context: { entityId },
			});
		}
		repoLogger.debug({ entityId }, 'Entity name embedding updated');
	} catch (error: unknown) {
		if (error instanceof DatabaseError) {
			throw error;
		}
		throw new DatabaseError('Failed to update entity embedding', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { entityId },
		});
	}
}
