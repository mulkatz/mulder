import { z } from 'zod';
import { JobStatusSchema } from './jobs.schemas.js';

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
	['csv', 'csv'],
	['xlsx', 'xlsx'],
	['eml', 'eml'],
	['msg', 'msg'],
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
	['text/csv', 'csv'],
	['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx'],
	['message/rfc822', 'eml'],
	['application/vnd.ms-outlook', 'msg'],
]);

export type UploadStorageExtension =
	| 'pdf'
	| 'png'
	| 'jpg'
	| 'tiff'
	| 'txt'
	| 'md'
	| 'docx'
	| 'csv'
	| 'xlsx'
	| 'eml'
	| 'msg';

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
		extension === 'docx' ||
		extension === 'csv' ||
		extension === 'xlsx' ||
		extension === 'eml' ||
		extension === 'msg'
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
		extension === 'docx' ||
		extension === 'csv' ||
		extension === 'xlsx' ||
		extension === 'eml' ||
		extension === 'msg'
		? extension
		: null;
}

export function isSupportedOriginalStoragePath(storagePath: string): boolean {
	return /^raw\/[^/]+\/original\.(pdf|png|jpg|tiff|txt|md|docx|csv|xlsx|eml|msg)$/i.test(storagePath);
}

export const UploadTransportSchema = z.enum(['gcs_resumable', 'dev_proxy']);
export const UploadAcquisitionChannelSchema = z.enum([
	'archive_import',
	'manual_upload',
	'email_submission',
	'web_research',
	'api_import',
	'bulk_import',
	're_scan',
	'partner_exchange',
]);
export const UploadAuthenticityStatusSchema = z.enum(['unverified', 'verified', 'disputed']);
export const UploadOriginalSourceTypeSchema = z.enum([
	'witness_report',
	'government_document',
	'academic_paper',
	'news_article',
	'correspondence',
	'field_notes',
	'measurement_data',
	'photograph',
	'audio_recording',
	'video_recording',
	'other',
]);
export const UploadCustodyHolderTypeSchema = z.enum(['person', 'institution', 'archive', 'unknown']);
export const UploadCustodyActionSchema = z.enum([
	'received',
	'copied',
	'digitized',
	'annotated',
	'translated',
	'redacted',
	'restored',
	'transferred',
	'archived',
]);
export const UploadArchiveSourceStatusSchema = z.enum([
	'current',
	'moved',
	'deleted_from_source',
	'archive_destroyed',
	'digitized_only',
	'unknown',
]);
export const UploadPathSegmentTypeSchema = z.enum([
	'collection',
	'topic',
	'region',
	'time_period',
	'person',
	'case',
	'administrative',
	'unknown',
]);
export const UploadSensitivityLevelSchema = z.enum(['public', 'internal', 'restricted', 'confidential']);
export const UploadPiiTypeSchema = z.enum([
	'person_name',
	'contact_info',
	'medical_data',
	'location_private',
	'location_sighting',
	'financial',
	'unpublished_research',
	'legal',
]);

const OptionalDateStringSchema = z.string().trim().min(1).max(64).nullable().optional();
const OptionalTextSchema = z.string().trim().max(4000).nullable().optional();

export const UploadProvenanceSchema = z.object({
	acquisition: z
		.object({
			channel: UploadAcquisitionChannelSchema.optional().default('manual_upload'),
			submitted_at: z.string().trim().min(1).max(64).optional(),
			collection_id: z.string().uuid().nullable().optional(),
			notes: OptionalTextSchema,
			metadata: z.record(z.string(), z.unknown()).optional().default({}),
		})
		.optional(),
	authenticity: z
		.object({
			status: UploadAuthenticityStatusSchema.optional().default('unverified'),
			notes: OptionalTextSchema,
		})
		.optional(),
	original_source: z
		.object({
			source_type: UploadOriginalSourceTypeSchema,
			description: z.string().trim().min(1).max(4000).optional(),
			source_date: OptionalDateStringSchema,
			author: z.string().trim().max(512).nullable().optional(),
			language: z.string().trim().min(2).max(16).optional(),
			institution: z.string().trim().max(512).nullable().optional(),
			foia_reference: z.string().trim().max(512).nullable().optional(),
		})
		.optional(),
	custody_chain: z
		.array(
			z.object({
				step_order: z.number().int().positive(),
				holder: z.string().trim().min(1).max(512),
				holder_type: UploadCustodyHolderTypeSchema.optional().default('unknown'),
				received_from: z.string().trim().max(512).nullable().optional(),
				held_from: OptionalDateStringSchema,
				held_until: OptionalDateStringSchema,
				actions: z.array(UploadCustodyActionSchema).max(12).optional().default([]),
				location: z.string().trim().max(512).nullable().optional(),
				notes: OptionalTextSchema,
			}),
		)
		.max(50)
		.optional()
		.default([]),
	archive_location: z
		.object({
			archive_id: z.string().uuid(),
			original_path: z.string().trim().min(1).max(1000),
			original_filename: z.string().trim().min(1).max(512),
			path_segments: z
				.array(
					z.object({
						depth: z.number().int().nonnegative(),
						name: z.string().trim().min(1).max(256),
						segment_type: UploadPathSegmentTypeSchema.optional().default('unknown'),
					}),
				)
				.max(20)
				.optional()
				.default([]),
			physical_location: z
				.object({
					building: z.string().trim().max(256).nullable().optional(),
					room: z.string().trim().max(256).nullable().optional(),
					shelf: z.string().trim().max(256).nullable().optional(),
					container: z.string().trim().max(256).nullable().optional(),
					position: z.string().trim().max(256).nullable().optional(),
					notes: OptionalTextSchema,
				})
				.nullable()
				.optional(),
			source_status: UploadArchiveSourceStatusSchema.optional().default('current'),
			recorded_at: z.string().trim().min(1).max(64).optional(),
			valid_from: OptionalDateStringSchema,
			valid_until: OptionalDateStringSchema,
		})
		.optional(),
});

export const UploadExpectedSensitivitySchema = z.object({
	level: UploadSensitivityLevelSchema,
	reason: z.string().trim().min(1).max(512).optional(),
	pii_types: z.array(UploadPiiTypeSchema).max(20).optional().default([]),
	declassify_date: z.string().trim().min(1).max(64).nullable().optional(),
});

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
		provenance: UploadProvenanceSchema.optional(),
		expected_sensitivity: UploadExpectedSensitivitySchema.optional(),
		start_pipeline: z.boolean().optional().default(true),
	})
	.superRefine((value, ctx) => {
		const canonicalExtension = canonicalUploadExtensionForFilename(value.filename);
		if (!canonicalExtension) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['filename'],
				message:
					'filename must end with .pdf, .png, .jpg, .jpeg, .tif, .tiff, .txt, .md, .markdown, .docx, .csv, .xlsx, .eml, or .msg',
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

export const EnrichUploadProvenanceRequestSchema = z.object({
	source_id: z.string().uuid(),
	filename: z.string().trim().min(1).max(512),
	storage_path: z.string().min(1),
	collection_id: z.string().uuid().nullable().optional(),
	draft: z
		.object({
			provenance: UploadProvenanceSchema.optional(),
			expected_sensitivity: UploadExpectedSensitivitySchema.optional(),
		})
		.optional(),
});

export const EnrichUploadProvenanceResponseSchema = z.object({
	data: z.object({
		suggestion_id: z.string().uuid(),
		source_id: z.string().uuid(),
		suggested: z.object({
			provenance: UploadProvenanceSchema.optional(),
			expected_sensitivity: UploadExpectedSensitivitySchema.optional(),
		}),
		field_confidence: z.record(z.string(), z.number().min(0).max(1)),
		warnings: z.array(z.string()),
		requires_user_review: z.literal(true),
	}),
});

export const CompleteDocumentUploadResponseSchema = z.object({
	data: z.object({
		job_id: z.string().uuid(),
		status: z.literal('pending'),
		source_id: z.string().uuid(),
	}),
	links: z.object({
		status: z.string().regex(/^\/api\/jobs\/[0-9a-f-]+$/i),
		upload_status: z.string().regex(/^\/api\/uploads\/documents\/finalizations\/[0-9a-f-]+$/i),
	}),
});

export const DevUploadQuerySchema = z.object({
	storage_path: z.string().min(1),
});

export const UploadFinalizationParamsSchema = z.object({
	jobId: z.string().uuid(),
});

export const UploadFinalizationResultStatusSchema = z.enum([
	'pending',
	'created',
	'duplicate',
	'completed_unavailable',
	'failed',
	'dead_letter',
]);

export const UploadFinalizationStatusResponseSchema = z.object({
	data: z.object({
		job_id: z.string().uuid(),
		requested_source_id: z.string().uuid(),
		job_status: JobStatusSchema,
		result_status: UploadFinalizationResultStatusSchema,
		source: z
			.object({
				id: z.string().uuid(),
				filename: z.string(),
				status: z.string(),
				links: z.object({
					document: z.string().regex(/^\/api\/documents\/[0-9a-f-]+$/i),
				}),
			})
			.nullable(),
		pipeline: z
			.object({
				job_id: z.string().uuid().nullable(),
				run_id: z.string().uuid().nullable(),
				links: z.object({
					job: z
						.string()
						.regex(/^\/api\/jobs\/[0-9a-f-]+$/i)
						.nullable(),
				}),
			})
			.nullable(),
		created_at: z.string(),
		started_at: z.string().nullable(),
		finished_at: z.string().nullable(),
	}),
	links: z
		.object({
			job: z.string().regex(/^\/api\/jobs\/[0-9a-f-]+$/i),
			source: z
				.string()
				.regex(/^\/api\/documents\/[0-9a-f-]+$/i)
				.optional(),
		})
		.strict(),
});

export type InitiateDocumentUploadRequest = z.infer<typeof InitiateDocumentUploadRequestSchema>;
export type InitiateDocumentUploadResponse = z.infer<typeof InitiateDocumentUploadResponseSchema>;
export type EnrichUploadProvenanceRequest = z.infer<typeof EnrichUploadProvenanceRequestSchema>;
export type EnrichUploadProvenanceResponse = z.infer<typeof EnrichUploadProvenanceResponseSchema>;
export type CompleteDocumentUploadRequest = z.infer<typeof CompleteDocumentUploadRequestSchema>;
export type CompleteDocumentUploadResponse = z.infer<typeof CompleteDocumentUploadResponseSchema>;
export type UploadFinalizationStatusResponse = z.infer<typeof UploadFinalizationStatusResponseSchema>;
