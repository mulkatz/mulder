/**
 * Spatio-temporal cluster repository -- event loading and snapshot persistence
 * for the `spatio_temporal_clusters` table.
 *
 * Used by the Analyze step to read clusterable entity events from `entities`
 * and replace the persisted cluster snapshot idempotently.
 *
 * @see docs/specs/64_spatio_temporal_clustering.spec.md §4.1
 * @see docs/functional-spec.md §4.3
 */

import type pg from 'pg';
import { DATABASE_ERROR_CODES, DatabaseError } from '../../shared/errors.js';
import { createChildLogger, createLogger } from '../../shared/logger.js';

const logger = createLogger();
const repoLogger = createChildLogger(logger, { module: 'spatio-temporal-cluster-repository' });

type Queryable = Pick<pg.Pool, 'query'>;

export type SpatioTemporalClusterType = 'temporal' | 'spatial' | 'spatio-temporal';

export interface ClusterableEntityEvent {
	eventId: string;
	isoDate: string | null;
	latitude: number | null;
	longitude: number | null;
}

export interface SpatialEntityEventPair {
	eventIdA: string;
	eventIdB: string;
	distanceMeters: number;
}

export interface SpatioTemporalCluster {
	id: string;
	centerLat: number | null;
	centerLng: number | null;
	timeStart: Date | null;
	timeEnd: Date | null;
	eventCount: number;
	eventIds: string[];
	clusterType: SpatioTemporalClusterType | null;
	computedAt: Date;
}

export interface CreateSpatioTemporalClusterInput {
	centerLat?: number | null;
	centerLng?: number | null;
	timeStart?: Date | null;
	timeEnd?: Date | null;
	eventCount: number;
	eventIds: string[];
	clusterType: SpatioTemporalClusterType;
	computedAt?: Date;
}

export interface SpatioTemporalClusterFilter {
	clusterType?: SpatioTemporalClusterType;
}

interface ClusterableEntityEventRow {
	event_id: string;
	iso_date: string | null;
	latitude: number | null;
	longitude: number | null;
}

interface SpatialEntityEventPairRow {
	event_id_a: string;
	event_id_b: string;
	distance_meters: number;
}

interface SpatioTemporalClusterRow {
	id: string;
	center_lat: number | null;
	center_lng: number | null;
	time_start: Date | null;
	time_end: Date | null;
	event_count: number;
	event_ids: string[];
	cluster_type: SpatioTemporalClusterType | null;
	computed_at: Date;
}

function mapClusterableEntityEvent(row: ClusterableEntityEventRow): ClusterableEntityEvent {
	return {
		eventId: row.event_id,
		isoDate: row.iso_date,
		latitude: row.latitude === null ? null : Number(row.latitude),
		longitude: row.longitude === null ? null : Number(row.longitude),
	};
}

function mapSpatialEntityEventPair(row: SpatialEntityEventPairRow): SpatialEntityEventPair {
	return {
		eventIdA: row.event_id_a,
		eventIdB: row.event_id_b,
		distanceMeters: Number(row.distance_meters),
	};
}

function mapSpatioTemporalCluster(row: SpatioTemporalClusterRow): SpatioTemporalCluster {
	return {
		id: row.id,
		centerLat: row.center_lat === null ? null : Number(row.center_lat),
		centerLng: row.center_lng === null ? null : Number(row.center_lng),
		timeStart: row.time_start,
		timeEnd: row.time_end,
		eventCount: Number(row.event_count),
		eventIds: row.event_ids ?? [],
		clusterType: row.cluster_type,
		computedAt: row.computed_at,
	};
}

function createClusterValueSql(rowCount: number): string {
	const values: string[] = [];
	for (let index = 0; index < rowCount; index++) {
		const base = index * 8;
		values.push(
			`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8})`,
		);
	}
	return values.join(', ');
}

export async function loadClusterableEntityEvents(pool: Queryable): Promise<ClusterableEntityEvent[]> {
	const sql = `
		SELECT
			id AS event_id,
			NULLIF(BTRIM(attributes->>'iso_date'), '') AS iso_date,
			CASE WHEN geom IS NOT NULL THEN ST_Y(geom)::double precision ELSE NULL END AS latitude,
			CASE WHEN geom IS NOT NULL THEN ST_X(geom)::double precision ELSE NULL END AS longitude
		FROM entities
		WHERE geom IS NOT NULL
		   OR NULLIF(BTRIM(attributes->>'iso_date'), '') IS NOT NULL
		ORDER BY id ASC
	`;

	try {
		const result = await pool.query<ClusterableEntityEventRow>(sql);
		return result.rows.map(mapClusterableEntityEvent);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to load clusterable entity events', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
		});
	}
}

export async function findSpatialEntityEventPairs(
	pool: Queryable,
	eventIds: string[],
	distanceMeters: number,
): Promise<SpatialEntityEventPair[]> {
	if (eventIds.length < 2) {
		return [];
	}

	const sql = `
		WITH candidate_events AS (
			SELECT id, geom
			FROM entities
			WHERE id = ANY($1::uuid[])
			  AND geom IS NOT NULL
		)
		SELECT
			left_event.id AS event_id_a,
			right_event.id AS event_id_b,
			ST_Distance(left_event.geom::geography, right_event.geom::geography) AS distance_meters
		FROM candidate_events left_event
		JOIN candidate_events right_event ON left_event.id < right_event.id
		WHERE ST_DWithin(left_event.geom::geography, right_event.geom::geography, $2)
		ORDER BY event_id_a ASC, event_id_b ASC
	`;

	try {
		const result = await pool.query<SpatialEntityEventPairRow>(sql, [eventIds, distanceMeters]);
		return result.rows.map(mapSpatialEntityEventPair);
	} catch (error: unknown) {
		throw new DatabaseError(
			'Failed to load spatially proximate entity-event pairs',
			DATABASE_ERROR_CODES.DB_QUERY_FAILED,
			{
				cause: error,
				context: {
					eventCount: eventIds.length,
					distanceMeters,
				},
			},
		);
	}
}

export async function deleteAllSpatioTemporalClusters(pool: Queryable): Promise<number> {
	const sql = 'DELETE FROM spatio_temporal_clusters';

	try {
		const result = await pool.query(sql);
		const deletedCount = result.rowCount ?? 0;
		if (deletedCount > 0) {
			repoLogger.debug({ deletedCount }, 'Spatio-temporal clusters deleted');
		}
		return deletedCount;
	} catch (error: unknown) {
		throw new DatabaseError('Failed to delete spatio-temporal clusters', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
		});
	}
}

export async function createSpatioTemporalClusters(
	pool: Queryable,
	inputs: CreateSpatioTemporalClusterInput[],
): Promise<SpatioTemporalCluster[]> {
	if (inputs.length === 0) {
		return [];
	}

	const sql = `
		INSERT INTO spatio_temporal_clusters (
			center_lat,
			center_lng,
			time_start,
			time_end,
			event_count,
			event_ids,
			cluster_type,
			computed_at
		)
		VALUES ${createClusterValueSql(inputs.length)}
		RETURNING *
	`;

	const params: unknown[] = [];
	for (const input of inputs) {
		params.push(
			input.centerLat ?? null,
			input.centerLng ?? null,
			input.timeStart ?? null,
			input.timeEnd ?? null,
			input.eventCount,
			input.eventIds,
			input.clusterType,
			input.computedAt ?? new Date(),
		);
	}

	try {
		const result = await pool.query<SpatioTemporalClusterRow>(sql, params);
		repoLogger.debug({ insertedCount: result.rows.length }, 'Spatio-temporal clusters inserted');
		return result.rows.map(mapSpatioTemporalCluster);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to insert spatio-temporal clusters', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: {
				rowCount: inputs.length,
			},
		});
	}
}

export async function replaceSpatioTemporalClustersSnapshot(
	pool: pg.Pool,
	inputs: CreateSpatioTemporalClusterInput[],
): Promise<SpatioTemporalCluster[]> {
	const client = await pool.connect();

	try {
		await client.query('BEGIN');
		await deleteAllSpatioTemporalClusters(client);
		const created = await createSpatioTemporalClusters(client, inputs);
		await client.query('COMMIT');
		return created;
	} catch (error: unknown) {
		await client.query('ROLLBACK').catch(() => {});
		throw new DatabaseError(
			'Failed to replace spatio-temporal cluster snapshot',
			DATABASE_ERROR_CODES.DB_QUERY_FAILED,
			{
				cause: error,
				context: {
					rowCount: inputs.length,
				},
			},
		);
	} finally {
		client.release();
	}
}

export async function findAllSpatioTemporalClusters(
	pool: Queryable,
	filter?: SpatioTemporalClusterFilter,
): Promise<SpatioTemporalCluster[]> {
	const conditions: string[] = [];
	const params: unknown[] = [];
	let paramIndex = 1;

	if (filter?.clusterType) {
		conditions.push(`cluster_type = $${paramIndex}`);
		params.push(filter.clusterType);
		paramIndex++;
	}

	const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
	const sql = `
		SELECT *
		FROM spatio_temporal_clusters
		${whereClause}
		ORDER BY cluster_type ASC NULLS LAST, computed_at DESC, id ASC
	`;

	try {
		const result = await pool.query<SpatioTemporalClusterRow>(sql, params);
		return result.rows.map(mapSpatioTemporalCluster);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to find spatio-temporal clusters', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { filter },
		});
	}
}

export async function countSpatioTemporalClusters(
	pool: Queryable,
	filter?: SpatioTemporalClusterFilter,
): Promise<number> {
	const conditions: string[] = [];
	const params: unknown[] = [];
	let paramIndex = 1;

	if (filter?.clusterType) {
		conditions.push(`cluster_type = $${paramIndex}`);
		params.push(filter.clusterType);
		paramIndex++;
	}

	const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
	const sql = `SELECT COUNT(*) FROM spatio_temporal_clusters ${whereClause}`;

	try {
		const result = await pool.query<{ count: string }>(sql, params);
		return Number.parseInt(result.rows[0].count, 10);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to count spatio-temporal clusters', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { filter },
		});
	}
}
