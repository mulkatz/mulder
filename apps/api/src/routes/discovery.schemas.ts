import { z } from 'zod';

const JsonRecordSchema = z.record(z.string(), z.unknown());
const SensitivityLevelSchema = z.enum(['public', 'internal', 'restricted', 'confidential']);
const ReviewStatusSchema = z.enum(['pending', 'approved', 'auto_approved', 'corrected', 'contested', 'rejected']);
const DiscoveryPatternReviewStatusSchema = z.enum(['pending', 'approved', 'rejected', 'contested']);

export const SimilarEntityQuerySchema = z.object({
	entity_id: z.string().uuid(),
	limit: z.coerce.number().int().min(1).max(100).optional().default(20),
	offset: z.coerce.number().int().min(0).optional().default(0),
});

export const ClassificationMappingQuerySchema = z.object({
	taxonomy_id: z.string().trim().min(1).max(240).optional(),
	category_id: z.string().trim().min(1).max(240).optional(),
	source_taxonomy_id: z.string().trim().min(1).max(240).optional(),
	source_category_id: z.string().trim().min(1).max(240).optional(),
	target_taxonomy_id: z.string().trim().min(1).max(240).optional(),
	target_category_id: z.string().trim().min(1).max(240).optional(),
	mapping_type: z.enum(['equivalent', 'broader', 'narrower', 'overlapping', 'related']).optional(),
	review_status: z.enum(['draft', 'reviewed', 'contested']).optional(),
	min_confidence: z.coerce.number().min(0).max(1).optional(),
	limit: z.coerce.number().int().min(1).max(100).optional().default(50),
	offset: z.coerce.number().int().min(0).optional().default(0),
});

export const TemporalPatternQuerySchema = z.object({
	region_key: z.string().trim().min(1).max(160).optional(),
	time_start: z.string().datetime().optional(),
	time_end: z.string().datetime().optional(),
	review_status: DiscoveryPatternReviewStatusSchema.optional(),
	signal_strength: z.enum(['weak']).optional(),
	limit: z.coerce.number().int().min(1).max(100).optional().default(50),
	offset: z.coerce.number().int().min(0).optional().default(0),
});

export const ExternalCorrelationQuerySchema = z.object({
	internal_series_key: z.string().trim().min(1).max(240).optional(),
	external_source_id: z.string().trim().min(1).max(240).optional(),
	external_series_id: z.string().trim().min(1).max(240).optional(),
	method: z.enum(['spearman', 'cross_correlation']).optional(),
	time_start: z.string().datetime().optional(),
	time_end: z.string().datetime().optional(),
	review_status: DiscoveryPatternReviewStatusSchema.optional(),
	signal_strength: z.enum(['weak']).optional(),
	limit: z.coerce.number().int().min(1).max(100).optional().default(50),
	offset: z.coerce.number().int().min(0).optional().default(0),
});

const SimilarityDimensionScoreSchema = z.object({
	status: z.enum(['scored', 'insufficient_data']),
	score: z.number().nullable(),
	reason: z.string().nullable(),
});

export const SimilarEntitySchema = z.object({
	entity_id: z.string().uuid(),
	entity_title: z.string(),
	overall_rank: z.number().int().nonnegative(),
	core: z.object({
		semantic: SimilarityDimensionScoreSchema,
		structural: SimilarityDimensionScoreSchema,
		geospatial: SimilarityDimensionScoreSchema,
		temporal: SimilarityDimensionScoreSchema,
	}),
	domain: z.array(
		z.object({
			id: z.string(),
			label: z.string(),
			source: z.enum(['taxonomy_mapping', 'attribute_comparison', 'custom_scorer']),
			config_ref: z.string(),
			score: z.number().nullable(),
			status: z.enum(['scored', 'insufficient_data']),
			reason: z.string().nullable(),
			metadata: JsonRecordSchema,
		}),
	),
	explanation: z.string(),
	shared_entity_ids: z.array(z.string().uuid()),
	key_differences: z.array(z.string()),
	provenance: JsonRecordSchema,
	sensitivity_level: SensitivityLevelSchema,
	sensitivity_metadata: JsonRecordSchema,
	review_status: ReviewStatusSchema,
	auto_discovered: z.boolean(),
});

export const ClassificationMappingSchema = z.object({
	id: z.string().uuid(),
	source_taxonomy_id: z.string(),
	source_category_id: z.string(),
	target_taxonomy_id: z.string(),
	target_category_id: z.string(),
	mapping_type: z.enum(['equivalent', 'broader', 'narrower', 'overlapping', 'related']),
	confidence: z.number().min(0).max(1),
	conditions: z.string().nullable(),
	rationale: z.string(),
	mapping_author: z.enum(['llm_auto', 'human', 'hybrid']),
	review_status: z.enum(['draft', 'reviewed', 'contested']),
	provenance: JsonRecordSchema,
	sensitivity_level: SensitivityLevelSchema,
	sensitivity_metadata: JsonRecordSchema,
	created_at: z.string(),
	updated_at: z.string(),
});

const CategoryRefSchema = z.object({
	taxonomy_id: z.string().nullable(),
	category_id: z.string(),
});

export const TemporalAnomalySchema = z.object({
	id: z.string().uuid(),
	region_key: z.string(),
	region_geojson: JsonRecordSchema.nullable(),
	anomaly_type: z.enum(['frequency_spike', 'frequency_changepoint']),
	time_start: z.string(),
	time_end: z.string(),
	entity_count: z.number().int().nonnegative(),
	baseline_rate: z.number(),
	observed_rate: z.number(),
	raw_significance: z.number(),
	comparison_count: z.number().int().nonnegative(),
	corrected_significance: z.number(),
	significance_threshold: z.number(),
	peak_date: z.string(),
	dominant_category_ref: CategoryRefSchema.nullable(),
	contributing_entity_ids: z.array(z.string().uuid()),
	known_pattern_match: z.string().nullable(),
	bias_warning: z.string().nullable(),
	signal_strength: z.enum(['weak']),
	caveats: z.array(z.string()),
	review_status: DiscoveryPatternReviewStatusSchema,
	provenance: JsonRecordSchema,
	sensitivity_level: SensitivityLevelSchema,
	sensitivity_metadata: JsonRecordSchema,
	computed_at: z.string(),
});

export const SpatiotemporalHotspotSchema = z.object({
	id: z.string().uuid(),
	region_key: z.string(),
	hotspot_type: z.enum(['density_cluster']),
	centroid_lat: z.number(),
	centroid_lng: z.number(),
	radius_km: z.number(),
	time_start: z.string(),
	time_end: z.string(),
	entity_count: z.number().int().nonnegative(),
	density: z.number(),
	persistence: z.enum(['transient', 'recurring', 'permanent']),
	recurrence_pattern: z.string().nullable(),
	related_cluster_ids: z.array(z.string().uuid()),
	contributing_entity_ids: z.array(z.string().uuid()),
	dominant_category_ref: CategoryRefSchema.nullable(),
	bias_warning: z.string().nullable(),
	signal_strength: z.enum(['weak']),
	caveats: z.array(z.string()),
	review_status: DiscoveryPatternReviewStatusSchema,
	provenance: JsonRecordSchema,
	sensitivity_level: SensitivityLevelSchema,
	sensitivity_metadata: JsonRecordSchema,
	computed_at: z.string(),
});

export const ExternalCorrelationSchema = z.object({
	id: z.string().uuid(),
	internal_series_key: z.string(),
	external_source_id: z.string(),
	external_series_id: z.string(),
	method: z.enum(['spearman', 'cross_correlation']),
	coefficient: z.number(),
	p_value: z.number(),
	lag_days: z.number().int(),
	time_start: z.string(),
	time_end: z.string(),
	data_point_count: z.number().int().nonnegative(),
	contributing_entity_ids: z.array(z.string().uuid()),
	interpretation_caveat: z.string(),
	signal_strength: z.enum(['weak']),
	caveats: z.array(z.string()),
	review_status: DiscoveryPatternReviewStatusSchema,
	provenance: JsonRecordSchema,
	sensitivity_level: SensitivityLevelSchema,
	sensitivity_metadata: JsonRecordSchema,
	computed_at: z.string(),
});

const DiscoveryMetaSchema = z.object({
	count: z.number().int().nonnegative(),
	limit: z.number().int().positive(),
	offset: z.number().int().nonnegative(),
});

export const SimilarEntityListResponseSchema = z.object({
	data: z.array(SimilarEntitySchema),
	meta: DiscoveryMetaSchema,
	caveats: z.array(z.string()),
});

export const ClassificationMappingListResponseSchema = z.object({
	data: z.array(ClassificationMappingSchema),
	meta: DiscoveryMetaSchema,
	caveats: z.array(z.string()),
});

export const TemporalPatternListResponseSchema = z.object({
	data: z.object({
		anomalies: z.array(TemporalAnomalySchema),
		hotspots: z.array(SpatiotemporalHotspotSchema),
	}),
	meta: DiscoveryMetaSchema,
	caveats: z.array(z.string()),
});

export const ExternalCorrelationListResponseSchema = z.object({
	data: z.array(ExternalCorrelationSchema),
	meta: DiscoveryMetaSchema,
	caveats: z.array(z.string()),
});

export type SimilarEntityQuery = z.infer<typeof SimilarEntityQuerySchema>;
export type ClassificationMappingQuery = z.infer<typeof ClassificationMappingQuerySchema>;
export type TemporalPatternQuery = z.infer<typeof TemporalPatternQuerySchema>;
export type ExternalCorrelationQuery = z.infer<typeof ExternalCorrelationQuerySchema>;
export type SimilarEntityListResponse = z.infer<typeof SimilarEntityListResponseSchema>;
export type ClassificationMappingListResponse = z.infer<typeof ClassificationMappingListResponseSchema>;
export type TemporalPatternListResponse = z.infer<typeof TemporalPatternListResponseSchema>;
export type ExternalCorrelationListResponse = z.infer<typeof ExternalCorrelationListResponseSchema>;
