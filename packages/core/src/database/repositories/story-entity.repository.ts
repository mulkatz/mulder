/**
 * Story-entity junction repository -- CRUD operations for the `story_entities` table.
 *
 * Plain functions that accept a `pg.Pool` as the first argument (same pattern
 * as `source.repository.ts` and `story.repository.ts`). No class wrapper.
 *
 * All queries use parameterized SQL. Inserts are idempotent via ON CONFLICT.
 *
 * @see docs/specs/24_entity_alias_repositories.spec.md §4.4
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
import { type EntityRow, entityActiveSourceClause, mapEntityRow } from './entity.repository.js';
import type { LinkStoryEntityInput, StoryEntityWithEntity, StoryEntityWithStory } from './entity.types.js';
import { queryWithSensitivityColumnFallback } from './schema-compat.js';
import { mapStoryRow, type StoryRow } from './story.repository.js';

const logger = createLogger();
const repoLogger = createChildLogger(logger, { module: 'story-entity-repository' });

function activeSourceClause(sourceAlias: string): string {
	return `${sourceAlias}.deletion_status NOT IN ('soft_deleted', 'purging', 'purged')`;
}

function storyEntityActiveSourceClause(storyEntityAlias: string): string {
	return `
    (
      NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements_text(COALESCE(${storyEntityAlias}.provenance->'source_document_ids', '[]'::jsonb)) AS link_sources(source_id)
      )
      OR EXISTS (
        SELECT 1
        FROM jsonb_array_elements_text(COALESCE(${storyEntityAlias}.provenance->'source_document_ids', '[]'::jsonb)) AS link_sources(source_id)
        JOIN sources link_src ON link_src.id::text = link_sources.source_id
        WHERE link_src.deletion_status NOT IN ('soft_deleted', 'purging', 'purged')
      )
    )
  `;
}

// ────────────────────────────────────────────────────────────
// Extended row types (entity/story + junction fields)
// ────────────────────────────────────────────────────────────

type EntityWithJunctionRow = EntityRow & {
	confidence: number | null;
	mention_count: number;
	junction_provenance: unknown;
	junction_sensitivity_level: StoryEntityWithEntity['sensitivityLevel'];
	junction_sensitivity_metadata: unknown;
};

type StoryWithJunctionRow = StoryRow & {
	confidence: number | null;
	mention_count: number;
	junction_provenance: unknown;
	junction_sensitivity_level: StoryEntityWithStory['sensitivityLevel'];
	junction_sensitivity_metadata: unknown;
};

function mapEntityWithJunctionRow(row: EntityWithJunctionRow): StoryEntityWithEntity {
	return {
		...mapEntityRow({ ...row, provenance: row.junction_provenance }),
		confidence: row.confidence,
		mentionCount: row.mention_count,
		sensitivityLevel: row.junction_sensitivity_level ?? 'internal',
		sensitivityMetadata: normalizeSensitivityMetadata(
			row.junction_sensitivity_metadata,
			row.junction_sensitivity_level ?? 'internal',
		),
	};
}

function mapStoryWithJunctionRow(row: StoryWithJunctionRow): StoryEntityWithStory {
	return {
		...mapStoryRow(row),
		confidence: row.confidence,
		mentionCount: row.mention_count,
		provenance: mapArtifactProvenanceFromDb(row.junction_provenance),
		sensitivityLevel: row.junction_sensitivity_level ?? 'internal',
		sensitivityMetadata: normalizeSensitivityMetadata(
			row.junction_sensitivity_metadata,
			row.junction_sensitivity_level ?? 'internal',
		),
	};
}

// ────────────────────────────────────────────────────────────
// Story-Entity Junction CRUD
// ────────────────────────────────────────────────────────────

/**
 * Links a story to an entity. Idempotent via ON CONFLICT on the composite PK.
 *
 * On conflict, updates confidence and mention_count to the new values.
 */
export async function linkStoryEntity(pool: pg.Pool, input: LinkStoryEntityInput): Promise<StoryEntityWithEntity> {
	const sensitivityLevel = input.sensitivityLevel ?? 'internal';
	const sql = `
    WITH upserted AS (
      INSERT INTO story_entities (story_id, entity_id, confidence, mention_count, provenance, sensitivity_level, sensitivity_metadata)
      VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb)
      ON CONFLICT (story_id, entity_id) DO UPDATE SET
        confidence = EXCLUDED.confidence,
        mention_count = EXCLUDED.mention_count,
        provenance = ${mergeArtifactProvenanceSql('story_entities.provenance', 'EXCLUDED.provenance')},
        sensitivity_level = EXCLUDED.sensitivity_level,
        sensitivity_metadata = EXCLUDED.sensitivity_metadata
      RETURNING *
    )
    SELECT
      e.*,
      u.confidence,
      u.mention_count,
      u.provenance AS junction_provenance,
      u.sensitivity_level AS junction_sensitivity_level,
      u.sensitivity_metadata AS junction_sensitivity_metadata
    FROM upserted u
    JOIN entities e ON e.id = u.entity_id
  `;
	const legacySql = `
    WITH upserted AS (
      INSERT INTO story_entities (story_id, entity_id, confidence, mention_count, provenance)
      VALUES ($1, $2, $3, $4, $5::jsonb)
      ON CONFLICT (story_id, entity_id) DO UPDATE SET
        confidence = EXCLUDED.confidence,
        mention_count = EXCLUDED.mention_count,
        provenance = ${mergeArtifactProvenanceSql('story_entities.provenance', 'EXCLUDED.provenance')}
      RETURNING *
    )
    SELECT
      e.*,
      u.confidence,
      u.mention_count,
      u.provenance AS junction_provenance,
      NULL::text AS junction_sensitivity_level,
      NULL::jsonb AS junction_sensitivity_metadata
    FROM upserted u
    JOIN entities e ON e.id = u.entity_id
  `;
	const params = [
		input.storyId,
		input.entityId,
		input.confidence ?? null,
		input.mentionCount ?? 1,
		stringifyArtifactProvenance(input.provenance),
		sensitivityLevel,
		stringifySensitivityMetadata(input.sensitivityMetadata, sensitivityLevel),
	];
	const legacyParams = params.slice(0, -2);

	try {
		const result = await queryWithSensitivityColumnFallback<EntityWithJunctionRow>(
			pool,
			sql,
			params,
			legacySql,
			legacyParams,
		);
		const row = result.rows[0];
		repoLogger.debug({ storyId: input.storyId, entityId: input.entityId }, 'Story-entity link created or updated');
		return mapEntityWithJunctionRow(row);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to link story to entity', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { storyId: input.storyId, entityId: input.entityId },
		});
	}
}

/**
 * Finds all entities linked to a story, with junction metadata.
 *
 * Returns entities with their confidence and mention_count from the junction.
 */
export async function findEntitiesByStoryId(
	pool: pg.Pool,
	storyId: string,
	options?: { includeDeleted?: boolean },
): Promise<StoryEntityWithEntity[]> {
	const sql = `
    SELECT
      e.*,
      se.confidence,
      se.mention_count,
      se.provenance AS junction_provenance,
      se.sensitivity_level AS junction_sensitivity_level,
      se.sensitivity_metadata AS junction_sensitivity_metadata
    FROM entities e
    JOIN story_entities se ON se.entity_id = e.id
    JOIN stories s ON s.id = se.story_id
    JOIN sources src ON src.id = s.source_id
    WHERE se.story_id = $1
      ${options?.includeDeleted ? '' : `AND ${activeSourceClause('src')} AND ${storyEntityActiveSourceClause('se')} AND ${entityActiveSourceClause('e')}`}
    ORDER BY e.name
  `;
	const legacySql = `
    SELECT
      e.*,
      se.confidence,
      se.mention_count,
      se.provenance AS junction_provenance,
      NULL::text AS junction_sensitivity_level,
      NULL::jsonb AS junction_sensitivity_metadata
    FROM entities e
    JOIN story_entities se ON se.entity_id = e.id
    JOIN stories s ON s.id = se.story_id
    JOIN sources src ON src.id = s.source_id
    WHERE se.story_id = $1
      ${options?.includeDeleted ? '' : `AND ${activeSourceClause('src')} AND ${storyEntityActiveSourceClause('se')} AND ${entityActiveSourceClause('e')}`}
    ORDER BY e.name
  `;
	const params = [storyId];

	try {
		const result = await queryWithSensitivityColumnFallback<EntityWithJunctionRow>(
			pool,
			sql,
			params,
			legacySql,
			params,
		);
		return result.rows.map(mapEntityWithJunctionRow);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to find entities by story ID', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { storyId },
		});
	}
}

/**
 * Finds all stories linked to an entity, with junction metadata.
 *
 * Returns stories with their confidence and mention_count from the junction.
 */
export async function findStoriesByEntityId(
	pool: pg.Pool,
	entityId: string,
	options?: { includeDeleted?: boolean },
): Promise<StoryEntityWithStory[]> {
	const sql = `
    SELECT
      s.*,
      se.confidence,
      se.mention_count,
      se.provenance AS junction_provenance,
      se.sensitivity_level AS junction_sensitivity_level,
      se.sensitivity_metadata AS junction_sensitivity_metadata
    FROM stories s
    JOIN story_entities se ON se.story_id = s.id
    JOIN sources src ON src.id = s.source_id
    WHERE se.entity_id = $1
      ${options?.includeDeleted ? '' : `AND ${activeSourceClause('src')} AND ${storyEntityActiveSourceClause('se')}`}
    ORDER BY s.created_at DESC
  `;
	const legacySql = `
    SELECT
      s.*,
      se.confidence,
      se.mention_count,
      se.provenance AS junction_provenance,
      NULL::text AS junction_sensitivity_level,
      NULL::jsonb AS junction_sensitivity_metadata
    FROM stories s
    JOIN story_entities se ON se.story_id = s.id
    JOIN sources src ON src.id = s.source_id
    WHERE se.entity_id = $1
      ${options?.includeDeleted ? '' : `AND ${activeSourceClause('src')} AND ${storyEntityActiveSourceClause('se')}`}
    ORDER BY s.created_at DESC
  `;
	const params = [entityId];

	try {
		const result = await queryWithSensitivityColumnFallback<StoryWithJunctionRow>(pool, sql, params, legacySql, params);
		return result.rows.map(mapStoryWithJunctionRow);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to find stories by entity ID', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { entityId },
		});
	}
}

/**
 * Unlinks a story from an entity.
 *
 * @returns `true` if the link was removed, `false` if it didn't exist.
 */
export async function unlinkStoryEntity(pool: pg.Pool, storyId: string, entityId: string): Promise<boolean> {
	const sql = 'DELETE FROM story_entities WHERE story_id = $1 AND entity_id = $2';

	try {
		const result = await pool.query(sql, [storyId, entityId]);
		const deleted = (result.rowCount ?? 0) > 0;
		if (deleted) {
			repoLogger.debug({ storyId, entityId }, 'Story-entity link removed');
		}
		return deleted;
	} catch (error: unknown) {
		throw new DatabaseError('Failed to unlink story from entity', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { storyId, entityId },
		});
	}
}

/**
 * Deletes all story-entity links for a story. Used for re-enrichment cleanup.
 *
 * @returns The number of deleted links.
 */
export async function deleteStoryEntitiesByStoryId(pool: pg.Pool, storyId: string): Promise<number> {
	const sql = 'DELETE FROM story_entities WHERE story_id = $1';

	try {
		const result = await pool.query(sql, [storyId]);
		const count = result.rowCount ?? 0;
		if (count > 0) {
			repoLogger.debug({ storyId, count }, 'Story-entity links deleted for story');
		}
		return count;
	} catch (error: unknown) {
		throw new DatabaseError('Failed to delete story entities by story ID', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { storyId },
		});
	}
}

/**
 * Deletes all story-entity links for all stories belonging to a source.
 * Used for `--force` cleanup at source level.
 *
 * @returns The number of deleted links.
 */
export async function deleteStoryEntitiesBySourceId(pool: pg.Pool, sourceId: string): Promise<number> {
	const sql = `
    DELETE FROM story_entities
    WHERE story_id IN (SELECT id FROM stories WHERE source_id = $1)
  `;

	try {
		const result = await pool.query(sql, [sourceId]);
		const count = result.rowCount ?? 0;
		if (count > 0) {
			repoLogger.debug({ sourceId, count }, 'Story-entity links deleted for source');
		}
		return count;
	} catch (error: unknown) {
		throw new DatabaseError('Failed to delete story entities by source ID', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { sourceId },
		});
	}
}
