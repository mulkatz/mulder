import type pg from 'pg';
import { allowedSensitivityLevelsForMax } from '../../shared/access-control.js';
import { DATABASE_ERROR_CODES, DatabaseError } from '../../shared/errors.js';
import { normalizeSensitivityMetadata, stringifySensitivityMetadata } from '../../shared/sensitivity.js';
import {
	mapArtifactProvenanceFromDb,
	mergeArtifactProvenanceSql,
	stringifyArtifactProvenance,
} from './artifact-provenance.js';
import type {
	CoreSimilarityDimensions,
	DomainSimilarityDimension,
	ListSimilarEntitiesOptions,
	SimilarityCacheRecord,
	SimilarityDimensionScore,
	SimilarityPairOptions,
	SimilarityResult,
	UpsertSimilarityResultInput,
} from './similarity.types.js';

type Queryable = pg.Pool | pg.PoolClient;

interface SimilarityCacheRow {
	id: string;
	entity_id_a: string;
	entity_id_b: string;
	core_scores: unknown;
	domain_scores: unknown;
	explanation: string;
	shared_entity_ids: string[];
	key_differences: string[];
	rank_position: number | null;
	review_status: SimilarityCacheRecord['reviewStatus'];
	auto_discovered: boolean;
	auto_discovery_metadata: unknown;
	provenance: unknown;
	sensitivity_level: SimilarityCacheRecord['sensitivityLevel'];
	sensitivity_metadata: unknown;
	created_at: Date;
	updated_at: Date;
	deleted_at: Date | null;
}

interface SimilarityResultRow extends SimilarityCacheRow {
	other_entity_id: string;
	other_entity_title: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function dimensionScoreFromUnknown(value: unknown, fallbackReason: string): SimilarityDimensionScore {
	if (!isRecord(value)) {
		return { status: 'insufficient_data', score: null, reason: fallbackReason };
	}
	const rawStatus = value.status;
	const status = rawStatus === 'scored' || rawStatus === 'insufficient_data' ? rawStatus : 'insufficient_data';
	const rawScore = value.score;
	const score = typeof rawScore === 'number' && Number.isFinite(rawScore) ? Math.min(1, Math.max(0, rawScore)) : null;
	const rawReason = value.reason;
	const reason = typeof rawReason === 'string' && rawReason.trim().length > 0 ? rawReason : null;
	return { status, score: status === 'scored' ? score : null, reason };
}

function mapCoreScores(value: unknown): CoreSimilarityDimensions {
	const root = isRecord(value) ? value : {};
	return {
		semantic: dimensionScoreFromUnknown(root.semantic, 'missing_semantic_score'),
		structural: dimensionScoreFromUnknown(root.structural, 'missing_structural_score'),
		geospatial: dimensionScoreFromUnknown(root.geospatial, 'missing_geospatial_score'),
		temporal: dimensionScoreFromUnknown(root.temporal, 'missing_temporal_score'),
	};
}

function mapDomainScores(value: unknown): DomainSimilarityDimension[] {
	const rawDimensions = Array.isArray(value) ? value : [];
	return rawDimensions.flatMap((item) => {
		if (!isRecord(item)) return [];
		const id = typeof item.id === 'string' ? item.id : '';
		const label = typeof item.label === 'string' ? item.label : '';
		const source = item.source;
		const configRef = typeof item.configRef === 'string' ? item.configRef : '';
		if (!id || !label || !configRef) return [];
		if (source !== 'taxonomy_mapping' && source !== 'attribute_comparison' && source !== 'custom_scorer') return [];
		const score =
			typeof item.score === 'number' && Number.isFinite(item.score) ? Math.min(1, Math.max(0, item.score)) : null;
		const status = item.status === 'scored' ? 'scored' : 'insufficient_data';
		const reason = typeof item.reason === 'string' && item.reason.trim().length > 0 ? item.reason : null;
		const metadata = isRecord(item.metadata) ? item.metadata : {};
		return [{ id, label, source, configRef, score: status === 'scored' ? score : null, status, reason, metadata }];
	});
}

function stringifyDomainScores(value: readonly DomainSimilarityDimension[] | undefined): string {
	return JSON.stringify(
		(value ?? []).map((dimension) => ({
			...dimension,
			score: dimension.status === 'scored' ? dimension.score : null,
		})),
	);
}

function mapSimilarityCacheRow(row: SimilarityCacheRow): SimilarityCacheRecord {
	return {
		id: row.id,
		entityIdA: row.entity_id_a,
		entityIdB: row.entity_id_b,
		core: mapCoreScores(row.core_scores),
		domain: mapDomainScores(row.domain_scores),
		explanation: row.explanation,
		sharedEntityIds: row.shared_entity_ids ?? [],
		keyDifferences: row.key_differences ?? [],
		rankPosition: row.rank_position,
		reviewStatus: row.review_status,
		autoDiscovered: row.auto_discovered,
		autoDiscoveryMetadata: isRecord(row.auto_discovery_metadata) ? row.auto_discovery_metadata : {},
		provenance: mapArtifactProvenanceFromDb(row.provenance),
		sensitivityLevel: row.sensitivity_level ?? 'internal',
		sensitivityMetadata: normalizeSensitivityMetadata(row.sensitivity_metadata, row.sensitivity_level ?? 'internal'),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		deletedAt: row.deleted_at,
	};
}

function mapSimilarityResultRow(row: SimilarityResultRow): SimilarityResult {
	const record = mapSimilarityCacheRow(row);
	return {
		entityId: row.other_entity_id,
		entityTitle: row.other_entity_title,
		overallRank: record.rankPosition ?? 0,
		core: record.core,
		domain: record.domain,
		explanation: record.explanation,
		sharedEntityIds: record.sharedEntityIds,
		keyDifferences: record.keyDifferences,
		provenance: record.provenance,
		sensitivityLevel: record.sensitivityLevel,
		sensitivityMetadata: record.sensitivityMetadata,
		reviewStatus: record.reviewStatus,
		autoDiscovered: record.autoDiscovered,
	};
}

function pairWhereClause(alias: string, includeDeleted: boolean | undefined): string {
	return `
		LEAST(${alias}.entity_id_a, ${alias}.entity_id_b) = LEAST($1::uuid, $2::uuid)
		AND GREATEST(${alias}.entity_id_a, ${alias}.entity_id_b) = GREATEST($1::uuid, $2::uuid)
		${includeDeleted ? '' : `AND ${alias}.deleted_at IS NULL`}
	`;
}

export async function upsertSimilarityResult(
	pool: Queryable,
	input: UpsertSimilarityResultInput,
): Promise<SimilarityCacheRecord> {
	if (input.sourceEntityId === input.targetEntityId) {
		throw new DatabaseError(
			'Similarity pair must contain two distinct entities',
			DATABASE_ERROR_CODES.DB_QUERY_FAILED,
			{
				context: { entityId: input.sourceEntityId },
			},
		);
	}

	const sensitivityLevel = input.sensitivityLevel ?? 'internal';
	const sql = `
		INSERT INTO similarity_cache (
			entity_id_a,
			entity_id_b,
			core_scores,
			domain_scores,
			explanation,
			shared_entity_ids,
			key_differences,
			rank_position,
			review_status,
			auto_discovered,
			auto_discovery_metadata,
			provenance,
			sensitivity_level,
			sensitivity_metadata
		)
		VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6::uuid[], $7::text[], $8, $9, $10, $11::jsonb, $12::jsonb, $13, $14::jsonb)
		ON CONFLICT (pair_entity_id_low, pair_entity_id_high)
		WHERE deleted_at IS NULL
		DO UPDATE SET
			core_scores = EXCLUDED.core_scores,
			domain_scores = EXCLUDED.domain_scores,
			explanation = EXCLUDED.explanation,
			shared_entity_ids = EXCLUDED.shared_entity_ids,
			key_differences = EXCLUDED.key_differences,
			rank_position = EXCLUDED.rank_position,
			review_status = EXCLUDED.review_status,
			auto_discovered = EXCLUDED.auto_discovered,
			auto_discovery_metadata = EXCLUDED.auto_discovery_metadata,
			provenance = ${mergeArtifactProvenanceSql('similarity_cache.provenance', 'EXCLUDED.provenance')},
			sensitivity_level = EXCLUDED.sensitivity_level,
			sensitivity_metadata = EXCLUDED.sensitivity_metadata,
			updated_at = now()
		RETURNING *
	`;
	const params = [
		input.sourceEntityId,
		input.targetEntityId,
		JSON.stringify(input.core),
		stringifyDomainScores(input.domain),
		input.explanation ?? '',
		input.sharedEntityIds ?? [],
		input.keyDifferences ?? [],
		input.rankPosition ?? null,
		input.reviewStatus ?? 'pending',
		input.autoDiscovered ?? false,
		JSON.stringify(input.autoDiscoveryMetadata ?? {}),
		stringifyArtifactProvenance(input.provenance),
		sensitivityLevel,
		stringifySensitivityMetadata(input.sensitivityMetadata, sensitivityLevel),
	];

	try {
		const result = await pool.query<SimilarityCacheRow>(sql, params);
		return mapSimilarityCacheRow(result.rows[0]);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to upsert similarity result', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { sourceEntityId: input.sourceEntityId, targetEntityId: input.targetEntityId },
		});
	}
}

export async function findSimilarityByPair(
	pool: Queryable,
	entityIdA: string,
	entityIdB: string,
	options?: SimilarityPairOptions,
): Promise<SimilarityCacheRecord | null> {
	const conditions = [pairWhereClause('sc', options?.includeDeleted)];
	const params: unknown[] = [entityIdA, entityIdB];
	if (options?.maxSensitivityLevel) {
		conditions.push(`sc.sensitivity_level = ANY($3)`);
		params.push(allowedSensitivityLevelsForMax(options.maxSensitivityLevel));
	}

	try {
		const result = await pool.query<SimilarityCacheRow>(
			`SELECT sc.* FROM similarity_cache sc WHERE ${conditions.join(' AND ')} LIMIT 1`,
			params,
		);
		return result.rows[0] ? mapSimilarityCacheRow(result.rows[0]) : null;
	} catch (error: unknown) {
		throw new DatabaseError('Failed to find similarity pair', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { entityIdA, entityIdB },
		});
	}
}

export async function listSimilarEntities(
	pool: Queryable,
	options: ListSimilarEntitiesOptions,
): Promise<SimilarityResult[]> {
	const conditions = ['(sc.entity_id_a = $1 OR sc.entity_id_b = $1)'];
	const params: unknown[] = [options.entityId];
	let paramIndex = 2;
	if (!options.includeDeleted) {
		conditions.push('sc.deleted_at IS NULL');
	}
	if (options.maxSensitivityLevel) {
		conditions.push(`sc.sensitivity_level = ANY($${paramIndex})`);
		params.push(allowedSensitivityLevelsForMax(options.maxSensitivityLevel));
		paramIndex++;
	}
	params.push(options.limit ?? 10, options.offset ?? 0);

	const sql = `
		SELECT
			sc.*,
			other_entity.id AS other_entity_id,
			other_entity.name AS other_entity_title
		FROM similarity_cache sc
		JOIN entities other_entity
			ON other_entity.id = CASE WHEN sc.entity_id_a = $1 THEN sc.entity_id_b ELSE sc.entity_id_a END
		WHERE ${conditions.join(' AND ')}
		ORDER BY sc.rank_position ASC NULLS LAST, sc.updated_at DESC, sc.id ASC
		LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
	`;

	try {
		const result = await pool.query<SimilarityResultRow>(sql, params);
		return result.rows.map(mapSimilarityResultRow);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to list similar entities', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { entityId: options.entityId },
		});
	}
}

export async function countSimilarEntities(pool: Queryable, options: ListSimilarEntitiesOptions): Promise<number> {
	const conditions = ['(sc.entity_id_a = $1 OR sc.entity_id_b = $1)'];
	const params: unknown[] = [options.entityId];
	let paramIndex = 2;
	if (!options.includeDeleted) {
		conditions.push('sc.deleted_at IS NULL');
	}
	if (options.maxSensitivityLevel) {
		conditions.push(`sc.sensitivity_level = ANY($${paramIndex})`);
		params.push(allowedSensitivityLevelsForMax(options.maxSensitivityLevel));
		paramIndex++;
	}

	const sql = `
		SELECT COUNT(*) AS count
		FROM similarity_cache sc
		JOIN entities other_entity
			ON other_entity.id = CASE WHEN sc.entity_id_a = $1 THEN sc.entity_id_b ELSE sc.entity_id_a END
		WHERE ${conditions.join(' AND ')}
	`;

	try {
		const result = await pool.query<{ count: string }>(sql, params);
		return Number.parseInt(result.rows[0]?.count ?? '0', 10) || 0;
	} catch (error: unknown) {
		throw new DatabaseError('Failed to count similar entities', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { entityId: options.entityId },
		});
	}
}

export async function deleteSimilarityResultsForEntity(pool: Queryable, entityId: string): Promise<number> {
	try {
		const result = await pool.query(
			`
				UPDATE similarity_cache
				SET deleted_at = now(), updated_at = now()
				WHERE deleted_at IS NULL
				  AND (entity_id_a = $1 OR entity_id_b = $1)
			`,
			[entityId],
		);
		return result.rowCount ?? 0;
	} catch (error: unknown) {
		throw new DatabaseError('Failed to delete similarity results for entity', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { entityId },
		});
	}
}

export function normalizeSharedEntityIds(value: unknown): string[] {
	return isStringArray(value) ? [...new Set(value)].sort((left, right) => left.localeCompare(right)) : [];
}
