/**
 * Type definitions for the ingest pipeline step.
 *
 * @see docs/specs/16_ingest_step.spec.md §4.2
 * @see docs/functional-spec.md §2.1
 */

import type {
	AcquisitionChannel,
	ArchiveInput,
	AuthenticityStatus,
	CustodyStepInput,
	OriginalSourceInput,
	PdfMetadata,
	RecordIngestProvenanceInput,
	SourceFormatMetadata,
	SourceType,
	StepError,
	SubmittedBy,
} from '@mulder/core';
import { z } from 'zod';

const acquisitionChannelSchema = z.enum([
	'archive_import',
	'manual_upload',
	'email_submission',
	'web_research',
	'api_import',
	'bulk_import',
	're_scan',
	'partner_exchange',
]);
const submittedByTypeSchema = z.enum(['human', 'system']);
const authenticityStatusSchema = z.enum(['unverified', 'verified', 'disputed']);
const originalSourceTypeSchema = z.enum([
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
const custodyHolderTypeSchema = z.enum(['person', 'institution', 'archive', 'unknown']);
const custodyActionSchema = z.enum([
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
const archiveTypeSchema = z.enum(['personal', 'institutional', 'digital', 'governmental', 'partner', 'other']);
const archiveStatusSchema = z.enum(['active', 'closed', 'destroyed', 'transferred', 'unknown']);
const archiveCompletenessSchema = z.enum(['unknown', 'partial', 'complete']);
const archiveSourceStatusSchema = z.enum([
	'current',
	'moved',
	'deleted_from_source',
	'archive_destroyed',
	'digitized_only',
	'unknown',
]);
const pathSegmentTypeSchema = z.enum([
	'collection',
	'topic',
	'region',
	'time_period',
	'person',
	'case',
	'administrative',
	'unknown',
]);
const dateInputSchema = z.union([z.string(), z.date()]);
const nullableDateInputSchema = dateInputSchema.nullable();

const submittedBySchema = z.object({
	userId: z.string().min(1).optional(),
	type: submittedByTypeSchema.optional(),
	role: z.string().nullable().optional(),
});

const pathSegmentSchema = z.object({
	depth: z.number().int().nonnegative(),
	name: z.string().min(1),
	segmentType: pathSegmentTypeSchema,
});

const physicalLocationSchema = z.object({
	building: z.string().nullable().optional(),
	room: z.string().nullable().optional(),
	shelf: z.string().nullable().optional(),
	container: z.string().nullable().optional(),
	position: z.string().nullable().optional(),
	notes: z.string().nullable().optional(),
});

const provenanceContextSchema = z.object({
	channel: acquisitionChannelSchema.optional(),
	submittedBy: submittedBySchema.optional(),
	submittedAt: dateInputSchema.optional(),
	collectionId: z.string().uuid().nullable().optional(),
	submissionNotes: z.string().nullable().optional(),
	submissionMetadata: z.record(z.string(), z.unknown()).optional(),
	authenticityStatus: authenticityStatusSchema.optional(),
	authenticityNotes: z.string().nullable().optional(),
});

const originalSourceSchema = z.object({
	contextId: z.string().uuid().optional(),
	sourceType: originalSourceTypeSchema,
	sourceDescription: z.string().min(1),
	sourceDate: nullableDateInputSchema.optional(),
	sourceAuthor: z.string().nullable().optional(),
	sourceLanguage: z.string().optional(),
	sourceInstitution: z.string().nullable().optional(),
	foiaReference: z.string().nullable().optional(),
});

const custodyStepSchema = z.object({
	contextId: z.string().uuid().optional(),
	stepOrder: z.number().int().positive(),
	holder: z.string().min(1),
	holderType: custodyHolderTypeSchema.optional(),
	receivedFrom: z.string().nullable().optional(),
	heldFrom: nullableDateInputSchema.optional(),
	heldUntil: nullableDateInputSchema.optional(),
	actions: z.array(custodyActionSchema).optional(),
	location: z.string().nullable().optional(),
	notes: z.string().nullable().optional(),
});

const archiveSchema = z.object({
	archiveId: z.string().uuid().optional(),
	name: z.string().min(1),
	description: z.string().optional(),
	type: archiveTypeSchema.optional(),
	institution: z.string().nullable().optional(),
	custodian: z.string().nullable().optional(),
	physicalAddress: z.string().nullable().optional(),
	status: archiveStatusSchema.optional(),
	structureDescription: z.string().nullable().optional(),
	estimatedDocumentCount: z.number().int().nonnegative().nullable().optional(),
	languages: z.array(z.string()).optional(),
	dateRange: z
		.object({
			earliest: nullableDateInputSchema.optional(),
			latest: nullableDateInputSchema.optional(),
		})
		.optional(),
	ingestStatus: z
		.object({
			totalDocumentsKnown: z.number().int().nonnegative().nullable().optional(),
			totalDocumentsIngested: z.number().int().nonnegative().optional(),
			lastIngestDate: nullableDateInputSchema.optional(),
			completeness: archiveCompletenessSchema.optional(),
			notes: z.string().nullable().optional(),
		})
		.optional(),
	accessRestrictions: z.string().nullable().optional(),
	registeredAt: dateInputSchema.optional(),
	lastVerifiedAt: nullableDateInputSchema.optional(),
});

const archiveLocationSchema = z.object({
	archiveId: z.string().uuid().optional(),
	originalPath: z.string().min(1),
	originalFilename: z.string().min(1),
	pathSegments: z.array(pathSegmentSchema).optional(),
	physicalLocation: physicalLocationSchema.nullable().optional(),
	sourceStatus: archiveSourceStatusSchema.optional(),
	sourceStatusUpdatedAt: dateInputSchema.optional(),
	recordedAt: dateInputSchema.optional(),
	validFrom: nullableDateInputSchema.optional(),
	validUntil: nullableDateInputSchema.optional(),
});

export const ingestProvenanceInputSchema = z.object({
	context: provenanceContextSchema.optional(),
	originalSource: originalSourceSchema.nullable().optional(),
	custodyChain: z.array(custodyStepSchema).optional(),
	archive: archiveSchema.nullable().optional(),
	archiveLocation: archiveLocationSchema.optional(),
});

export function parseIngestProvenanceInput(value: unknown): IngestProvenanceInput {
	return ingestProvenanceInputSchema.parse(value);
}

export interface IngestProvenanceContextInput {
	channel?: AcquisitionChannel;
	submittedBy?: Partial<SubmittedBy>;
	submittedAt?: Date | string;
	collectionId?: string | null;
	submissionNotes?: string | null;
	submissionMetadata?: Record<string, unknown>;
	authenticityStatus?: AuthenticityStatus;
	authenticityNotes?: string | null;
}

export interface IngestProvenanceInput {
	context?: IngestProvenanceContextInput;
	originalSource?: OriginalSourceInput | null;
	custodyChain?: CustodyStepInput[];
	archive?: ArchiveInput | null;
	archiveLocation?: RecordIngestProvenanceInput['archiveLocation'];
}

// ────────────────────────────────────────────────────────────
// Input
// ────────────────────────────────────────────────────────────

/** Input for the ingest step. */
export interface IngestInput {
	/** File or directory path containing supported source files. */
	path: string;
	/** Optional tags for batch operations. */
	tags?: string[];
	/** Validate without uploading or creating DB records. */
	dryRun?: boolean;
	/** Optional provenance metadata to attach to each successful ingest. */
	provenance?: IngestProvenanceInput;
}

// ────────────────────────────────────────────────────────────
// Per-file result
// ────────────────────────────────────────────────────────────

/** Result for a single ingested file. */
export interface IngestFileResult {
	/** UUID of the source record. */
	sourceId: string;
	/** Original filename (basename). */
	filename: string;
	/** Storage path in GCS (e.g., `raw/{uuid}/original.pdf`). */
	storagePath: string;
	/** SHA-256 hash of the file content. */
	fileHash: string;
	/** Detected source format discriminator. */
	sourceType: SourceType;
	/** Format-specific metadata stored on the source row. */
	formatMetadata: SourceFormatMetadata;
	/** Number of pages represented by this source. */
	pageCount: number;
	/** Whether the source contains extractable native text. */
	hasNativeText: boolean;
	/** Fraction of pages with native text (0-1). */
	nativeTextRatio: number;
	/** True if this file hash already existed in the database. */
	duplicate: boolean;
	/** Lightweight PDF metadata extracted without decompressing page content. */
	pdfMetadata?: PdfMetadata;
}

// ────────────────────────────────────────────────────────────
// Aggregate result
// ────────────────────────────────────────────────────────────

/** Aggregate result of the ingest step. */
export interface IngestResult {
	/** Overall status: success if all passed, partial if some failed, failed if all failed. */
	status: 'success' | 'partial' | 'failed';
	/** Per-file results for successful files. */
	data: IngestFileResult[];
	/** Per-file errors for failed files. */
	errors: StepError[];
	/** Execution metadata. */
	metadata: {
		duration_ms: number;
		items_processed: number;
		items_skipped: number;
		items_cached: number;
	};
}
