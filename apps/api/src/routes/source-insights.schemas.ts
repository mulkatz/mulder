import { z } from 'zod';

export const SourceInsightDocumentParamsSchema = z.object({
	id: z.string().uuid(),
});

export const SourceCredibilityListQuerySchema = z.object({
	source_type: z
		.enum(['government', 'academic', 'journalist', 'witness', 'organization', 'anonymous', 'other'])
		.optional(),
	review_status: z.enum(['draft', 'reviewed', 'contested']).optional(),
	limit: z.coerce.number().int().min(1).max(100).optional().default(50),
	offset: z.coerce.number().int().min(0).optional().default(0),
});

export const DocumentQualityAssessmentSchema = z.object({
	id: z.string().uuid(),
	source_id: z.string().uuid(),
	assessed_at: z.string(),
	assessment_method: z.enum(['automated', 'human']),
	overall_quality: z.enum(['high', 'medium', 'low', 'unusable']),
	processable: z.boolean(),
	recommended_path: z.enum([
		'standard',
		'enhanced_ocr',
		'visual_extraction',
		'handwriting_recognition',
		'manual_transcription_required',
		'skip',
	]),
	dimensions: z.record(z.string(), z.unknown()),
	signals: z.record(z.string(), z.unknown()),
	created_at: z.string(),
});

export const DocumentQualityResponseSchema = z.object({
	data: z.object({
		latest: DocumentQualityAssessmentSchema.nullable(),
		assessments: z.array(DocumentQualityAssessmentSchema),
	}),
});

export const CredibilityProfileSchema = z.object({
	profile_id: z.string().uuid(),
	source_id: z.string().uuid(),
	source_name: z.string(),
	source_type: z.enum(['government', 'academic', 'journalist', 'witness', 'organization', 'anonymous', 'other']),
	profile_author: z.enum(['llm_auto', 'human', 'hybrid']),
	last_reviewed: z.string().nullable(),
	review_status: z.enum(['draft', 'reviewed', 'contested']),
	provenance: z.record(z.string(), z.unknown()),
	sensitivity_level: z.enum(['public', 'internal', 'restricted', 'confidential']),
	sensitivity_metadata: z.record(z.string(), z.unknown()),
	dimensions: z.array(
		z.object({
			id: z.string().uuid(),
			profile_id: z.string().uuid(),
			dimension_id: z.string(),
			label: z.string(),
			score: z.number(),
			rationale: z.string(),
			evidence_refs: z.array(z.string()),
			known_factors: z.array(z.string()),
			created_at: z.string(),
			updated_at: z.string(),
		}),
	),
	created_at: z.string(),
	updated_at: z.string(),
});

export const DocumentCredibilityResponseSchema = z.object({
	data: CredibilityProfileSchema.nullable(),
});

export const SourceCredibilityListResponseSchema = z.object({
	data: z.array(CredibilityProfileSchema),
	meta: z.object({
		count: z.number().int().nonnegative(),
		limit: z.number().int().positive(),
		offset: z.number().int().nonnegative(),
	}),
});

export type SourceCredibilityListQuery = z.infer<typeof SourceCredibilityListQuerySchema>;
export type DocumentQualityResponse = z.infer<typeof DocumentQualityResponseSchema>;
export type DocumentCredibilityResponse = z.infer<typeof DocumentCredibilityResponseSchema>;
export type SourceCredibilityListResponse = z.infer<typeof SourceCredibilityListResponseSchema>;
