/**
 * Repository for the `entity_grounding` cache table plus grounded entity
 * attribute updates.
 *
 * @see docs/specs/60_ground_step.spec.md §4.1
 * @see docs/functional-spec.md §2.5, §4.3
 */

import type pg from 'pg';
import { DATABASE_ERROR_CODES, DatabaseError } from '../../shared/errors.js';
import { createChildLogger, createLogger } from '../../shared/logger.js';
import { type EntityRow, mapEntityRow } from './entity.repository.js';
import type { Entity, EntityGrounding, GroundingCoordinates, UpsertEntityGroundingInput } from './entity.types.js';

const logger = createLogger();
const repoLogger = createChildLogger(logger, { module: 'entity-grounding-repository' });

interface EntityGroundingRow {
	id: string;
	entity_id: string;
	grounding_data: Record<string, unknown>;
	source_urls: string[] | null;
	grounded_at: Date;
	expires_at: Date;
}

export interface PersistEntityGroundingInput extends UpsertEntityGroundingInput {
	mergedAttributes: Record<string, unknown>;
	coordinates?: GroundingCoordinates;
}

function mapGroundingRow(row: EntityGroundingRow): EntityGrounding {
	return {
		id: row.id,
		entityId: row.entity_id,
		groundingData: row.grounding_data ?? {},
		sourceUrls: row.source_urls ?? [],
		groundedAt: row.grounded_at,
		expiresAt: row.expires_at,
	};
}

async function upsertEntityGroundingWithClient(
	client: pg.PoolClient,
	input: UpsertEntityGroundingInput,
): Promise<EntityGrounding> {
	const groundedAt = input.groundedAt ?? new Date();
	const updateSql = `
    UPDATE entity_grounding
    SET grounding_data = $2,
        source_urls = $3,
        grounded_at = $4,
        expires_at = $5
    WHERE entity_id = $1
    RETURNING *
  `;

	try {
		const updateResult = await client.query<EntityGroundingRow>(updateSql, [
			input.entityId,
			JSON.stringify(input.groundingData),
			input.sourceUrls,
			groundedAt,
			input.expiresAt,
		]);
		if (updateResult.rows.length > 0) {
			return mapGroundingRow(updateResult.rows[0]);
		}

		const insertSql = `
      INSERT INTO entity_grounding (entity_id, grounding_data, source_urls, grounded_at, expires_at)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `;
		const insertResult = await client.query<EntityGroundingRow>(insertSql, [
			input.entityId,
			JSON.stringify(input.groundingData),
			input.sourceUrls,
			groundedAt,
			input.expiresAt,
		]);

		return mapGroundingRow(insertResult.rows[0]);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to upsert entity grounding', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { entityId: input.entityId },
		});
	}
}

async function applyGroundingToEntityWithClient(
	client: pg.PoolClient,
	entityId: string,
	attributes: Record<string, unknown>,
	coordinates?: GroundingCoordinates,
): Promise<Entity> {
	const lat = coordinates?.lat ?? null;
	const lng = coordinates?.lng ?? null;
	const sql = `
    UPDATE entities
    SET attributes = $2::jsonb,
        geom = CASE
          WHEN $3::double precision IS NOT NULL AND $4::double precision IS NOT NULL
            THEN ST_SetSRID(ST_MakePoint($4::double precision, $3::double precision), 4326)
          ELSE geom
        END,
        updated_at = now()
    WHERE id = $1
    RETURNING *
  `;

	try {
		const result = await client.query<EntityRow>(sql, [entityId, JSON.stringify(attributes), lat, lng]);
		if (result.rows.length === 0) {
			throw new DatabaseError(`Entity not found: ${entityId}`, DATABASE_ERROR_CODES.DB_NOT_FOUND, {
				context: { entityId },
			});
		}
		return mapEntityRow(result.rows[0]);
	} catch (error: unknown) {
		if (error instanceof DatabaseError) {
			throw error;
		}
		throw new DatabaseError('Failed to apply grounding attributes to entity', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { entityId },
		});
	}
}

export async function findEntityGroundingByEntityId(pool: pg.Pool, entityId: string): Promise<EntityGrounding | null> {
	const sql = 'SELECT * FROM entity_grounding WHERE entity_id = $1 ORDER BY grounded_at DESC LIMIT 1';

	try {
		const result = await pool.query<EntityGroundingRow>(sql, [entityId]);
		if (result.rows.length === 0) {
			return null;
		}
		return mapGroundingRow(result.rows[0]);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to find entity grounding by entity ID', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { entityId },
		});
	}
}

export async function upsertEntityGrounding(
	pool: pg.Pool,
	input: UpsertEntityGroundingInput,
): Promise<EntityGrounding> {
	const client = await pool.connect();
	try {
		return await upsertEntityGroundingWithClient(client, input);
	} finally {
		client.release();
	}
}

export async function applyGroundingToEntity(
	pool: pg.Pool,
	entityId: string,
	attributes: Record<string, unknown>,
	coordinates?: GroundingCoordinates,
): Promise<Entity> {
	const client = await pool.connect();
	try {
		return await applyGroundingToEntityWithClient(client, entityId, attributes, coordinates);
	} finally {
		client.release();
	}
}

export async function persistEntityGroundingResult(
	pool: pg.Pool,
	input: PersistEntityGroundingInput,
): Promise<{ grounding: EntityGrounding; entity: Entity }> {
	const client = await pool.connect();

	try {
		await client.query('BEGIN');
		const grounding = await upsertEntityGroundingWithClient(client, input);
		const entity = await applyGroundingToEntityWithClient(
			client,
			input.entityId,
			input.mergedAttributes,
			input.coordinates,
		);
		await client.query('COMMIT');

		repoLogger.debug(
			{
				entityId: input.entityId,
				sourceUrlCount: input.sourceUrls.length,
				hasCoordinates: input.coordinates !== undefined,
			},
			'Persisted entity grounding result',
		);

		return { grounding, entity };
	} catch (error: unknown) {
		await client.query('ROLLBACK').catch(() => {});
		if (error instanceof DatabaseError) {
			throw error;
		}
		throw new DatabaseError('Failed to persist entity grounding result', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { entityId: input.entityId },
		});
	} finally {
		client.release();
	}
}
