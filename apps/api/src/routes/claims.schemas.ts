import { z } from 'zod';

export const ClaimParamsSchema = z.object({
	claimId: z.string().uuid(),
});

export const ClaimDocumentParamsSchema = z.object({
	id: z.string().uuid(),
});

export const ClaimStoryParamsSchema = z.object({
	storyId: z.string().uuid(),
});

export const AssertionTypeSchema = z.enum(['observation', 'interpretation', 'hypothesis']);
export const ClassificationProvenanceSchema = z.enum(['llm_auto', 'human_reviewed', 'author_explicit']);

export const ClaimListQuerySchema = z.object({
	source_id: z.string().uuid().optional(),
	story_id: z.string().uuid().optional(),
	assertion_type: AssertionTypeSchema.optional(),
	limit: z.coerce.number().int().min(1).max(100).optional().default(50),
	offset: z.coerce.number().int().min(0).optional().default(0),
});

export const ClaimSchema = z.object({
	id: z.string().uuid(),
	source_id: z.string().uuid(),
	story_id: z.string().uuid(),
	assertion_type: AssertionTypeSchema,
	content: z.string(),
	confidence_metadata: z.object({
		witness_count: z.number().nullable(),
		measurement_based: z.boolean(),
		contemporaneous: z.boolean(),
		corroborated: z.boolean(),
		peer_reviewed: z.boolean(),
		author_is_interpreter: z.boolean(),
	}),
	classification_provenance: ClassificationProvenanceSchema,
	extracted_entity_ids: z.array(z.string().uuid()),
	provenance: z.record(z.string(), z.unknown()),
	quality_metadata: z.record(z.string(), z.unknown()).nullable(),
	sensitivity_level: z.enum(['public', 'internal', 'restricted', 'confidential']),
	sensitivity_metadata: z.record(z.string(), z.unknown()),
	created_at: z.string(),
	updated_at: z.string(),
});

export const ClaimListResponseSchema = z.object({
	data: z.array(ClaimSchema),
	meta: z.object({
		count: z.number().int().nonnegative(),
		limit: z.number().int().positive(),
		offset: z.number().int().nonnegative(),
	}),
});

export const ClaimDetailResponseSchema = z.object({
	data: ClaimSchema,
});

export type ClaimListQuery = z.infer<typeof ClaimListQuerySchema>;
export type ClaimResponse = z.infer<typeof ClaimSchema>;
export type ClaimListResponse = z.infer<typeof ClaimListResponseSchema>;
export type ClaimDetailResponse = z.infer<typeof ClaimDetailResponseSchema>;
