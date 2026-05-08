import {
	type ArtifactProvenance,
	countExternalCorrelations,
	countSimilarEntities,
	countSpatiotemporalHotspotClusters,
	countTaxonomyMappings,
	countTemporalAnomalyClusters,
	type ExternalCorrelation,
	findEntityById,
	listExternalCorrelations,
	listSimilarEntities,
	listSpatiotemporalHotspotClusters,
	listTaxonomyMappings,
	listTemporalAnomalyClusters,
	MulderError,
	type SimilarityResult,
	type SpatiotemporalHotspotCluster,
	type TaxonomyMapping,
	type TemporalAnomalyCluster,
} from '@mulder/core';
import type { AuthPrincipal } from '../middleware/auth.js';
import type {
	ClassificationMappingListResponse,
	ClassificationMappingQuery,
	ExternalCorrelationListResponse,
	ExternalCorrelationQuery,
	SimilarEntityListResponse,
	SimilarEntityQuery,
	TemporalPatternListResponse,
	TemporalPatternQuery,
} from '../routes/discovery.schemas.js';
import { resolveApiDataContext, resolveReadMaxSensitivity } from './api-runtime.js';

interface DiscoveryRouteOptions {
	authPrincipal?: AuthPrincipal;
}

const DISCOVERY_CAVEATS = [
	'Discovery results are research leads, not final proof.',
	'Review supporting sources and provenance before drawing conclusions.',
];
const TEMPORAL_CAVEATS = [
	...DISCOVERY_CAVEATS,
	'Temporal and spatial patterns can reflect reporting bias or missing data.',
];
const CORRELATION_CAVEATS = [...DISCOVERY_CAVEATS, 'Correlation does not establish causation.'];

function provenanceToRecord(provenance: ArtifactProvenance): Record<string, unknown> {
	return {
		source_document_ids: provenance.sourceDocumentIds,
		extraction_pipeline_run: provenance.extractionPipelineRun,
		created_at: provenance.createdAt.toISOString(),
	};
}

function categoryRefToResponse(ref: { taxonomyId?: string; categoryId: string } | null) {
	return ref ? { taxonomy_id: ref.taxonomyId ?? null, category_id: ref.categoryId } : null;
}

function dateQuery(value: string | undefined): Date | undefined {
	return value ? new Date(value) : undefined;
}

function similarityToResponse(result: SimilarityResult) {
	return {
		entity_id: result.entityId,
		entity_title: result.entityTitle,
		overall_rank: result.overallRank,
		core: result.core,
		domain: result.domain.map((dimension) => ({
			id: dimension.id,
			label: dimension.label,
			source: dimension.source,
			config_ref: dimension.configRef,
			score: dimension.score,
			status: dimension.status,
			reason: dimension.reason,
			metadata: dimension.metadata,
		})),
		explanation: result.explanation,
		shared_entity_ids: result.sharedEntityIds,
		key_differences: result.keyDifferences,
		provenance: provenanceToRecord(result.provenance),
		sensitivity_level: result.sensitivityLevel,
		sensitivity_metadata: result.sensitivityMetadata as unknown as Record<string, unknown>,
		review_status: result.reviewStatus,
		auto_discovered: result.autoDiscovered,
	};
}

function taxonomyMappingToResponse(mapping: TaxonomyMapping) {
	return {
		id: mapping.id,
		source_taxonomy_id: mapping.sourceTaxonomyId,
		source_category_id: mapping.sourceCategoryId,
		target_taxonomy_id: mapping.targetTaxonomyId,
		target_category_id: mapping.targetCategoryId,
		mapping_type: mapping.mappingType,
		confidence: mapping.confidence,
		conditions: mapping.conditions,
		rationale: mapping.rationale,
		mapping_author: mapping.mappingAuthor,
		review_status: mapping.reviewStatus,
		provenance: provenanceToRecord(mapping.provenance),
		sensitivity_level: mapping.sensitivityLevel,
		sensitivity_metadata: mapping.sensitivityMetadata as unknown as Record<string, unknown>,
		created_at: mapping.createdAt.toISOString(),
		updated_at: mapping.updatedAt.toISOString(),
	};
}

function anomalyToResponse(cluster: TemporalAnomalyCluster) {
	return {
		id: cluster.id,
		region_key: cluster.regionKey,
		region_geojson: cluster.regionGeojson,
		anomaly_type: cluster.anomalyType,
		time_start: cluster.timeStart.toISOString(),
		time_end: cluster.timeEnd.toISOString(),
		entity_count: cluster.entityCount,
		baseline_rate: cluster.baselineRate,
		observed_rate: cluster.observedRate,
		raw_significance: cluster.rawSignificance,
		comparison_count: cluster.comparisonCount,
		corrected_significance: cluster.correctedSignificance,
		significance_threshold: cluster.significanceThreshold,
		peak_date: cluster.peakDate.toISOString(),
		dominant_category_ref: categoryRefToResponse(cluster.dominantCategoryRef),
		contributing_entity_ids: cluster.contributingEntityIds,
		known_pattern_match: cluster.knownPatternMatch,
		bias_warning: cluster.biasWarning,
		signal_strength: cluster.signalStrength,
		caveats: cluster.caveats,
		review_status: cluster.reviewStatus,
		provenance: provenanceToRecord(cluster.provenance),
		sensitivity_level: cluster.sensitivityLevel,
		sensitivity_metadata: cluster.sensitivityMetadata as unknown as Record<string, unknown>,
		computed_at: cluster.computedAt.toISOString(),
	};
}

function hotspotToResponse(cluster: SpatiotemporalHotspotCluster) {
	return {
		id: cluster.id,
		region_key: cluster.regionKey,
		hotspot_type: cluster.hotspotType,
		centroid_lat: cluster.centroidLat,
		centroid_lng: cluster.centroidLng,
		radius_km: cluster.radiusKm,
		time_start: cluster.timeStart.toISOString(),
		time_end: cluster.timeEnd.toISOString(),
		entity_count: cluster.entityCount,
		density: cluster.density,
		persistence: cluster.persistence,
		recurrence_pattern: cluster.recurrencePattern,
		related_cluster_ids: cluster.relatedClusterIds,
		contributing_entity_ids: cluster.contributingEntityIds,
		dominant_category_ref: categoryRefToResponse(cluster.dominantCategoryRef),
		bias_warning: cluster.biasWarning,
		signal_strength: cluster.signalStrength,
		caveats: cluster.caveats,
		review_status: cluster.reviewStatus,
		provenance: provenanceToRecord(cluster.provenance),
		sensitivity_level: cluster.sensitivityLevel,
		sensitivity_metadata: cluster.sensitivityMetadata as unknown as Record<string, unknown>,
		computed_at: cluster.computedAt.toISOString(),
	};
}

function externalCorrelationToResponse(correlation: ExternalCorrelation) {
	return {
		id: correlation.id,
		internal_series_key: correlation.internalSeriesKey,
		external_source_id: correlation.externalSourceId,
		external_series_id: correlation.externalSeriesId,
		method: correlation.method,
		coefficient: correlation.coefficient,
		p_value: correlation.pValue,
		lag_days: correlation.lagDays,
		time_start: correlation.timeStart.toISOString(),
		time_end: correlation.timeEnd.toISOString(),
		data_point_count: correlation.dataPointCount,
		contributing_entity_ids: correlation.contributingEntityIds,
		interpretation_caveat: correlation.interpretationCaveat,
		signal_strength: correlation.signalStrength,
		caveats: correlation.caveats,
		review_status: correlation.reviewStatus,
		provenance: provenanceToRecord(correlation.provenance),
		sensitivity_level: correlation.sensitivityLevel,
		sensitivity_metadata: correlation.sensitivityMetadata as unknown as Record<string, unknown>,
		computed_at: correlation.computedAt.toISOString(),
	};
}

export async function listSimilarEntityLeads(
	query: SimilarEntityQuery,
	options?: DiscoveryRouteOptions,
): Promise<SimilarEntityListResponse> {
	const { config, pool } = resolveApiDataContext('discovery');
	const maxSensitivityLevel = resolveReadMaxSensitivity(config, options?.authPrincipal, 'discovery similarity');
	const entity = await findEntityById(pool, query.entity_id, { maxSensitivityLevel });
	if (!entity) {
		throw new MulderError(`Entity not found: ${query.entity_id}`, 'ENTITY_NOT_FOUND', {
			context: { entity_id: query.entity_id },
		});
	}
	const filters = {
		entityId: query.entity_id,
		maxSensitivityLevel,
	};
	const [count, results] = await Promise.all([
		countSimilarEntities(pool, filters),
		listSimilarEntities(pool, {
			...filters,
			limit: query.limit,
			offset: query.offset,
		}),
	]);
	return {
		data: results.map(similarityToResponse),
		meta: {
			count,
			limit: query.limit,
			offset: query.offset,
		},
		caveats: DISCOVERY_CAVEATS,
	};
}

export async function listClassificationMappingLeads(
	query: ClassificationMappingQuery,
	options?: DiscoveryRouteOptions,
): Promise<ClassificationMappingListResponse> {
	const { config, pool } = resolveApiDataContext('discovery');
	const maxSensitivityLevel = resolveReadMaxSensitivity(config, options?.authPrincipal, 'classification mappings');
	const filters = {
		taxonomyId: query.taxonomy_id,
		categoryId: query.category_id,
		sourceTaxonomyId: query.source_taxonomy_id,
		sourceCategoryId: query.source_category_id,
		targetTaxonomyId: query.target_taxonomy_id,
		targetCategoryId: query.target_category_id,
		mappingType: query.mapping_type,
		reviewStatus: query.review_status,
		minConfidence: query.min_confidence,
		maxSensitivityLevel,
	};
	const [count, mappings] = await Promise.all([
		countTaxonomyMappings(pool, filters),
		listTaxonomyMappings(pool, {
			...filters,
			limit: query.limit,
			offset: query.offset,
		}),
	]);
	return {
		data: mappings.map(taxonomyMappingToResponse),
		meta: {
			count,
			limit: query.limit,
			offset: query.offset,
		},
		caveats: DISCOVERY_CAVEATS,
	};
}

export async function listTemporalPatternLeads(
	query: TemporalPatternQuery,
	options?: DiscoveryRouteOptions,
): Promise<TemporalPatternListResponse> {
	const { config, pool } = resolveApiDataContext('discovery');
	const maxSensitivityLevel = resolveReadMaxSensitivity(config, options?.authPrincipal, 'temporal patterns');
	const common = {
		regionKey: query.region_key,
		timeStart: dateQuery(query.time_start),
		timeEnd: dateQuery(query.time_end),
		reviewStatus: query.review_status,
		signalStrength: query.signal_strength,
		maxSensitivityLevel,
	};
	const [anomalyCount, hotspotCount, anomalies, hotspots] = await Promise.all([
		countTemporalAnomalyClusters(pool, common),
		countSpatiotemporalHotspotClusters(pool, common),
		listTemporalAnomalyClusters(pool, { ...common, limit: query.limit, offset: query.offset }),
		listSpatiotemporalHotspotClusters(pool, { ...common, limit: query.limit, offset: query.offset }),
	]);
	return {
		data: {
			anomalies: anomalies.map(anomalyToResponse),
			hotspots: hotspots.map(hotspotToResponse),
		},
		meta: {
			count: anomalyCount + hotspotCount,
			limit: query.limit,
			offset: query.offset,
		},
		caveats: TEMPORAL_CAVEATS,
	};
}

export async function listExternalCorrelationLeads(
	query: ExternalCorrelationQuery,
	options?: DiscoveryRouteOptions,
): Promise<ExternalCorrelationListResponse> {
	const { config, pool } = resolveApiDataContext('discovery');
	const maxSensitivityLevel = resolveReadMaxSensitivity(config, options?.authPrincipal, 'external correlations');
	const filters = {
		internalSeriesKey: query.internal_series_key,
		externalSourceId: query.external_source_id,
		externalSeriesId: query.external_series_id,
		method: query.method,
		timeStart: dateQuery(query.time_start),
		timeEnd: dateQuery(query.time_end),
		reviewStatus: query.review_status,
		signalStrength: query.signal_strength,
		maxSensitivityLevel,
	};
	const [count, correlations] = await Promise.all([
		countExternalCorrelations(pool, filters),
		listExternalCorrelations(pool, {
			...filters,
			limit: query.limit,
			offset: query.offset,
		}),
	]);
	return {
		data: correlations.map(externalCorrelationToResponse),
		meta: {
			count,
			limit: query.limit,
			offset: query.offset,
		},
		caveats: CORRELATION_CAVEATS,
	};
}
