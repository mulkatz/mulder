import { z } from 'zod';

export const PIPELINE_STEP_VALUES = ['extract', 'segment', 'enrich', 'embed', 'graph'] as const;

export const PipelineStepSchema = z.enum(PIPELINE_STEP_VALUES);

function stepIndex(step: string): number {
	return PIPELINE_STEP_VALUES.indexOf(step as (typeof PIPELINE_STEP_VALUES)[number]);
}

export const PipelineRunRequestSchema = z
	.object({
		source_id: z.string().uuid(),
		from: PipelineStepSchema.optional(),
		up_to: PipelineStepSchema.optional(),
		tag: z.string().min(1).max(128).optional(),
		force: z.boolean().optional().default(false),
	})
	.superRefine((value, ctx) => {
		if (value.from && value.up_to && stepIndex(value.from) > stepIndex(value.up_to)) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['from'],
				message: '`from` must not come after `up_to`',
			});
		}
	});

export const PipelineRetryRequestSchema = z.object({
	source_id: z.string().uuid(),
	step: PipelineStepSchema.optional(),
	tag: z.string().min(1).max(128).optional(),
});

export const PipelineAcceptedJobSchema = z.object({
	data: z.object({
		job_id: z.string().uuid(),
		status: z.literal('pending'),
		run_id: z.string().uuid(),
	}),
	links: z.object({
		status: z.string().regex(/^\/api\/jobs\/[0-9a-f-]+$/i),
	}),
});

export type PipelineRunRequest = z.infer<typeof PipelineRunRequestSchema>;
export type PipelineRetryRequest = z.infer<typeof PipelineRetryRequestSchema>;
export type PipelineAcceptedJob = z.infer<typeof PipelineAcceptedJobSchema>;
