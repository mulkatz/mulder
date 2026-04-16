import { z } from 'zod';

export const UploadTransportSchema = z.enum(['gcs_resumable', 'dev_proxy']);

export const InitiateDocumentUploadRequestSchema = z.object({
	filename: z.string().trim().min(1).max(512),
	size_bytes: z.number().int().positive(),
	content_type: z.string().trim().min(1).max(128),
	tags: z.array(z.string().trim().min(1).max(64)).max(20).optional(),
});

export const UploadTargetSchema = z.object({
	url: z.string().min(1),
	method: z.literal('PUT'),
	headers: z.record(z.string(), z.string()),
	transport: UploadTransportSchema,
	expires_at: z.string().nullable(),
});

export const InitiateDocumentUploadResponseSchema = z.object({
	data: z.object({
		source_id: z.string().uuid(),
		storage_path: z.string().min(1),
		upload: UploadTargetSchema,
		limits: z.object({
			max_bytes: z.number().int().positive(),
		}),
	}),
});

export const CompleteDocumentUploadRequestSchema = z
	.object({
		source_id: z.string().uuid(),
		filename: z.string().trim().min(1).max(512),
		storage_path: z.string().min(1),
		tags: z.array(z.string().trim().min(1).max(64)).max(20).optional(),
		start_pipeline: z.boolean().optional().default(true),
	})
	.superRefine((value, ctx) => {
		const expectedPath = `raw/${value.source_id}/original.pdf`;
		if (value.storage_path !== expectedPath) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['storage_path'],
				message: `storage_path must equal ${expectedPath}`,
			});
		}
	});

export const CompleteDocumentUploadResponseSchema = z.object({
	data: z.object({
		job_id: z.string().uuid(),
		status: z.literal('pending'),
		source_id: z.string().uuid(),
	}),
	links: z.object({
		status: z.string().regex(/^\/api\/jobs\/[0-9a-f-]+$/i),
	}),
});

export const DevUploadQuerySchema = z.object({
	storage_path: z.string().min(1),
});

export type InitiateDocumentUploadRequest = z.infer<typeof InitiateDocumentUploadRequestSchema>;
export type InitiateDocumentUploadResponse = z.infer<typeof InitiateDocumentUploadResponseSchema>;
export type CompleteDocumentUploadRequest = z.infer<typeof CompleteDocumentUploadRequestSchema>;
export type CompleteDocumentUploadResponse = z.infer<typeof CompleteDocumentUploadResponseSchema>;
