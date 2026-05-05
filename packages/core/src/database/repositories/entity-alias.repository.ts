/**
 * Entity alias repository -- CRUD operations for the `entity_aliases` table.
 *
 * Plain functions that accept a `pg.Pool` as the first argument (same pattern
 * as `source.repository.ts` and `story.repository.ts`). No class wrapper.
 *
 * All queries use parameterized SQL. Inserts are idempotent via ON CONFLICT.
 *
 * @see docs/specs/24_entity_alias_repositories.spec.md §4.3
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
import { type EntityRow, mapEntityRow } from './entity.repository.js';
import type { CreateEntityAliasInput, Entity, EntityAlias } from './entity.types.js';

const logger = createLogger();
const repoLogger = createChildLogger(logger, { module: 'entity-alias-repository' });

// ────────────────────────────────────────────────────────────
// Row mapper (snake_case DB -> camelCase TS)
// ────────────────────────────────────────────────────────────

interface EntityAliasRow {
	id: string;
	entity_id: string;
	alias: string;
	source: string | null;
	provenance: unknown;
	sensitivity_level: EntityAlias['sensitivityLevel'];
	sensitivity_metadata: unknown;
}

function mapEntityAliasRow(row: EntityAliasRow): EntityAlias {
	return {
		id: row.id,
		entityId: row.entity_id,
		alias: row.alias,
		source: row.source,
		provenance: mapArtifactProvenanceFromDb(row.provenance),
		sensitivityLevel: row.sensitivity_level ?? 'internal',
		sensitivityMetadata: normalizeSensitivityMetadata(row.sensitivity_metadata, row.sensitivity_level ?? 'internal'),
	};
}

// ────────────────────────────────────────────────────────────
// Entity Alias CRUD
// ────────────────────────────────────────────────────────────

/**
 * Creates a new entity alias. Idempotent via UNIQUE(entity_id, alias).
 *
 * On conflict (same entity_id + alias), returns the existing row.
 * Uses a CTE to handle the DO NOTHING case by selecting back.
 */
export async function createEntityAlias(pool: pg.Pool, input: CreateEntityAliasInput): Promise<EntityAlias> {
	const sensitivityLevel = input.sensitivityLevel ?? 'internal';
	const sql = `
    INSERT INTO entity_aliases (entity_id, alias, source, provenance, sensitivity_level, sensitivity_metadata)
    VALUES ($1, $2, $3, $4::jsonb, $5, $6::jsonb)
    ON CONFLICT (entity_id, alias) DO UPDATE SET
      source = COALESCE(entity_aliases.source, EXCLUDED.source),
      provenance = ${mergeArtifactProvenanceSql('entity_aliases.provenance', 'EXCLUDED.provenance')},
      sensitivity_level = EXCLUDED.sensitivity_level,
      sensitivity_metadata = EXCLUDED.sensitivity_metadata
    RETURNING *
  `;
	const params = [
		input.entityId,
		input.alias,
		input.source ?? null,
		stringifyArtifactProvenance(input.provenance),
		sensitivityLevel,
		stringifySensitivityMetadata(input.sensitivityMetadata, sensitivityLevel),
	];

	try {
		const result = await pool.query<EntityAliasRow>(sql, params);
		const row = result.rows[0];
		repoLogger.debug(
			{ aliasId: row.id, entityId: input.entityId, alias: input.alias },
			'Entity alias created or found',
		);
		return mapEntityAliasRow(row);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to create entity alias', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { entityId: input.entityId, alias: input.alias },
		});
	}
}

/**
 * Finds all aliases for an entity, ordered alphabetically.
 */
export async function findAliasesByEntityId(pool: pg.Pool, entityId: string): Promise<EntityAlias[]> {
	const sql = 'SELECT * FROM entity_aliases WHERE entity_id = $1 ORDER BY alias';

	try {
		const result = await pool.query<EntityAliasRow>(sql, [entityId]);
		return result.rows.map(mapEntityAliasRow);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to find aliases by entity ID', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { entityId },
		});
	}
}

/**
 * Finds an entity by one of its aliases.
 *
 * Joins entity_aliases with entities to return the full entity record.
 *
 * @returns The entity, or `null` if no alias matches.
 */
export async function findEntityByAlias(pool: pg.Pool, alias: string): Promise<Entity | null> {
	const sql = `
    SELECT e.*
    FROM entities e
    JOIN entity_aliases ea ON ea.entity_id = e.id
    WHERE ea.alias = $1
    LIMIT 1
  `;

	try {
		const result = await pool.query<EntityRow>(sql, [alias]);
		if (result.rows.length === 0) {
			return null;
		}
		return mapEntityRow(result.rows[0]);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to find entity by alias', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { alias },
		});
	}
}

/**
 * Deletes an entity alias by ID.
 *
 * @returns `true` if the alias was deleted, `false` if it didn't exist.
 */
export async function deleteEntityAlias(pool: pg.Pool, id: string): Promise<boolean> {
	const sql = 'DELETE FROM entity_aliases WHERE id = $1';

	try {
		const result = await pool.query(sql, [id]);
		const deleted = (result.rowCount ?? 0) > 0;
		if (deleted) {
			repoLogger.debug({ aliasId: id }, 'Entity alias deleted');
		}
		return deleted;
	} catch (error: unknown) {
		throw new DatabaseError('Failed to delete entity alias', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { id },
		});
	}
}

/**
 * Deletes all aliases for an entity. Used for entity cleanup.
 *
 * @returns The number of deleted aliases.
 */
export async function deleteAliasesByEntityId(pool: pg.Pool, entityId: string): Promise<number> {
	const sql = 'DELETE FROM entity_aliases WHERE entity_id = $1';

	try {
		const result = await pool.query(sql, [entityId]);
		const count = result.rowCount ?? 0;
		if (count > 0) {
			repoLogger.debug({ entityId, count }, 'Entity aliases deleted');
		}
		return count;
	} catch (error: unknown) {
		throw new DatabaseError('Failed to delete aliases by entity ID', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { entityId },
		});
	}
}
