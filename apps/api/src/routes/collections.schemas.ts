import { z } from 'zod';

export const CollectionTypeSchema = z.enum(['archive_mirror', 'thematic', 'import_batch', 'curated', 'other']);
export const CollectionVisibilitySchema = z.enum(['private', 'team', 'public']);
export const SensitivityLevelSchema = z.enum(['public', 'internal', 'restricted', 'confidential']);

export const CollectionParamsSchema = z.object({
	collectionId: z.string().uuid(),
});

export const CollectionListQuerySchema = z.object({
	type: CollectionTypeSchema.optional(),
	visibility: CollectionVisibilitySchema.optional(),
	archive_id: z.string().uuid().optional(),
	tag: z.string().trim().min(1).max(80).optional(),
	limit: z.coerce.number().int().min(1).max(100).optional().default(50),
	offset: z.coerce.number().int().min(0).optional().default(0),
});

export const CollectionDefaultsSchema = z.object({
	sensitivity_level: SensitivityLevelSchema.optional(),
	default_language: z.string().trim().min(2).max(16).optional(),
	credibility_profile_id: z.string().uuid().nullable().optional(),
});

export const CreateCollectionRequestSchema = z.object({
	name: z.string().trim().min(1).max(180),
	description: z.string().trim().max(2000).optional().default(''),
	type: CollectionTypeSchema.optional().default('other'),
	visibility: CollectionVisibilitySchema.optional().default('private'),
	tags: z.array(z.string().trim().min(1).max(80)).optional().default([]),
	defaults: CollectionDefaultsSchema.optional().default({}),
});

export const PatchCollectionRequestSchema = z.object({
	name: z.string().trim().min(1).max(180).optional(),
	description: z.string().trim().max(2000).optional(),
	visibility: CollectionVisibilitySchema.optional(),
	tags: z.array(z.string().trim().min(1).max(80)).optional(),
	defaults: CollectionDefaultsSchema.optional(),
});

export const CollectionRecordSchema = z.object({
	collection_id: z.string().uuid(),
	name: z.string(),
	description: z.string(),
	type: CollectionTypeSchema,
	archive_id: z.string().uuid().nullable(),
	created_by: z.string(),
	visibility: CollectionVisibilitySchema,
	tags: z.array(z.string()),
	defaults: z.object({
		sensitivity_level: SensitivityLevelSchema,
		default_language: z.string(),
		credibility_profile_id: z.string().uuid().nullable(),
	}),
	created_at: z.string(),
	updated_at: z.string(),
});

export const CollectionSummarySchema = CollectionRecordSchema.extend({
	document_count: z.number().int().nonnegative(),
	total_size_bytes: z.number().int().nonnegative(),
	languages: z.array(z.string()),
	date_range: z.object({
		earliest: z.string().nullable(),
		latest: z.string().nullable(),
	}),
});

export const CollectionListResponseSchema = z.object({
	data: z.array(CollectionSummarySchema),
	meta: z.object({
		count: z.number().int().nonnegative(),
		limit: z.number().int().positive(),
		offset: z.number().int().nonnegative(),
	}),
});

export const CollectionDetailResponseSchema = z.object({
	data: CollectionSummarySchema,
});

export type CollectionListQuery = z.infer<typeof CollectionListQuerySchema>;
export type CreateCollectionRequest = z.infer<typeof CreateCollectionRequestSchema>;
export type PatchCollectionRequest = z.infer<typeof PatchCollectionRequestSchema>;
export type CollectionRecordResponse = z.infer<typeof CollectionRecordSchema>;
export type CollectionSummaryResponse = z.infer<typeof CollectionSummarySchema>;
export type CollectionListResponse = z.infer<typeof CollectionListResponseSchema>;
export type CollectionDetailResponse = z.infer<typeof CollectionDetailResponseSchema>;
