import { z } from 'zod';
import { EntitySchema } from './entities.schemas.js';
import { JobStatusSchema, PipelineRunSourceStatusSchema, PipelineRunStatusSchema } from './jobs.schemas.js';

export const SOURCE_STATUS_VALUES = [
	'ingested',
	'extracted',
	'segmented',
	'enriched',
	'embedded',
	'graphed',
	'analyzed',
] as const;
export const DOCUMENT_ARTIFACT_KIND_VALUES = ['pdf', 'layout', 'page_image'] as const;

export const SourceStatusSchema = z.enum(SOURCE_STATUS_VALUES);
export const DocumentArtifactKindSchema = z.enum(DOCUMENT_ARTIFACT_KIND_VALUES);

export const DocumentListQuerySchema = z.object({
	status: SourceStatusSchema.optional(),
	search: z.string().trim().min(1).max(256).optional(),
	limit: z.coerce.number().int().min(1).max(100).optional().default(20),
	offset: z.coerce.number().int().min(0).optional().default(0),
});

export const DocumentLinksSchema = z.object({
	pdf: z.string().min(1),
	layout: z.string().min(1),
	pages: z.string().min(1),
});

export const DocumentListItemSchema = z.object({
	id: z.string().uuid(),
	filename: z.string().min(1),
	status: SourceStatusSchema,
	page_count: z.number().int().nullable(),
	has_native_text: z.boolean(),
	layout_available: z.boolean(),
	page_image_count: z.number().int().nonnegative(),
	created_at: z.string(),
	updated_at: z.string(),
	links: DocumentLinksSchema,
});

export const DocumentListResponseSchema = z.object({
	data: z.array(DocumentListItemSchema),
	meta: z.object({
		count: z.number().int().nonnegative(),
		limit: z.number().int().positive(),
		offset: z.number().int().nonnegative(),
	}),
});

export const DocumentPageSchema = z.object({
	page_number: z.number().int().positive(),
	image_url: z.string().min(1),
});

export const DocumentPagesResponseSchema = z.object({
	data: z.object({
		source_id: z.string().uuid(),
		pages: z.array(DocumentPageSchema),
	}),
	meta: z.object({
		count: z.number().int().nonnegative(),
	}),
});

export const DocumentStorySchema = z.object({
	id: z.string().uuid(),
	source_id: z.string().uuid(),
	title: z.string().min(1),
	subtitle: z.string().nullable(),
	language: z.string().nullable(),
	category: z.string().nullable(),
	page_start: z.number().int().nullable(),
	page_end: z.number().int().nullable(),
	extraction_confidence: z.number().nullable(),
	status: z.string(),
	markdown: z.string(),
	excerpt: z.string(),
	entities: z.array(EntitySchema),
});

export const DocumentStoriesResponseSchema = z.object({
	data: z.object({
		source_id: z.string().uuid(),
		stories: z.array(DocumentStorySchema),
	}),
	meta: z.object({
		count: z.number().int().nonnegative(),
	}),
});

export const DocumentParamsSchema = z.object({
	id: z.string().uuid(),
});

export const DocumentPageParamsSchema = z.object({
	id: z.string().uuid(),
	num: z.coerce.number().int().positive(),
});

export const DOCUMENT_OBSERVABILITY_STEP_STATUS_VALUES = [
	'pending',
	'completed',
	'failed',
	'partial',
	'skipped',
] as const;
export const DocumentObservabilityStepStatusSchema = z.enum(DOCUMENT_OBSERVABILITY_STEP_STATUS_VALUES);

export const DocumentObservabilityStepSchema = z.object({
	step: z.string().min(1),
	status: DocumentObservabilityStepStatusSchema,
	completed_at: z.string().nullable(),
	error_message: z.string().nullable(),
});

export const DocumentObservabilitySourceProjectionSchema = z.object({
	status: z.string().nullable(),
	extracted_at: z.string().nullable(),
	segmented_at: z.string().nullable(),
	page_count: z.number().int().nullable(),
	story_count: z.number().int().nullable(),
	vision_fallback_count: z.number().int().nullable(),
	vision_fallback_capped: z.boolean().nullable(),
});

export const DocumentObservabilityStoryProjectionSchema = z.object({
	status: z.string().nullable(),
	enriched_at: z.string().nullable(),
	embedded_at: z.string().nullable(),
	graphed_at: z.string().nullable(),
	entities_extracted: z.number().int().nullable(),
	chunks_created: z.number().int().nullable(),
});

export const DocumentObservabilityStorySchema = z.object({
	id: z.string().uuid(),
	title: z.string().min(1),
	status: z.string(),
	page_start: z.number().int().nullable(),
	page_end: z.number().int().nullable(),
	projection: DocumentObservabilityStoryProjectionSchema.nullable(),
});

export const DocumentObservabilityJobSchema = z.object({
	job_id: z.string().uuid(),
	status: JobStatusSchema,
	attempts: z.number().int().nonnegative(),
	max_attempts: z.number().int().positive(),
	error_log: z.string().nullable(),
	created_at: z.string(),
	started_at: z.string().nullable(),
	finished_at: z.string().nullable(),
});

export const DocumentObservabilityProgressSchema = z.object({
	run_id: z.string().uuid(),
	run_status: PipelineRunStatusSchema,
	current_step: z.string().min(1),
	source_status: PipelineRunSourceStatusSchema,
	updated_at: z.string(),
	error_message: z.string().nullable(),
});

export const DocumentObservabilityTimelineSchema = z.object({
	scope: z.enum(['job', 'source', 'story']),
	event: z.string().min(1),
	status: z.string().min(1),
	occurred_at: z.string(),
	step: z.string().nullable(),
	story_id: z.string().uuid().nullable(),
	details: z.record(z.string(), z.unknown()),
});

export const DocumentObservabilityResponseSchema = z.object({
	data: z.object({
		source: z.object({
			id: z.string().uuid(),
			filename: z.string().min(1),
			status: SourceStatusSchema,
			page_count: z.number().int().nullable(),
			steps: z.array(DocumentObservabilityStepSchema),
			projection: DocumentObservabilitySourceProjectionSchema.nullable(),
		}),
		stories: z.array(DocumentObservabilityStorySchema),
		job: DocumentObservabilityJobSchema.nullable(),
		progress: DocumentObservabilityProgressSchema.nullable(),
		timeline: z.array(DocumentObservabilityTimelineSchema),
	}),
});

export const DocumentArtifactSchema = z.object({
	kind: DocumentArtifactKindSchema,
	source_id: z.string().uuid(),
	storage_path: z.string().min(1),
	content_type: z.string().min(1),
	filename: z.string().min(1).optional(),
	page_number: z.number().int().positive().optional(),
});

export type DocumentListQuery = z.infer<typeof DocumentListQuerySchema>;
export type DocumentListResponse = z.infer<typeof DocumentListResponseSchema>;
export type DocumentListItem = z.infer<typeof DocumentListItemSchema>;
export type DocumentPagesResponse = z.infer<typeof DocumentPagesResponseSchema>;
export type DocumentPageItem = z.infer<typeof DocumentPageSchema>;
export type DocumentStoriesResponse = z.infer<typeof DocumentStoriesResponseSchema>;
export type DocumentStoryResponse = z.infer<typeof DocumentStorySchema>;
export type DocumentArtifact = z.infer<typeof DocumentArtifactSchema>;
export type DocumentParams = z.infer<typeof DocumentParamsSchema>;
export type DocumentPageParams = z.infer<typeof DocumentPageParamsSchema>;
export type DocumentObservabilityResponse = z.infer<typeof DocumentObservabilityResponseSchema>;
