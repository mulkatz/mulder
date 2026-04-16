import { z } from 'zod';

export const StatusBudgetSchema = z.object({
	month: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	limit_usd: z.number().nonnegative(),
	reserved_usd: z.number().nonnegative(),
	committed_usd: z.number().nonnegative(),
	released_usd: z.number().nonnegative(),
	remaining_usd: z.number(),
});

export const StatusJobsSchema = z.object({
	pending: z.number().int().nonnegative(),
	running: z.number().int().nonnegative(),
	completed: z.number().int().nonnegative(),
	failed: z.number().int().nonnegative(),
	dead_letter: z.number().int().nonnegative(),
});

export const StatusResponseSchema = z.object({
	data: z.object({
		budget: StatusBudgetSchema,
		jobs: StatusJobsSchema,
	}),
});

export type StatusResponse = z.infer<typeof StatusResponseSchema>;
