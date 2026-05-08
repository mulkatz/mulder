import { z } from 'zod';

export const TaxonomyStatusSchema = z.enum(['auto', 'confirmed', 'rejected']);

export const TaxonomyListQuerySchema = z.object({
	entity_type: z.string().trim().min(1).max(120).optional(),
	status: TaxonomyStatusSchema.optional(),
	limit: z.coerce.number().int().min(1).max(200).optional().default(100),
	offset: z.coerce.number().int().min(0).optional().default(0),
});

export const TaxonomyExportQuerySchema = z.object({
	entity_type: z.string().trim().min(1).max(120).optional(),
});

export const TaxonomyEntrySchema = z.object({
	id: z.string().uuid(),
	canonical_name: z.string(),
	entity_type: z.string(),
	category: z.string().nullable(),
	status: TaxonomyStatusSchema,
	aliases: z.array(z.string()),
	created_at: z.string(),
	updated_at: z.string(),
});

export const TaxonomyListResponseSchema = z.object({
	data: z.array(TaxonomyEntrySchema),
	meta: z.object({
		count: z.number().int().nonnegative(),
		limit: z.number().int().positive(),
		offset: z.number().int().nonnegative(),
	}),
});

export type TaxonomyListQuery = z.infer<typeof TaxonomyListQuerySchema>;
export type TaxonomyExportQuery = z.infer<typeof TaxonomyExportQuerySchema>;
export type TaxonomyEntryResponse = z.infer<typeof TaxonomyEntrySchema>;
export type TaxonomyListResponse = z.infer<typeof TaxonomyListResponseSchema>;
