import { z } from 'zod';

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

export const DocumentParamsSchema = z.object({
	id: z.string().uuid(),
});

export const DocumentPageParamsSchema = z.object({
	id: z.string().uuid(),
	num: z.coerce.number().int().positive(),
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
export type DocumentArtifact = z.infer<typeof DocumentArtifactSchema>;
export type DocumentParams = z.infer<typeof DocumentParamsSchema>;
export type DocumentPageParams = z.infer<typeof DocumentPageParamsSchema>;
