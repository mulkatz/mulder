import { z } from 'zod';

export const JOB_STATUS_VALUES = ['pending', 'running', 'completed', 'failed', 'dead_letter'] as const;
export const PIPELINE_RUN_STATUS_VALUES = ['running', 'completed', 'partial', 'failed'] as const;
export const PIPELINE_RUN_SOURCE_STATUS_VALUES = ['pending', 'processing', 'completed', 'failed'] as const;

export const JobStatusSchema = z.enum(JOB_STATUS_VALUES);
export const PipelineRunStatusSchema = z.enum(PIPELINE_RUN_STATUS_VALUES);
export const PipelineRunSourceStatusSchema = z.enum(PIPELINE_RUN_SOURCE_STATUS_VALUES);

export const JobListQuerySchema = z.object({
	status: JobStatusSchema.optional(),
	type: z.string().min(1).max(128).optional(),
	worker_id: z.string().min(1).max(128).optional(),
	limit: z.coerce.number().int().positive().max(100).optional().default(20),
});

export const JobSummarySchema = z.object({
	id: z.string().uuid(),
	type: z.string(),
	status: JobStatusSchema,
	attempts: z.number().int().nonnegative(),
	max_attempts: z.number().int().positive(),
	worker_id: z.string().nullable(),
	created_at: z.string(),
	started_at: z.string().nullable(),
	finished_at: z.string().nullable(),
	links: z.object({
		self: z.string().regex(/^\/api\/jobs\/[0-9a-f-]+$/i),
	}),
});

export const JobListResponseSchema = z.object({
	data: z.array(JobSummarySchema),
	meta: z.object({
		count: z.number().int().nonnegative(),
		limit: z.number().int().positive(),
	}),
});

export const JobDetailSchema = z.object({
	id: z.string().uuid(),
	type: z.string(),
	status: JobStatusSchema,
	attempts: z.number().int().nonnegative(),
	max_attempts: z.number().int().positive(),
	worker_id: z.string().nullable(),
	created_at: z.string(),
	started_at: z.string().nullable(),
	finished_at: z.string().nullable(),
	error_log: z.string().nullable(),
	payload: z.record(z.string(), z.unknown()),
});

export const JobProgressSourceSchema = z.object({
	source_id: z.string().uuid(),
	current_step: z.string(),
	status: PipelineRunSourceStatusSchema,
	error_message: z.string().nullable(),
	updated_at: z.string(),
});

export const JobProgressSchema = z.object({
	run_id: z.string().uuid(),
	run_status: PipelineRunStatusSchema,
	source_counts: z.object({
		pending: z.number().int().nonnegative(),
		processing: z.number().int().nonnegative(),
		completed: z.number().int().nonnegative(),
		failed: z.number().int().nonnegative(),
	}),
	sources: z.array(JobProgressSourceSchema),
});

export const JobDetailResponseSchema = z.object({
	data: z.object({
		job: JobDetailSchema,
		progress: JobProgressSchema.nullable(),
	}),
});

export type JobListQuery = z.infer<typeof JobListQuerySchema>;
export type JobListResponse = z.infer<typeof JobListResponseSchema>;
export type JobDetailResponse = z.infer<typeof JobDetailResponseSchema>;
