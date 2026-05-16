import { z } from 'zod';

export const RuntimeConfigResponseSchema = z.object({
	data: z.object({
		translation: z.object({
			enabled: z.boolean(),
			default_target_language: z.string().min(1),
			supported_languages: z.array(z.string().min(1)).min(1),
		}),
	}),
});

export type RuntimeConfigResponse = z.infer<typeof RuntimeConfigResponseSchema>;
