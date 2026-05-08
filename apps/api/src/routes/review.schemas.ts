import { z } from 'zod';

export const ReviewQueueKeyParamsSchema = z.object({
	queueKey: z.string().trim().min(1).max(120),
});

export const ReviewArtifactParamsSchema = z.object({
	artifactId: z.string().uuid(),
});

export const ReviewStatusSchema = z.enum([
	'pending',
	'approved',
	'auto_approved',
	'corrected',
	'contested',
	'rejected',
]);
export const ReviewActionSchema = z.enum(['approve', 'correct', 'reject', 'comment', 'escalate']);
export const ReviewConfidenceSchema = z.enum(['certain', 'likely', 'uncertain']);
export const ReviewArtifactTypeSchema = z.enum([
	'assertion_classification',
	'credibility_profile',
	'taxonomy_mapping',
	'similar_case_link',
	'agent_finding',
	'conflict_node',
	'conflict_resolution',
]);

export const ReviewListQuerySchema = z.object({
	review_status: ReviewStatusSchema.optional(),
	limit: z.coerce.number().int().min(1).max(100).optional().default(50),
	offset: z.coerce.number().int().min(0).optional().default(0),
});

export const ReviewEventsQuerySchema = z.object({
	limit: z.coerce.number().int().min(1).max(100).optional().default(50),
	offset: z.coerce.number().int().min(0).optional().default(0),
});

export const ReviewActionRequestSchema = z.object({
	action: ReviewActionSchema,
	new_value: z.unknown().optional(),
	confidence: ReviewConfidenceSchema.optional().default('likely'),
	rationale: z.string().trim().min(1).max(4000).optional(),
	tags: z.array(z.string().trim().min(1).max(80)).optional().default([]),
});

export const ReviewQueueSchema = z.object({
	queue_key: z.string(),
	name: z.string(),
	artifact_types: z.array(ReviewArtifactTypeSchema),
	assignees: z.array(z.string()),
	priority_rules: z.record(z.string(), z.unknown()),
	active: z.boolean(),
	pending_count: z.number().int().nonnegative(),
	oldest_pending: z.string().nullable(),
	created_at: z.string(),
	updated_at: z.string(),
});

export const ReviewArtifactSchema = z.object({
	artifact_id: z.string().uuid(),
	artifact_type: ReviewArtifactTypeSchema,
	subject_id: z.string(),
	subject_table: z.string(),
	created_by: z.enum(['llm_auto', 'human', 'agent']),
	review_status: ReviewStatusSchema,
	current_value: z.record(z.string(), z.unknown()),
	context: z.record(z.string(), z.unknown()),
	source_id: z.string().uuid().nullable(),
	priority: z.number().int(),
	due_at: z.string().nullable(),
	created_at: z.string(),
	updated_at: z.string(),
});

export const ReviewEventSchema = z.object({
	event_id: z.string().uuid(),
	artifact_id: z.string().uuid(),
	reviewer_id: z.string(),
	action: ReviewActionSchema,
	previous_value: z.unknown().nullable(),
	new_value: z.unknown().nullable(),
	confidence: ReviewConfidenceSchema,
	rationale: z.string().nullable(),
	tags: z.array(z.string()),
	created_at: z.string(),
});

export const ReviewQueueListResponseSchema = z.object({
	data: z.array(ReviewQueueSchema),
});

export const ReviewArtifactListResponseSchema = z.object({
	data: z.array(ReviewArtifactSchema),
	meta: z.object({
		count: z.number().int().nonnegative(),
		limit: z.number().int().positive(),
		offset: z.number().int().nonnegative(),
	}),
});

export const ReviewArtifactDetailResponseSchema = z.object({
	data: ReviewArtifactSchema,
});

export const ReviewEventListResponseSchema = z.object({
	data: z.array(ReviewEventSchema),
	meta: z.object({
		count: z.number().int().nonnegative(),
		limit: z.number().int().positive(),
		offset: z.number().int().nonnegative(),
	}),
});

export const ReviewActionResponseSchema = z.object({
	data: z.object({
		artifact: ReviewArtifactSchema,
		event: ReviewEventSchema,
	}),
});

export type ReviewListQuery = z.infer<typeof ReviewListQuerySchema>;
export type ReviewEventsQuery = z.infer<typeof ReviewEventsQuerySchema>;
export type ReviewActionRequest = z.infer<typeof ReviewActionRequestSchema>;
export type ReviewQueueResponse = z.infer<typeof ReviewQueueSchema>;
export type ReviewArtifactResponse = z.infer<typeof ReviewArtifactSchema>;
export type ReviewEventResponse = z.infer<typeof ReviewEventSchema>;
export type ReviewQueueListResponse = z.infer<typeof ReviewQueueListResponseSchema>;
export type ReviewArtifactListResponse = z.infer<typeof ReviewArtifactListResponseSchema>;
export type ReviewArtifactDetailResponse = z.infer<typeof ReviewArtifactDetailResponseSchema>;
export type ReviewEventListResponse = z.infer<typeof ReviewEventListResponseSchema>;
export type ReviewActionResponse = z.infer<typeof ReviewActionResponseSchema>;
