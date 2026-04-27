import { z } from 'zod';

export const ENTITY_TAXONOMY_STATUS_VALUES = ['auto', 'curated', 'merged'] as const;
export const ENTITY_EDGE_TYPE_VALUES = [
	'RELATIONSHIP',
	'DUPLICATE_OF',
	'POTENTIAL_CONTRADICTION',
	'CONFIRMED_CONTRADICTION',
	'DISMISSED_CONTRADICTION',
] as const;
export const STORY_STATUS_VALUES = ['segmented', 'enriched', 'embedded', 'graphed', 'analyzed'] as const;

export const EntityTaxonomyStatusSchema = z.enum(ENTITY_TAXONOMY_STATUS_VALUES);
export const EntityEdgeTypeSchema = z.enum(ENTITY_EDGE_TYPE_VALUES);
export const StoryStatusSchema = z.enum(STORY_STATUS_VALUES);
export const EntityCorroborationStatusSchema = z.enum(['scored', 'not_scored', 'insufficient_data']);

export const EntityListQuerySchema = z.object({
	type: z.string().trim().min(1).max(128).optional(),
	search: z.string().trim().min(1).max(256).optional(),
	taxonomy_status: EntityTaxonomyStatusSchema.optional(),
	limit: z.coerce.number().int().min(1).max(100).optional().default(20),
	offset: z.coerce.number().int().min(0).optional().default(0),
});

export const EntitySchema = z.object({
	id: z.string().uuid(),
	canonical_id: z.string().uuid().nullable(),
	name: z.string(),
	type: z.string(),
	taxonomy_status: EntityTaxonomyStatusSchema,
	taxonomy_id: z.string().uuid().nullable(),
	corroboration_score: z.number().nullable(),
	corroboration_status: EntityCorroborationStatusSchema,
	source_count: z.number().int().nonnegative(),
	attributes: z.record(z.string(), z.unknown()),
	created_at: z.string(),
	updated_at: z.string(),
});

export const EntityAliasSchema = z.object({
	id: z.string().uuid(),
	entity_id: z.string().uuid(),
	alias: z.string(),
	source: z.string().nullable(),
});

export const EntityStorySchema = z.object({
	id: z.string().uuid(),
	source_id: z.string().uuid(),
	title: z.string(),
	status: StoryStatusSchema,
	confidence: z.number().nullable(),
	mention_count: z.number().int().nonnegative(),
});

export const EntityEdgeSchema = z.object({
	id: z.string().uuid(),
	source_entity_id: z.string().uuid(),
	target_entity_id: z.string().uuid(),
	relationship: z.string(),
	edge_type: EntityEdgeTypeSchema,
	confidence: z.number().nullable(),
	story_id: z.string().uuid().nullable(),
	attributes: z.record(z.string(), z.unknown()),
});

export const EntityListResponseSchema = z.object({
	data: z.array(EntitySchema),
	meta: z.object({
		count: z.number().int().nonnegative(),
		limit: z.number().int().positive(),
		offset: z.number().int().nonnegative(),
	}),
});

export const EntityDetailResponseSchema = z.object({
	data: z.object({
		entity: EntitySchema,
		aliases: z.array(EntityAliasSchema),
		stories: z.array(EntityStorySchema),
		merged_entities: z.array(EntitySchema),
	}),
});

export const EntityEdgesResponseSchema = z.object({
	data: z.array(EntityEdgeSchema),
});

export const EntityMergeRequestSchema = z.object({
	target_id: z.string().uuid(),
	source_id: z.string().uuid(),
});

export const EntityMergeResponseSchema = z.object({
	data: z.object({
		target: z.object({
			id: z.string().uuid(),
		}),
		merged: z.object({
			id: z.string().uuid(),
			canonical_id: z.string().uuid(),
		}),
		edges_reassigned: z.number().int().nonnegative(),
		stories_reassigned: z.number().int().nonnegative(),
		aliases_copied: z.number().int().nonnegative(),
	}),
});

export type EntityListQuery = z.infer<typeof EntityListQuerySchema>;
export type EntityListResponse = z.infer<typeof EntityListResponseSchema>;
export type EntityDetailResponse = z.infer<typeof EntityDetailResponseSchema>;
export type EntityEdgesResponse = z.infer<typeof EntityEdgesResponseSchema>;
export type EntityMergeRequest = z.infer<typeof EntityMergeRequestSchema>;
export type EntityMergeResponse = z.infer<typeof EntityMergeResponseSchema>;
export type EntityResponse = z.infer<typeof EntitySchema>;
export type EntityAliasResponse = z.infer<typeof EntityAliasSchema>;
export type EntityStoryResponse = z.infer<typeof EntityStorySchema>;
export type EntityEdgeResponse = z.infer<typeof EntityEdgeSchema>;
