import type pg from 'pg';
import { allowedSensitivityLevelsForMax } from '../../shared/access-control.js';
import { DATABASE_ERROR_CODES, DatabaseError } from '../../shared/errors.js';
import { normalizeSensitivityMetadata, stringifySensitivityMetadata } from '../../shared/sensitivity.js';
import { mapArtifactProvenanceFromDb, stringifyArtifactProvenance } from './artifact-provenance.js';
import type { ClassificationCategoryRef } from './classification-harmonization.types.js';
import type {
	CreateExternalCorrelationInput,
	CreateSpatiotemporalHotspotClusterInput,
	CreateTemporalAnomalyClusterInput,
	ExternalCorrelation,
	ExternalCorrelationListOptions,
	ExternalCorrelationMethod,
	HotspotPersistence,
	ReplaceExternalCorrelationSnapshotInput,
	ReplaceExternalCorrelationSnapshotResult,
	ReplaceTemporalPatternSnapshotInput,
	ReplaceTemporalPatternSnapshotResult,
	SpatiotemporalHotspotCluster,
	SpatiotemporalHotspotClusterListOptions,
	SpatiotemporalHotspotType,
	TemporalAnomalyCluster,
	TemporalAnomalyClusterListOptions,
	TemporalAnomalyType,
	TemporalPatternEntityEvent,
	TemporalPatternFindOptions,
	TemporalPatternListOptions,
	TemporalPatternReviewStatus,
} from './temporal-pattern.types.js';

type Queryable = pg.Pool | pg.PoolClient;

const WEAK_SIGNAL_CAVEAT = 'Patterns are hypothesis starters, not causal evidence.';
const CORRELATION_CAVEAT = 'Correlation ≠ Causation';

interface TemporalPatternEntityEventRow {
	entity_id: string;
	iso_date: string | null;
	latitude: number | null;
	longitude: number | null;
	attributes: unknown;
	provenance: unknown;
	sensitivity_level: TemporalPatternEntityEvent['sensitivityLevel'];
	sensitivity_metadata: unknown;
}

interface TemporalAnomalyClusterRow {
	id: string;
	region_key: string;
	region_geojson: unknown;
	anomaly_type: TemporalAnomalyType;
	time_start: Date;
	time_end: Date;
	entity_count: number;
	baseline_rate: number | string;
	observed_rate: number | string;
	raw_significance: number | string;
	comparison_count: number;
	corrected_significance: number | string;
	significance_threshold: number | string;
	peak_date: Date;
	dominant_category_ref: unknown;
	contributing_entity_ids: string[];
	known_pattern_match: string | null;
	bias_warning: string | null;
	signal_strength: TemporalAnomalyCluster['signalStrength'];
	caveats: string[];
	review_status: TemporalPatternReviewStatus;
	provenance: unknown;
	sensitivity_level: TemporalAnomalyCluster['sensitivityLevel'];
	sensitivity_metadata: unknown;
	computed_at: Date;
	deleted_at: Date | null;
}

interface SpatiotemporalHotspotClusterRow {
	id: string;
	region_key: string;
	hotspot_type: SpatiotemporalHotspotType;
	centroid_lat: number | string;
	centroid_lng: number | string;
	radius_km: number | string;
	time_start: Date;
	time_end: Date;
	entity_count: number;
	density: number | string;
	persistence: HotspotPersistence;
	recurrence_pattern: string | null;
	related_cluster_ids: string[];
	contributing_entity_ids: string[];
	dominant_category_ref: unknown;
	bias_warning: string | null;
	signal_strength: SpatiotemporalHotspotCluster['signalStrength'];
	caveats: string[];
	review_status: TemporalPatternReviewStatus;
	provenance: unknown;
	sensitivity_level: SpatiotemporalHotspotCluster['sensitivityLevel'];
	sensitivity_metadata: unknown;
	computed_at: Date;
	deleted_at: Date | null;
}

interface ExternalCorrelationRow {
	id: string;
	internal_series_key: string;
	external_source_id: string;
	external_series_id: string;
	method: ExternalCorrelationMethod;
	coefficient: number | string;
	p_value: number | string;
	lag_days: number;
	time_start: Date;
	time_end: Date;
	data_point_count: number;
	contributing_entity_ids: string[];
	interpretation_caveat: string;
	signal_strength: ExternalCorrelation['signalStrength'];
	caveats: string[];
	review_status: TemporalPatternReviewStatus;
	provenance: unknown;
	sensitivity_level: ExternalCorrelation['sensitivityLevel'];
	sensitivity_metadata: unknown;
	computed_at: Date;
	deleted_at: Date | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | null {
	return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function normalizeJsonObject(value: unknown): Record<string, unknown> | null {
	return isRecord(value) ? value : null;
}

function normalizeAttributes(value: unknown): Record<string, unknown> {
	return isRecord(value) ? value : {};
}

function categoryRef(categoryId: string, taxonomyId: string | null): ClassificationCategoryRef {
	return taxonomyId ? { taxonomyId, categoryId } : { categoryId };
}

function categoryRefKey(ref: ClassificationCategoryRef): string {
	return `${ref.taxonomyId ?? ''}:${ref.categoryId}`;
}

function uniqueCategoryRefs(refs: ClassificationCategoryRef[]): ClassificationCategoryRef[] {
	const unique = new Map<string, ClassificationCategoryRef>();
	for (const ref of refs) {
		const categoryId = readNonEmptyString(ref.categoryId);
		if (!categoryId) continue;
		const taxonomyId = readNonEmptyString(ref.taxonomyId);
		const normalized = categoryRef(categoryId, taxonomyId);
		unique.set(categoryRefKey(normalized), normalized);
	}
	return [...unique.values()].sort(
		(left, right) =>
			(left.taxonomyId ?? '').localeCompare(right.taxonomyId ?? '') || left.categoryId.localeCompare(right.categoryId),
	);
}

function categoryRefsFromRecord(
	value: Record<string, unknown>,
	fallbackTaxonomyId: string | null,
): ClassificationCategoryRef[] {
	for (const nestedKey of ['refs', 'categories', 'category_refs', 'classification_refs']) {
		const nestedValue = value[nestedKey];
		if (Array.isArray(nestedValue)) return categoryRefsFromAttribute(nestedValue, fallbackTaxonomyId);
	}

	const categoryId = readNonEmptyString(value.categoryId ?? value.category_id ?? value.id);
	if (!categoryId) return [];
	const taxonomyId = readNonEmptyString(value.taxonomyId ?? value.taxonomy_id) ?? fallbackTaxonomyId;
	return [categoryRef(categoryId, taxonomyId)];
}

function categoryRefsFromAttribute(value: unknown, fallbackTaxonomyId: string | null): ClassificationCategoryRef[] {
	if (Array.isArray(value)) {
		return uniqueCategoryRefs(value.flatMap((item) => categoryRefsFromAttribute(item, fallbackTaxonomyId)));
	}

	const categoryId = readNonEmptyString(value);
	if (categoryId) return [categoryRef(categoryId, fallbackTaxonomyId)];
	if (isRecord(value)) return categoryRefsFromRecord(value, fallbackTaxonomyId);
	return [];
}

function categoryRefsFromAttributes(attributes: Record<string, unknown>): ClassificationCategoryRef[] {
	const fallbackTaxonomyId = readNonEmptyString(attributes.taxonomy_id ?? attributes.taxonomyId);
	const refs: ClassificationCategoryRef[] = [];
	for (const key of ['category_ref', 'category_refs', 'classification_ref', 'classification_refs', 'categories']) {
		refs.push(...categoryRefsFromAttribute(attributes[key], fallbackTaxonomyId));
	}
	return uniqueCategoryRefs(refs);
}

function categoryRefFromDb(value: unknown): ClassificationCategoryRef | null {
	if (!isRecord(value)) return null;
	const categoryId = readNonEmptyString(value.categoryId ?? value.category_id);
	if (!categoryId) return null;
	const taxonomyId = readNonEmptyString(value.taxonomyId ?? value.taxonomy_id);
	return categoryRef(categoryId, taxonomyId);
}

function categoryRefToDb(value: ClassificationCategoryRef | null | undefined): string | null {
	if (!value) return null;
	return JSON.stringify({
		category_id: value.categoryId,
		taxonomy_id: value.taxonomyId ?? null,
	});
}

function normalizeCaveats(value: readonly string[] | undefined): string[] {
	const caveats = new Set<string>();
	for (const item of value ?? []) {
		const trimmed = item.trim();
		if (trimmed.length > 0) caveats.add(trimmed);
	}
	caveats.add(WEAK_SIGNAL_CAVEAT);
	return [...caveats].sort();
}

function normalizeCorrelationCaveats(value: readonly string[] | undefined): string[] {
	const caveats = new Set<string>();
	for (const item of value ?? []) {
		const trimmed = item.trim();
		if (trimmed.length > 0) caveats.add(trimmed);
	}
	caveats.add(CORRELATION_CAVEAT);
	return [...caveats].sort();
}

function numeric(value: number | string): number {
	return typeof value === 'number' ? value : Number.parseFloat(value);
}

function mapTemporalPatternEntityEvent(row: TemporalPatternEntityEventRow): TemporalPatternEntityEvent {
	const attributes = normalizeAttributes(row.attributes);
	return {
		entityId: row.entity_id,
		isoDate: row.iso_date,
		latitude: row.latitude === null ? null : Number(row.latitude),
		longitude: row.longitude === null ? null : Number(row.longitude),
		attributes,
		categoryRefs: categoryRefsFromAttributes(attributes),
		provenance: mapArtifactProvenanceFromDb(row.provenance),
		sensitivityLevel: row.sensitivity_level ?? 'internal',
		sensitivityMetadata: normalizeSensitivityMetadata(row.sensitivity_metadata, row.sensitivity_level ?? 'internal'),
	};
}

function mapTemporalAnomalyCluster(row: TemporalAnomalyClusterRow): TemporalAnomalyCluster {
	return {
		id: row.id,
		regionKey: row.region_key,
		regionGeojson: normalizeJsonObject(row.region_geojson),
		anomalyType: row.anomaly_type,
		timeStart: row.time_start,
		timeEnd: row.time_end,
		entityCount: Number(row.entity_count),
		baselineRate: numeric(row.baseline_rate),
		observedRate: numeric(row.observed_rate),
		rawSignificance: numeric(row.raw_significance),
		comparisonCount: Number(row.comparison_count),
		correctedSignificance: numeric(row.corrected_significance),
		significanceThreshold: numeric(row.significance_threshold),
		peakDate: row.peak_date,
		dominantCategoryRef: categoryRefFromDb(row.dominant_category_ref),
		contributingEntityIds: row.contributing_entity_ids ?? [],
		knownPatternMatch: row.known_pattern_match,
		biasWarning: row.bias_warning,
		signalStrength: row.signal_strength,
		caveats: row.caveats ?? [],
		reviewStatus: row.review_status,
		provenance: mapArtifactProvenanceFromDb(row.provenance),
		sensitivityLevel: row.sensitivity_level ?? 'internal',
		sensitivityMetadata: normalizeSensitivityMetadata(row.sensitivity_metadata, row.sensitivity_level ?? 'internal'),
		computedAt: row.computed_at,
		deletedAt: row.deleted_at,
	};
}

function mapSpatiotemporalHotspotCluster(row: SpatiotemporalHotspotClusterRow): SpatiotemporalHotspotCluster {
	return {
		id: row.id,
		regionKey: row.region_key,
		hotspotType: row.hotspot_type,
		centroidLat: numeric(row.centroid_lat),
		centroidLng: numeric(row.centroid_lng),
		radiusKm: numeric(row.radius_km),
		timeStart: row.time_start,
		timeEnd: row.time_end,
		entityCount: Number(row.entity_count),
		density: numeric(row.density),
		persistence: row.persistence,
		recurrencePattern: row.recurrence_pattern,
		relatedClusterIds: row.related_cluster_ids ?? [],
		contributingEntityIds: row.contributing_entity_ids ?? [],
		dominantCategoryRef: categoryRefFromDb(row.dominant_category_ref),
		biasWarning: row.bias_warning,
		signalStrength: row.signal_strength,
		caveats: row.caveats ?? [],
		reviewStatus: row.review_status,
		provenance: mapArtifactProvenanceFromDb(row.provenance),
		sensitivityLevel: row.sensitivity_level ?? 'internal',
		sensitivityMetadata: normalizeSensitivityMetadata(row.sensitivity_metadata, row.sensitivity_level ?? 'internal'),
		computedAt: row.computed_at,
		deletedAt: row.deleted_at,
	};
}

function mapExternalCorrelation(row: ExternalCorrelationRow): ExternalCorrelation {
	return {
		id: row.id,
		internalSeriesKey: row.internal_series_key,
		externalSourceId: row.external_source_id,
		externalSeriesId: row.external_series_id,
		method: row.method,
		coefficient: numeric(row.coefficient),
		pValue: numeric(row.p_value),
		lagDays: Number(row.lag_days),
		timeStart: row.time_start,
		timeEnd: row.time_end,
		dataPointCount: Number(row.data_point_count),
		contributingEntityIds: row.contributing_entity_ids ?? [],
		interpretationCaveat: row.interpretation_caveat,
		signalStrength: row.signal_strength,
		caveats: row.caveats ?? [],
		reviewStatus: row.review_status,
		provenance: mapArtifactProvenanceFromDb(row.provenance),
		sensitivityLevel: row.sensitivity_level ?? 'internal',
		sensitivityMetadata: normalizeSensitivityMetadata(row.sensitivity_metadata, row.sensitivity_level ?? 'internal'),
		computedAt: row.computed_at,
		deletedAt: row.deleted_at,
	};
}

function appendCommonFilters(
	conditions: string[],
	params: unknown[],
	alias: string,
	options?: TemporalPatternListOptions | TemporalPatternFindOptions,
): void {
	if (!options?.includeDeleted) {
		conditions.push(`${alias}.deleted_at IS NULL`);
	}
	if (options?.maxSensitivityLevel) {
		params.push(allowedSensitivityLevelsForMax(options.maxSensitivityLevel));
		conditions.push(`${alias}.sensitivity_level = ANY($${params.length})`);
	}
}

function appendListFilters(
	conditions: string[],
	params: unknown[],
	alias: string,
	options?: TemporalPatternListOptions,
): void {
	appendCommonFilters(conditions, params, alias, options);
	if (!options) return;

	if (options.regionKey) {
		params.push(options.regionKey);
		conditions.push(`${alias}.region_key = $${params.length}`);
	}
	if (options.timeStart) {
		params.push(options.timeStart);
		conditions.push(`${alias}.time_end >= $${params.length}`);
	}
	if (options.timeEnd) {
		params.push(options.timeEnd);
		conditions.push(`${alias}.time_start <= $${params.length}`);
	}
	if (options.reviewStatus) {
		params.push(Array.isArray(options.reviewStatus) ? [...options.reviewStatus] : [options.reviewStatus]);
		conditions.push(`${alias}.review_status = ANY($${params.length})`);
	}
	if (options.signalStrength) {
		params.push(options.signalStrength);
		conditions.push(`${alias}.signal_strength = $${params.length}`);
	}
}

function appendLimitOffset(params: unknown[], limit: number | undefined, offset: number | undefined): string {
	const clauses: string[] = [];
	if (limit !== undefined) {
		params.push(limit);
		clauses.push(`LIMIT $${params.length}`);
	}
	if (offset !== undefined) {
		params.push(offset);
		clauses.push(`OFFSET $${params.length}`);
	}
	return clauses.join(' ');
}

async function softDeleteTemporalAnomalyClusters(pool: Queryable): Promise<number> {
	const result = await pool.query('UPDATE temporal_anomaly_clusters SET deleted_at = now() WHERE deleted_at IS NULL');
	return result.rowCount ?? 0;
}

async function softDeleteSpatiotemporalHotspotClusters(pool: Queryable): Promise<number> {
	const result = await pool.query(
		'UPDATE spatiotemporal_hotspot_clusters SET deleted_at = now() WHERE deleted_at IS NULL',
	);
	return result.rowCount ?? 0;
}

async function softDeleteExternalCorrelations(pool: Queryable): Promise<number> {
	const result = await pool.query('UPDATE external_correlations SET deleted_at = now() WHERE deleted_at IS NULL');
	return result.rowCount ?? 0;
}

async function upsertTemporalAnomalyCluster(
	pool: Queryable,
	input: CreateTemporalAnomalyClusterInput,
): Promise<TemporalAnomalyCluster> {
	const sensitivityLevel = input.sensitivityLevel ?? 'internal';
	const sql = `
		INSERT INTO temporal_anomaly_clusters (
			id,
			region_key,
			region_geojson,
			anomaly_type,
			time_start,
			time_end,
			entity_count,
			baseline_rate,
			observed_rate,
			raw_significance,
			comparison_count,
			corrected_significance,
			significance_threshold,
			peak_date,
			dominant_category_ref,
			contributing_entity_ids,
			known_pattern_match,
			bias_warning,
			caveats,
			review_status,
			provenance,
			sensitivity_level,
			sensitivity_metadata,
			computed_at,
			deleted_at
		)
		VALUES (
			COALESCE($1::uuid, gen_random_uuid()),
			$2,
			$3::jsonb,
			$4,
			$5,
			$6,
			$7,
			$8,
			$9,
			$10,
			$11,
			$12,
			$13,
			$14,
			$15::jsonb,
			$16::uuid[],
			$17,
			$18,
			$19::text[],
			$20,
			$21::jsonb,
			$22,
			$23::jsonb,
			$24,
			NULL
		)
		ON CONFLICT (id) DO UPDATE SET
			region_key = EXCLUDED.region_key,
			region_geojson = EXCLUDED.region_geojson,
			anomaly_type = EXCLUDED.anomaly_type,
			time_start = EXCLUDED.time_start,
			time_end = EXCLUDED.time_end,
			entity_count = EXCLUDED.entity_count,
			baseline_rate = EXCLUDED.baseline_rate,
			observed_rate = EXCLUDED.observed_rate,
			raw_significance = EXCLUDED.raw_significance,
			comparison_count = EXCLUDED.comparison_count,
			corrected_significance = EXCLUDED.corrected_significance,
			significance_threshold = EXCLUDED.significance_threshold,
			peak_date = EXCLUDED.peak_date,
			dominant_category_ref = EXCLUDED.dominant_category_ref,
			contributing_entity_ids = EXCLUDED.contributing_entity_ids,
			known_pattern_match = EXCLUDED.known_pattern_match,
			bias_warning = EXCLUDED.bias_warning,
			caveats = EXCLUDED.caveats,
			review_status = EXCLUDED.review_status,
			provenance = EXCLUDED.provenance,
			sensitivity_level = EXCLUDED.sensitivity_level,
			sensitivity_metadata = EXCLUDED.sensitivity_metadata,
			computed_at = EXCLUDED.computed_at,
			deleted_at = NULL
		RETURNING *
	`;

	const params = [
		input.id ?? null,
		input.regionKey,
		input.regionGeojson == null ? null : JSON.stringify(input.regionGeojson),
		input.anomalyType ?? 'frequency_spike',
		input.timeStart,
		input.timeEnd,
		input.entityCount,
		input.baselineRate,
		input.observedRate,
		input.rawSignificance,
		input.comparisonCount,
		input.correctedSignificance,
		input.significanceThreshold,
		input.peakDate,
		categoryRefToDb(input.dominantCategoryRef),
		input.contributingEntityIds,
		input.knownPatternMatch ?? null,
		input.biasWarning ?? null,
		normalizeCaveats(input.caveats),
		input.reviewStatus ?? 'pending',
		stringifyArtifactProvenance(input.provenance),
		sensitivityLevel,
		stringifySensitivityMetadata(input.sensitivityMetadata, sensitivityLevel),
		input.computedAt ?? new Date(),
	];

	const result = await pool.query<TemporalAnomalyClusterRow>(sql, params);
	return mapTemporalAnomalyCluster(result.rows[0]);
}

async function upsertSpatiotemporalHotspotCluster(
	pool: Queryable,
	input: CreateSpatiotemporalHotspotClusterInput,
): Promise<SpatiotemporalHotspotCluster> {
	const sensitivityLevel = input.sensitivityLevel ?? 'internal';
	const sql = `
		INSERT INTO spatiotemporal_hotspot_clusters (
			id,
			region_key,
			hotspot_type,
			centroid_lat,
			centroid_lng,
			radius_km,
			time_start,
			time_end,
			entity_count,
			density,
			persistence,
			recurrence_pattern,
			related_cluster_ids,
			contributing_entity_ids,
			dominant_category_ref,
			bias_warning,
			caveats,
			review_status,
			provenance,
			sensitivity_level,
			sensitivity_metadata,
			computed_at,
			deleted_at
		)
		VALUES (
			COALESCE($1::uuid, gen_random_uuid()),
			$2,
			$3,
			$4,
			$5,
			$6,
			$7,
			$8,
			$9,
			$10,
			$11,
			$12,
			$13::uuid[],
			$14::uuid[],
			$15::jsonb,
			$16,
			$17::text[],
			$18,
			$19::jsonb,
			$20,
			$21::jsonb,
			$22,
			NULL
		)
		ON CONFLICT (id) DO UPDATE SET
			region_key = EXCLUDED.region_key,
			hotspot_type = EXCLUDED.hotspot_type,
			centroid_lat = EXCLUDED.centroid_lat,
			centroid_lng = EXCLUDED.centroid_lng,
			radius_km = EXCLUDED.radius_km,
			time_start = EXCLUDED.time_start,
			time_end = EXCLUDED.time_end,
			entity_count = EXCLUDED.entity_count,
			density = EXCLUDED.density,
			persistence = EXCLUDED.persistence,
			recurrence_pattern = EXCLUDED.recurrence_pattern,
			related_cluster_ids = EXCLUDED.related_cluster_ids,
			contributing_entity_ids = EXCLUDED.contributing_entity_ids,
			dominant_category_ref = EXCLUDED.dominant_category_ref,
			bias_warning = EXCLUDED.bias_warning,
			caveats = EXCLUDED.caveats,
			review_status = EXCLUDED.review_status,
			provenance = EXCLUDED.provenance,
			sensitivity_level = EXCLUDED.sensitivity_level,
			sensitivity_metadata = EXCLUDED.sensitivity_metadata,
			computed_at = EXCLUDED.computed_at,
			deleted_at = NULL
		RETURNING *
	`;

	const params = [
		input.id ?? null,
		input.regionKey,
		input.hotspotType ?? 'density_cluster',
		input.centroidLat,
		input.centroidLng,
		input.radiusKm,
		input.timeStart,
		input.timeEnd,
		input.entityCount,
		input.density,
		input.persistence,
		input.recurrencePattern ?? null,
		input.relatedClusterIds ?? [],
		input.contributingEntityIds,
		categoryRefToDb(input.dominantCategoryRef),
		input.biasWarning ?? null,
		normalizeCaveats(input.caveats),
		input.reviewStatus ?? 'pending',
		stringifyArtifactProvenance(input.provenance),
		sensitivityLevel,
		stringifySensitivityMetadata(input.sensitivityMetadata, sensitivityLevel),
		input.computedAt ?? new Date(),
	];

	const result = await pool.query<SpatiotemporalHotspotClusterRow>(sql, params);
	return mapSpatiotemporalHotspotCluster(result.rows[0]);
}

async function upsertExternalCorrelation(
	pool: Queryable,
	input: CreateExternalCorrelationInput,
): Promise<ExternalCorrelation> {
	const sensitivityLevel = input.sensitivityLevel ?? 'internal';
	const sql = `
		INSERT INTO external_correlations (
			id,
			internal_series_key,
			external_source_id,
			external_series_id,
			method,
			coefficient,
			p_value,
			lag_days,
			time_start,
			time_end,
			data_point_count,
			contributing_entity_ids,
			interpretation_caveat,
			caveats,
			review_status,
			provenance,
			sensitivity_level,
			sensitivity_metadata,
			computed_at,
			deleted_at
		)
		VALUES (
			COALESCE($1::uuid, gen_random_uuid()),
			$2,
			$3,
			$4,
			$5,
			$6,
			$7,
			$8,
			$9,
			$10,
			$11,
			$12::uuid[],
			$13,
			$14::text[],
			$15,
			$16::jsonb,
			$17,
			$18::jsonb,
			$19,
			NULL
		)
		ON CONFLICT (id) DO UPDATE SET
			internal_series_key = EXCLUDED.internal_series_key,
			external_source_id = EXCLUDED.external_source_id,
			external_series_id = EXCLUDED.external_series_id,
			method = EXCLUDED.method,
			coefficient = EXCLUDED.coefficient,
			p_value = EXCLUDED.p_value,
			lag_days = EXCLUDED.lag_days,
			time_start = EXCLUDED.time_start,
			time_end = EXCLUDED.time_end,
			data_point_count = EXCLUDED.data_point_count,
			contributing_entity_ids = EXCLUDED.contributing_entity_ids,
			interpretation_caveat = EXCLUDED.interpretation_caveat,
			caveats = EXCLUDED.caveats,
			review_status = EXCLUDED.review_status,
			provenance = EXCLUDED.provenance,
			sensitivity_level = EXCLUDED.sensitivity_level,
			sensitivity_metadata = EXCLUDED.sensitivity_metadata,
			computed_at = EXCLUDED.computed_at,
			deleted_at = NULL
		RETURNING *
	`;
	const params = [
		input.id ?? null,
		input.internalSeriesKey,
		input.externalSourceId,
		input.externalSeriesId,
		input.method,
		input.coefficient,
		input.pValue,
		input.lagDays,
		input.timeStart,
		input.timeEnd,
		input.dataPointCount,
		input.contributingEntityIds,
		input.interpretationCaveat ?? CORRELATION_CAVEAT,
		normalizeCorrelationCaveats(input.caveats),
		input.reviewStatus ?? 'pending',
		stringifyArtifactProvenance(input.provenance),
		sensitivityLevel,
		stringifySensitivityMetadata(input.sensitivityMetadata, sensitivityLevel),
		input.computedAt ?? new Date(),
	];
	const result = await pool.query<ExternalCorrelationRow>(sql, params);
	return mapExternalCorrelation(result.rows[0]);
}

export async function loadTemporalPatternEntityEvents(pool: Queryable): Promise<TemporalPatternEntityEvent[]> {
	const sql = `
		SELECT
			id AS entity_id,
			NULLIF(BTRIM(attributes->>'iso_date'), '') AS iso_date,
			CASE WHEN geom IS NOT NULL THEN ST_Y(geom)::double precision ELSE NULL END AS latitude,
			CASE WHEN geom IS NOT NULL THEN ST_X(geom)::double precision ELSE NULL END AS longitude,
			attributes,
			provenance,
			sensitivity_level,
			sensitivity_metadata
		FROM entities
		WHERE geom IS NOT NULL
		   OR NULLIF(BTRIM(attributes->>'iso_date'), '') IS NOT NULL
		ORDER BY id ASC
	`;

	try {
		const result = await pool.query<TemporalPatternEntityEventRow>(sql);
		return result.rows.map(mapTemporalPatternEntityEvent);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to load temporal pattern entity events', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
		});
	}
}

export async function replaceTemporalPatternSnapshot(
	pool: pg.Pool,
	input: ReplaceTemporalPatternSnapshotInput,
): Promise<ReplaceTemporalPatternSnapshotResult> {
	const client = await pool.connect();

	try {
		await client.query('BEGIN');
		await softDeleteTemporalAnomalyClusters(client);
		await softDeleteSpatiotemporalHotspotClusters(client);

		const anomalies: TemporalAnomalyCluster[] = [];
		for (const anomaly of input.anomalies) {
			anomalies.push(await upsertTemporalAnomalyCluster(client, anomaly));
		}

		const hotspots: SpatiotemporalHotspotCluster[] = [];
		for (const hotspot of input.hotspots) {
			hotspots.push(await upsertSpatiotemporalHotspotCluster(client, hotspot));
		}

		await client.query('COMMIT');
		return { anomalies, hotspots };
	} catch (error: unknown) {
		await client.query('ROLLBACK').catch(() => {});
		throw new DatabaseError('Failed to replace temporal pattern snapshot', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: {
				anomalyCount: input.anomalies.length,
				hotspotCount: input.hotspots.length,
			},
		});
	} finally {
		client.release();
	}
}

export async function replaceExternalCorrelationSnapshot(
	pool: pg.Pool,
	input: ReplaceExternalCorrelationSnapshotInput,
): Promise<ReplaceExternalCorrelationSnapshotResult> {
	const client = await pool.connect();

	try {
		await client.query('BEGIN');
		await softDeleteExternalCorrelations(client);

		const correlations: ExternalCorrelation[] = [];
		for (const correlation of input.correlations) {
			correlations.push(await upsertExternalCorrelation(client, correlation));
		}

		await client.query('COMMIT');
		return { correlations };
	} catch (error: unknown) {
		await client.query('ROLLBACK').catch(() => {});
		throw new DatabaseError('Failed to replace external correlation snapshot', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { correlationCount: input.correlations.length },
		});
	} finally {
		client.release();
	}
}

export async function listTemporalAnomalyClusters(
	pool: Queryable,
	options?: TemporalAnomalyClusterListOptions,
): Promise<TemporalAnomalyCluster[]> {
	const conditions: string[] = [];
	const params: unknown[] = [];
	appendListFilters(conditions, params, 'tac', options);
	if (options?.anomalyType) {
		params.push(options.anomalyType);
		conditions.push(`tac.anomaly_type = $${params.length}`);
	}
	const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
	const limitOffset = appendLimitOffset(params, options?.limit, options?.offset);

	try {
		const result = await pool.query<TemporalAnomalyClusterRow>(
			`
				SELECT tac.*
				FROM temporal_anomaly_clusters tac
				${whereClause}
				ORDER BY tac.corrected_significance ASC, tac.time_start ASC, tac.region_key ASC, tac.id ASC
				${limitOffset}
			`,
			params,
		);
		return result.rows.map(mapTemporalAnomalyCluster);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to list temporal anomaly clusters', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { options },
		});
	}
}

export async function listExternalCorrelations(
	pool: Queryable,
	options?: ExternalCorrelationListOptions,
): Promise<ExternalCorrelation[]> {
	const conditions: string[] = [];
	const params: unknown[] = [];
	appendCommonFilters(conditions, params, 'ec', options);
	if (options?.timeStart) {
		params.push(options.timeStart);
		conditions.push(`ec.time_end >= $${params.length}`);
	}
	if (options?.timeEnd) {
		params.push(options.timeEnd);
		conditions.push(`ec.time_start <= $${params.length}`);
	}
	if (options?.reviewStatus) {
		params.push(Array.isArray(options.reviewStatus) ? [...options.reviewStatus] : [options.reviewStatus]);
		conditions.push(`ec.review_status = ANY($${params.length})`);
	}
	if (options?.signalStrength) {
		params.push(options.signalStrength);
		conditions.push(`ec.signal_strength = $${params.length}`);
	}
	if (options?.internalSeriesKey) {
		params.push(options.internalSeriesKey);
		conditions.push(`ec.internal_series_key = $${params.length}`);
	}
	if (options?.externalSourceId) {
		params.push(options.externalSourceId);
		conditions.push(`ec.external_source_id = $${params.length}`);
	}
	if (options?.externalSeriesId) {
		params.push(options.externalSeriesId);
		conditions.push(`ec.external_series_id = $${params.length}`);
	}
	if (options?.method) {
		params.push(Array.isArray(options.method) ? [...options.method] : [options.method]);
		conditions.push(`ec.method = ANY($${params.length})`);
	}
	const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
	const limitOffset = appendLimitOffset(params, options?.limit, options?.offset);

	try {
		const result = await pool.query<ExternalCorrelationRow>(
			`
				SELECT ec.*
				FROM external_correlations ec
				${whereClause}
				ORDER BY ABS(ec.coefficient) DESC, ec.time_start ASC, ec.external_source_id ASC, ec.external_series_id ASC, ec.id ASC
				${limitOffset}
			`,
			params,
		);
		return result.rows.map(mapExternalCorrelation);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to list external correlations', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { options },
		});
	}
}

export async function findExternalCorrelation(
	pool: Queryable,
	id: string,
	options?: TemporalPatternFindOptions,
): Promise<ExternalCorrelation | null> {
	const conditions = ['ec.id = $1'];
	const params: unknown[] = [id];
	appendCommonFilters(conditions, params, 'ec', options);

	try {
		const result = await pool.query<ExternalCorrelationRow>(
			`
				SELECT ec.*
				FROM external_correlations ec
				WHERE ${conditions.join(' AND ')}
				LIMIT 1
			`,
			params,
		);
		return result.rows[0] ? mapExternalCorrelation(result.rows[0]) : null;
	} catch (error: unknown) {
		throw new DatabaseError('Failed to find external correlation', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { id, options },
		});
	}
}

export async function findTemporalAnomalyCluster(
	pool: Queryable,
	id: string,
	options?: TemporalPatternFindOptions,
): Promise<TemporalAnomalyCluster | null> {
	const conditions = ['tac.id = $1'];
	const params: unknown[] = [id];
	appendCommonFilters(conditions, params, 'tac', options);

	try {
		const result = await pool.query<TemporalAnomalyClusterRow>(
			`SELECT tac.* FROM temporal_anomaly_clusters tac WHERE ${conditions.join(' AND ')} LIMIT 1`,
			params,
		);
		return result.rows[0] ? mapTemporalAnomalyCluster(result.rows[0]) : null;
	} catch (error: unknown) {
		throw new DatabaseError('Failed to find temporal anomaly cluster', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { id, options },
		});
	}
}

export async function listSpatiotemporalHotspotClusters(
	pool: Queryable,
	options?: SpatiotemporalHotspotClusterListOptions,
): Promise<SpatiotemporalHotspotCluster[]> {
	const conditions: string[] = [];
	const params: unknown[] = [];
	appendListFilters(conditions, params, 'shc', options);
	if (options?.hotspotType) {
		params.push(options.hotspotType);
		conditions.push(`shc.hotspot_type = $${params.length}`);
	}
	if (options?.persistence) {
		params.push(Array.isArray(options.persistence) ? [...options.persistence] : [options.persistence]);
		conditions.push(`shc.persistence = ANY($${params.length})`);
	}
	const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
	const limitOffset = appendLimitOffset(params, options?.limit, options?.offset);

	try {
		const result = await pool.query<SpatiotemporalHotspotClusterRow>(
			`
				SELECT shc.*
				FROM spatiotemporal_hotspot_clusters shc
				${whereClause}
				ORDER BY shc.density DESC, shc.time_start ASC, shc.region_key ASC, shc.id ASC
				${limitOffset}
			`,
			params,
		);
		return result.rows.map(mapSpatiotemporalHotspotCluster);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to list spatiotemporal hotspot clusters', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { options },
		});
	}
}

export async function findSpatiotemporalHotspotCluster(
	pool: Queryable,
	id: string,
	options?: TemporalPatternFindOptions,
): Promise<SpatiotemporalHotspotCluster | null> {
	const conditions = ['shc.id = $1'];
	const params: unknown[] = [id];
	appendCommonFilters(conditions, params, 'shc', options);

	try {
		const result = await pool.query<SpatiotemporalHotspotClusterRow>(
			`
				SELECT shc.*
				FROM spatiotemporal_hotspot_clusters shc
				WHERE ${conditions.join(' AND ')}
				LIMIT 1
			`,
			params,
		);
		return result.rows[0] ? mapSpatiotemporalHotspotCluster(result.rows[0]) : null;
	} catch (error: unknown) {
		throw new DatabaseError('Failed to find spatiotemporal hotspot cluster', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { id, options },
		});
	}
}
