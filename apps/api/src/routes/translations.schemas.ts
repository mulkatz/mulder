import { z } from 'zod';

export const TranslationStatusSchema = z.enum(['current', 'stale']);
export const TranslationPipelinePathSchema = z.enum(['full', 'translation_only']);
export const TranslationOutputFormatSchema = z.enum(['markdown', 'html']);
export const TranslationParamsSchema = z.object({
	id: z.string().uuid(),
});
export const TranslationIdParamsSchema = z.object({
	translationId: z.string().uuid(),
});

export const TranslationListQuerySchema = z.object({
	target_language: z.string().trim().min(2).max(16).optional(),
	status: TranslationStatusSchema.optional(),
	limit: z.coerce.number().int().min(1).max(100).optional().default(20),
	offset: z.coerce.number().int().min(0).optional().default(0),
});

export const CreateTranslationRequestSchema = z.object({
	target_language: z.string().trim().min(2).max(16),
	source_language: z.string().trim().min(2).max(16).optional(),
	pipeline_path: TranslationPipelinePathSchema.optional().default('translation_only'),
	output_format: TranslationOutputFormatSchema.optional(),
	refresh: z.boolean().optional().default(false),
});

export const TranslationSchema = z.object({
	id: z.string().uuid(),
	source_document_id: z.string().uuid(),
	source_language: z.string(),
	target_language: z.string(),
	translation_engine: z.string(),
	translation_date: z.string(),
	content: z.string(),
	content_hash: z.string(),
	status: TranslationStatusSchema,
	pipeline_path: TranslationPipelinePathSchema,
	output_format: TranslationOutputFormatSchema,
	sensitivity_level: z.enum(['public', 'internal', 'restricted', 'confidential']),
	created_at: z.string(),
	updated_at: z.string(),
});

export const TranslationListResponseSchema = z.object({
	data: z.array(TranslationSchema),
	meta: z.object({
		count: z.number().int().nonnegative(),
		limit: z.number().int().positive(),
		offset: z.number().int().nonnegative(),
	}),
});

export const TranslationDetailResponseSchema = z.object({
	data: TranslationSchema,
});

export const TranslationAcceptedResponseSchema = z.object({
	data: z.object({
		job_id: z.string().uuid(),
		status: z.literal('pending'),
	}),
	links: z.object({
		status: z.string().regex(/^\/api\/jobs\/[0-9a-f-]+$/i),
	}),
});

export type TranslationListQuery = z.infer<typeof TranslationListQuerySchema>;
export type CreateTranslationRequest = z.infer<typeof CreateTranslationRequestSchema>;
export type TranslationResponse = z.infer<typeof TranslationSchema>;
export type TranslationListResponse = z.infer<typeof TranslationListResponseSchema>;
export type TranslationDetailResponse = z.infer<typeof TranslationDetailResponseSchema>;
export type TranslationAcceptedResponse = z.infer<typeof TranslationAcceptedResponseSchema>;
