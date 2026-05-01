import { z } from 'zod';

const SUPPORTED_UPLOAD_EXTENSIONS = new Map([
	['pdf', 'pdf'],
	['png', 'png'],
	['jpg', 'jpg'],
	['jpeg', 'jpg'],
	['tif', 'tiff'],
	['tiff', 'tiff'],
	['txt', 'txt'],
	['md', 'md'],
	['markdown', 'md'],
	['docx', 'docx'],
]);

const SUPPORTED_UPLOAD_CONTENT_TYPES = new Map([
	['application/pdf', 'pdf'],
	['image/png', 'png'],
	['image/jpeg', 'jpg'],
	['image/tiff', 'tiff'],
	['text/plain', 'txt'],
	['text/markdown', 'md'],
	['text/x-markdown', 'md'],
	['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
]);

export type UploadStorageExtension = 'pdf' | 'png' | 'jpg' | 'tiff' | 'txt' | 'md' | 'docx';

function filenameExtension(filename: string): string {
	const basename = filename.split(/[\\/]/).pop() ?? filename;
	const dotIndex = basename.lastIndexOf('.');
	return dotIndex >= 0 ? basename.slice(dotIndex + 1).toLowerCase() : '';
}

export function canonicalUploadExtensionForFilename(filename: string): UploadStorageExtension | null {
	const extension = SUPPORTED_UPLOAD_EXTENSIONS.get(filenameExtension(filename));
	return extension === 'pdf' ||
		extension === 'png' ||
		extension === 'jpg' ||
		extension === 'tiff' ||
		extension === 'txt' ||
		extension === 'md' ||
		extension === 'docx'
		? extension
		: null;
}

export function canonicalUploadExtensionForContentType(contentType: string): UploadStorageExtension | null {
	const normalized = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
	const extension = SUPPORTED_UPLOAD_CONTENT_TYPES.get(normalized);
	return extension === 'pdf' ||
		extension === 'png' ||
		extension === 'jpg' ||
		extension === 'tiff' ||
		extension === 'txt' ||
		extension === 'md' ||
		extension === 'docx'
		? extension
		: null;
}

export function isSupportedOriginalStoragePath(storagePath: string): boolean {
	return /^raw\/[^/]+\/original\.(pdf|png|jpg|tiff|txt|md|docx)$/i.test(storagePath);
}

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
		const canonicalExtension = canonicalUploadExtensionForFilename(value.filename);
		if (!canonicalExtension) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['filename'],
				message: 'filename must end with .pdf, .png, .jpg, .jpeg, .tif, .tiff, .txt, .md, .markdown, or .docx',
			});
			return;
		}

		const expectedPath = `raw/${value.source_id}/original.${canonicalExtension}`;
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
