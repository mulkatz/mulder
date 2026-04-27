import { z } from 'zod';

export const EVIDENCE_CONTRADICTION_STATUS_VALUES = ['potential', 'confirmed', 'dismissed', 'all'] as const;
export const EVIDENCE_CLUSTER_TYPE_VALUES = ['temporal', 'spatial', 'spatio-temporal'] as const;
export const EVIDENCE_DATA_RELIABILITY_VALUES = ['insufficient', 'low', 'moderate', 'high'] as const;
export const EVIDENCE_CORROBORATION_STATUS_VALUES = ['scored', 'not_scored', 'insufficient_data'] as const;

export const EvidenceContradictionStatusSchema = z.enum(EVIDENCE_CONTRADICTION_STATUS_VALUES);
export const EvidenceClusterTypeSchema = z.enum(EVIDENCE_CLUSTER_TYPE_VALUES);
export const EvidenceDataReliabilitySchema = z.enum(EVIDENCE_DATA_RELIABILITY_VALUES);
export const EvidenceCorroborationStatusSchema = z.enum(EVIDENCE_CORROBORATION_STATUS_VALUES);

export const EvidenceContradictionsQuerySchema = z.object({
	status: EvidenceContradictionStatusSchema.optional().default('all'),
	limit: z.coerce.number().int().min(1).max(100).optional().default(20),
	offset: z.coerce.number().int().min(0).optional().default(0),
});

export const EvidenceReliabilitySourcesQuerySchema = z.object({
	scored_only: z
		.preprocess((value) => {
			if (value === undefined) {
				return undefined;
			}
			if (value === 'true') {
				return true;
			}
			if (value === 'false') {
				return false;
			}
			return value;
		}, z.boolean().optional())
		.default(false),
	limit: z.coerce.number().int().min(1).max(100).optional().default(20),
	offset: z.coerce.number().int().min(0).optional().default(0),
});

export const EvidenceChainsQuerySchema = z.object({
	thesis: z.string().trim().min(1).max(1024).optional(),
});

export const EvidenceClustersQuerySchema = z.object({
	cluster_type: EvidenceClusterTypeSchema.optional(),
});

export const EvidenceContradictionAnalysisSchema = z.object({
	verdict: z.enum(['confirmed', 'dismissed']),
	winning_claim: z.enum(['A', 'B', 'neither']),
	confidence: z.number().min(0).max(1),
	explanation: z.string(),
});

export const EvidenceContradictionAttributesSchema = z.object({
	attribute: z.string(),
	valueA: z.string(),
	valueB: z.string(),
});

export const EvidenceContradictionSchema = z.object({
	id: z.string().uuid(),
	source_entity_id: z.string().uuid(),
	target_entity_id: z.string().uuid(),
	relationship: z.string(),
	edge_type: z.enum(['POTENTIAL_CONTRADICTION', 'CONFIRMED_CONTRADICTION', 'DISMISSED_CONTRADICTION']),
	story_id: z.string().uuid().nullable(),
	confidence: z.number().min(0).max(1).nullable(),
	attributes: EvidenceContradictionAttributesSchema,
	analysis: EvidenceContradictionAnalysisSchema.nullable(),
});

export const EvidenceContradictionsResponseSchema = z.object({
	data: z.array(EvidenceContradictionSchema),
	meta: z.object({
		count: z.number().int().nonnegative(),
		limit: z.number().int().positive(),
		offset: z.number().int().nonnegative(),
		status: EvidenceContradictionStatusSchema,
	}),
});

export const EvidenceSourceReliabilitySchema = z.object({
	id: z.string().uuid(),
	filename: z.string(),
	status: z.string(),
	reliability_score: z.number().nullable(),
	created_at: z.string(),
	updated_at: z.string(),
});

export const EvidenceReliabilitySourcesResponseSchema = z.object({
	data: z.array(EvidenceSourceReliabilitySchema),
	meta: z.object({
		count: z.number().int().nonnegative(),
		limit: z.number().int().positive(),
		offset: z.number().int().nonnegative(),
		scored_only: z.boolean(),
	}),
});

export const EvidenceChainSnapshotSchema = z.object({
	id: z.string().uuid(),
	path: z.array(z.string().uuid()),
	strength: z.number().min(0).max(1),
	supports: z.boolean(),
	computed_at: z.string(),
});

export const EvidenceChainGroupSchema = z.object({
	thesis: z.string(),
	chains: z.array(EvidenceChainSnapshotSchema),
});

export const EvidenceChainsResponseSchema = z.object({
	data: z.array(EvidenceChainGroupSchema),
	meta: z.object({
		thesis_count: z.number().int().nonnegative(),
		record_count: z.number().int().nonnegative(),
	}),
});

export const EvidenceClusterSchema = z.object({
	id: z.string().uuid(),
	cluster_type: EvidenceClusterTypeSchema,
	center_lat: z.number().nullable(),
	center_lng: z.number().nullable(),
	time_start: z.string().nullable(),
	time_end: z.string().nullable(),
	event_count: z.number().int().nonnegative(),
	event_ids: z.array(z.string().uuid()),
	computed_at: z.string(),
});

export const EvidenceClustersResponseSchema = z.object({
	data: z.array(EvidenceClusterSchema),
	meta: z.object({
		count: z.number().int().nonnegative(),
		cluster_type: EvidenceClusterTypeSchema.optional(),
	}),
});

export const EvidenceSummarySchema = z.object({
	entities: z.object({
		total: z.number().int().nonnegative(),
		scored: z.number().int().nonnegative(),
		avg_corroboration: z.number().min(0).max(1).nullable(),
		corroboration_status: EvidenceCorroborationStatusSchema,
	}),
	contradictions: z.object({
		potential: z.number().int().nonnegative(),
		confirmed: z.number().int().nonnegative(),
		dismissed: z.number().int().nonnegative(),
	}),
	duplicates: z.object({
		count: z.number().int().nonnegative(),
	}),
	sources: z.object({
		total: z.number().int().nonnegative(),
		scored: z.number().int().nonnegative(),
		data_reliability: EvidenceDataReliabilitySchema,
	}),
	evidence_chains: z.object({
		thesis_count: z.number().int().nonnegative(),
		record_count: z.number().int().nonnegative(),
	}),
	clusters: z.object({
		count: z.number().int().nonnegative(),
	}),
});

export const EvidenceSummaryResponseSchema = z.object({
	data: EvidenceSummarySchema,
});

export type EvidenceContradictionsQuery = z.infer<typeof EvidenceContradictionsQuerySchema>;
export type EvidenceReliabilitySourcesQuery = z.infer<typeof EvidenceReliabilitySourcesQuerySchema>;
export type EvidenceChainsQuery = z.infer<typeof EvidenceChainsQuerySchema>;
export type EvidenceClustersQuery = z.infer<typeof EvidenceClustersQuerySchema>;
export type EvidenceSummaryResponse = z.infer<typeof EvidenceSummaryResponseSchema>;
export type EvidenceContradictionsResponse = z.infer<typeof EvidenceContradictionsResponseSchema>;
export type EvidenceReliabilitySourcesResponse = z.infer<typeof EvidenceReliabilitySourcesResponseSchema>;
export type EvidenceChainsResponse = z.infer<typeof EvidenceChainsResponseSchema>;
export type EvidenceClustersResponse = z.infer<typeof EvidenceClustersResponseSchema>;
export type EvidenceContradictionResponse = z.infer<typeof EvidenceContradictionSchema>;
export type EvidenceSourceReliabilityResponse = z.infer<typeof EvidenceSourceReliabilitySchema>;
export type EvidenceChainGroupResponse = z.infer<typeof EvidenceChainGroupSchema>;
export type EvidenceChainSnapshotResponse = z.infer<typeof EvidenceChainSnapshotSchema>;
export type EvidenceClusterResponse = z.infer<typeof EvidenceClusterSchema>;
