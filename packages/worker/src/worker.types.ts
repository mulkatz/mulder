/**
 * Worker runtime types and validation helpers.
 *
 * The worker package owns the queue-facing runtime contracts consumed by the
 * CLI layer and by spec-level tests. Job payloads stay small, explicit, and
 * step-specific so the worker can validate them before dispatching to the
 * underlying pipeline or taxonomy functions.
 *
 * @see docs/specs/68_worker_loop.spec.md §4.1
 * @see docs/functional-spec.md §10.3, §10.4, §10.5
 */

import { hostname } from 'node:os';
import type {
	AcquisitionChannel,
	ArchiveLocationInput,
	AuthenticityStatus,
	CustodyStepInput,
	Job,
	Logger,
	MulderConfig,
	OriginalSourceInput,
	PathSegmentType,
	PIIType,
	SensitivityLevel,
	Services,
	SubmittedBy,
} from '@mulder/core';
import { isSensitivityLevel, MulderError, PII_TYPES } from '@mulder/core';
import type pg from 'pg';

// ────────────────────────────────────────────────────────────
// Supported job types
// ────────────────────────────────────────────────────────────

export type SourceStepJobType = 'quality' | 'extract' | 'segment';
export type StoryStepJobType = 'enrich' | 'embed' | 'graph';
export type StepScopedJobType = SourceStepJobType | StoryStepJobType;
export type UploadFinalizeJobType = 'document_upload_finalize';
export type TranslateJobType = 'translate';
export type LegacyWorkerJobType = 'pipeline_run';
export type SupportedJobType = StepScopedJobType | UploadFinalizeJobType | TranslateJobType;
export type WorkerJobType = SupportedJobType | LegacyWorkerJobType;
export type WorkerPipelineStepName = StepScopedJobType;

interface StepChainingPayload {
	runId?: string;
	upTo?: WorkerPipelineStepName;
	tag?: string;
	force?: boolean;
}

export interface SourceStepJobPayload {
	sourceId: string;
	runId?: string;
	upTo?: WorkerPipelineStepName;
	tag?: string;
	force?: boolean;
	fallbackOnly?: boolean;
}

export interface StoryStepJobPayload {
	storyId?: string;
	sourceId?: string;
	runId?: string;
	upTo?: WorkerPipelineStepName;
	tag?: string;
	force?: boolean;
}

export interface PipelineRunJobPayload {
	sourceId: string;
	runId?: string;
	from?: WorkerPipelineStepName;
	upTo?: WorkerPipelineStepName;
	tag?: string;
	force?: boolean;
	fallbackOnly?: boolean;
}

export interface DocumentUploadProvenancePayload {
	context?: {
		channel?: AcquisitionChannel;
		submittedAt?: string;
		collectionId?: string | null;
		submissionNotes?: string | null;
		submissionMetadata?: Record<string, unknown>;
		authenticityStatus?: AuthenticityStatus;
		authenticityNotes?: string | null;
	};
	originalSource?: OriginalSourceInput | null;
	custodyChain?: CustodyStepInput[];
	archiveLocation?: (Omit<ArchiveLocationInput, 'blobContentHash' | 'archiveId'> & { archiveId: string }) | null;
}

export interface DocumentUploadExpectedSensitivity {
	level: SensitivityLevel;
	reason?: string;
	piiTypes?: PIIType[];
	declassifyDate?: string | null;
}

export interface DocumentUploadFinalizeJobPayload {
	sourceId: string;
	filename: string;
	storagePath: string;
	tags?: string[];
	startPipeline?: boolean;
	declaredSizeBytes?: number;
	submittedBy?: SubmittedBy;
	provenance?: DocumentUploadProvenancePayload;
	expectedSensitivity?: DocumentUploadExpectedSensitivity;
}

export interface TranslateJobPayload {
	sourceId: string;
	targetLanguage: string;
	sourceLanguage?: string;
	pipelinePath?: 'full' | 'translation_only';
	outputFormat?: 'markdown' | 'html';
	refresh?: boolean;
}

export type LegacyPipelineRunJobPayload = PipelineRunJobPayload;

export type WorkerJobPayloadMap = {
	quality: SourceStepJobPayload;
	extract: SourceStepJobPayload;
	segment: SourceStepJobPayload;
	enrich: StoryStepJobPayload;
	embed: StoryStepJobPayload;
	graph: StoryStepJobPayload;
	document_upload_finalize: DocumentUploadFinalizeJobPayload;
	translate: TranslateJobPayload;
	pipeline_run: LegacyPipelineRunJobPayload;
};

interface WorkerJobEnvelopeShape<TType extends WorkerJobType> {
	id: string;
	type: TType;
	payload: WorkerJobPayloadMap[TType];
	status: 'pending' | 'running' | 'completed' | 'failed' | 'dead_letter';
	attempts: number;
	maxAttempts: number;
	errorLog: string | null;
	workerId: string | null;
	createdAt: Date;
	startedAt: Date | null;
	finishedAt: Date | null;
}

export type WorkerJobEnvelope<TType extends WorkerJobType = WorkerJobType> = TType extends WorkerJobType
	? WorkerJobEnvelopeShape<TType>
	: never;

export interface WorkerJobStatusSnapshot {
	id: string;
	type: SupportedJobType | string;
	status: 'running' | 'pending' | 'completed' | 'failed' | 'dead_letter';
	workerId: string | null;
	attempts: number;
	startedAt: Date | null;
	finishedAt: Date | null;
}

export interface WorkerActiveJobSnapshot {
	workerId: string;
	jobCount: number;
	jobs: WorkerJobStatusSnapshot[];
}

export interface WorkerQueueCounts {
	pending: number;
	running: number;
	completed: number;
	failed: number;
	deadLetter: number;
	total: number;
}

export interface WorkerStatusSnapshot {
	checkedAt: Date;
	queue: WorkerQueueCounts;
	runningJobs: WorkerJobStatusSnapshot[];
	activeWorkers: WorkerActiveJobSnapshot[];
}

export interface WorkerReapOptions {
	staleAfter?: Date;
}

export interface WorkerRuntimeResult {
	workerId: string;
	processedCount: number;
	succeededCount: number;
	failedCount: number;
	deadLetterCount: number;
	idlePollCount: number;
}

export interface WorkerStartCliOptions {
	concurrency?: string;
	pollInterval?: string;
}

export interface WorkerRuntimeOptions {
	concurrency: number;
	pollIntervalMs: number;
	workerId?: string;
	abortSignal?: AbortSignal;
}

export interface WorkerDispatchContext {
	config: MulderConfig;
	services: Services;
	pool: pg.Pool;
	workerId: string;
	logger: Logger;
}

export type WorkerDispatchFn = (
	job: WorkerJobEnvelope,
	context: WorkerDispatchContext,
) => Promise<Record<string, unknown> | undefined>;

export const WORKER_ERROR_CODES = {
	WORKER_UNKNOWN_JOB_TYPE: 'WORKER_UNKNOWN_JOB_TYPE',
	WORKER_INVALID_JOB_PAYLOAD: 'WORKER_INVALID_JOB_PAYLOAD',
	WORKER_INVALID_OPTION: 'WORKER_INVALID_OPTION',
	WORKER_SHUTDOWN: 'WORKER_SHUTDOWN',
	WORKER_LOOP_FAILED: 'WORKER_LOOP_FAILED',
} as const;

export type WorkerErrorCode = (typeof WORKER_ERROR_CODES)[keyof typeof WORKER_ERROR_CODES];

export class WorkerError extends MulderError {
	constructor(
		message: string,
		code: WorkerErrorCode,
		options?: {
			context?: Record<string, unknown>;
			cause?: unknown;
		},
	) {
		super(message, code, options);
		this.name = 'WorkerError';
	}
}

export function describeWorkerError(error: unknown): string {
	if (error instanceof WorkerError) {
		return `[${error.code}] ${error.message}`;
	}
	if (error && typeof error === 'object' && 'code' in error && 'message' in error) {
		const code = typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : undefined;
		const message = String((error as { message?: unknown }).message ?? String(error));
		if (code) {
			return `[${code}] ${message}`;
		}
		return message;
	}
	return error instanceof Error ? error.message : String(error);
}

export function isSupportedJobType(type: string): type is SupportedJobType {
	return (
		type === 'quality' ||
		type === 'extract' ||
		type === 'segment' ||
		type === 'enrich' ||
		type === 'embed' ||
		type === 'graph' ||
		type === 'document_upload_finalize' ||
		type === 'translate'
	);
}

export function isWorkerJobType(type: string): type is WorkerJobType {
	return type === 'pipeline_run' || isSupportedJobType(type);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown): string | null {
	return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function asBoolean(value: unknown): boolean | undefined {
	return typeof value === 'boolean' ? value : undefined;
}

function asPositiveInteger(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function readOptionalRecord(value: unknown): Record<string, unknown> | undefined {
	return isRecord(value) ? value : undefined;
}

function readNullableStringField(
	payload: Record<string, unknown>,
	primaryKey: string,
	fallbackKey?: string,
): string | null | undefined {
	if (payload[primaryKey] === null) {
		return null;
	}
	if (payload[primaryKey] !== undefined) {
		const value = readStringField(payload, primaryKey);
		return value ?? undefined;
	}
	if (fallbackKey && payload[fallbackKey] === null) {
		return null;
	}
	const value = readStringField(payload, primaryKey, fallbackKey);
	return value ?? undefined;
}

function readStringField(payload: Record<string, unknown>, primaryKey: string, fallbackKey?: string): string | null {
	const primary = asString(payload[primaryKey]);
	if (primary) {
		return primary;
	}

	if (fallbackKey) {
		return asString(payload[fallbackKey]);
	}

	return null;
}

const ACQUISITION_CHANNELS = [
	'archive_import',
	'manual_upload',
	'email_submission',
	'web_research',
	'api_import',
	'bulk_import',
	're_scan',
	'partner_exchange',
] as const;
const AUTHENTICITY_STATUSES = ['unverified', 'verified', 'disputed'] as const;
const ORIGINAL_SOURCE_TYPES = [
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
] as const;
const CUSTODY_HOLDER_TYPES = ['person', 'institution', 'archive', 'unknown'] as const;
const CUSTODY_ACTIONS = [
	'received',
	'copied',
	'digitized',
	'annotated',
	'translated',
	'redacted',
	'restored',
	'transferred',
	'archived',
] as const;
const ARCHIVE_SOURCE_STATUSES = [
	'current',
	'moved',
	'deleted_from_source',
	'archive_destroyed',
	'digitized_only',
	'unknown',
] as const;
const PATH_SEGMENT_TYPES = [
	'collection',
	'topic',
	'region',
	'time_period',
	'person',
	'case',
	'administrative',
	'unknown',
] as const satisfies readonly PathSegmentType[];

function readEnumField<T extends string>(
	jobId: string,
	allowed: readonly T[],
	value: unknown,
	field: string,
): T | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}
	if (typeof value === 'string' && allowed.includes(value as T)) {
		return value as T;
	}
	throw invalidPayload(jobId, 'document_upload_finalize', `document_upload_finalize jobs require a valid ${field}`, {
		field,
		value,
	});
}

function parseSubmittedBy(jobId: string, value: unknown): SubmittedBy | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}
	if (!isRecord(value)) {
		throw invalidPayload(jobId, 'document_upload_finalize', 'submittedBy must be an object', { field: 'submittedBy' });
	}
	const userId = readStringField(value, 'userId', 'user_id');
	const type = readEnumField(jobId, ['human', 'system'] as const, value.type, 'submittedBy.type');
	if (!userId || !type) {
		throw invalidPayload(jobId, 'document_upload_finalize', 'submittedBy requires userId and type', {
			field: 'submittedBy',
		});
	}
	return {
		userId,
		type,
		role: readNullableStringField(value, 'role') ?? null,
	};
}

function parseCustodyChain(jobId: string, value: unknown): CustodyStepInput[] | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}
	if (!Array.isArray(value)) {
		throw invalidPayload(jobId, 'document_upload_finalize', 'custodyChain must be an array', {
			field: 'provenance.custodyChain',
		});
	}
	return value.map((rawStep, index) => {
		if (!isRecord(rawStep)) {
			throw invalidPayload(jobId, 'document_upload_finalize', 'custodyChain entries must be objects', {
				field: `provenance.custodyChain.${index}`,
			});
		}
		const stepOrder = asPositiveInteger(rawStep.stepOrder ?? rawStep.step_order);
		const holder = readStringField(rawStep, 'holder');
		if (!stepOrder || !holder) {
			throw invalidPayload(jobId, 'document_upload_finalize', 'custodyChain entries require stepOrder and holder', {
				field: `provenance.custodyChain.${index}`,
			});
		}
		return {
			stepOrder,
			holder,
			holderType: readEnumField(jobId, CUSTODY_HOLDER_TYPES, rawStep.holderType ?? rawStep.holder_type, 'holderType'),
			receivedFrom: readNullableStringField(rawStep, 'receivedFrom', 'received_from'),
			heldFrom: readNullableStringField(rawStep, 'heldFrom', 'held_from'),
			heldUntil: readNullableStringField(rawStep, 'heldUntil', 'held_until'),
			actions: Array.isArray(rawStep.actions)
				? rawStep.actions
						.map((action) => readEnumField(jobId, CUSTODY_ACTIONS, action, 'custodyAction'))
						.filter((action): action is NonNullable<typeof action> => Boolean(action))
				: undefined,
			location: readNullableStringField(rawStep, 'location'),
			notes: readNullableStringField(rawStep, 'notes'),
		};
	});
}

function parsePhysicalLocation(value: unknown) {
	const record = readOptionalRecord(value);
	if (!record) {
		return undefined;
	}
	return {
		building: readNullableStringField(record, 'building'),
		room: readNullableStringField(record, 'room'),
		shelf: readNullableStringField(record, 'shelf'),
		container: readNullableStringField(record, 'container'),
		position: readNullableStringField(record, 'position'),
		notes: readNullableStringField(record, 'notes'),
	};
}

function parseUploadProvenance(jobId: string, value: unknown): DocumentUploadProvenancePayload | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}
	if (!isRecord(value)) {
		throw invalidPayload(jobId, 'document_upload_finalize', 'provenance must be an object', { field: 'provenance' });
	}

	const context = readOptionalRecord(value.context);
	const originalSource = readOptionalRecord(value.originalSource ?? value.original_source);
	const archiveLocation = readOptionalRecord(value.archiveLocation ?? value.archive_location);
	const sourceType = originalSource
		? readEnumField(
				jobId,
				ORIGINAL_SOURCE_TYPES,
				originalSource.sourceType ?? originalSource.source_type,
				'provenance.originalSource.sourceType',
			)
		: undefined;
	if (originalSource && !sourceType) {
		throw invalidPayload(jobId, 'document_upload_finalize', 'originalSource requires sourceType', {
			field: 'provenance.originalSource.sourceType',
		});
	}
	const archiveId = archiveLocation ? readStringField(archiveLocation, 'archiveId', 'archive_id') : null;
	const originalPath = archiveLocation ? readStringField(archiveLocation, 'originalPath', 'original_path') : null;
	const originalFilename = archiveLocation
		? readStringField(archiveLocation, 'originalFilename', 'original_filename')
		: null;
	if (archiveLocation && (!archiveId || !originalPath || !originalFilename)) {
		throw invalidPayload(
			jobId,
			'document_upload_finalize',
			'archiveLocation requires archiveId, originalPath, and originalFilename',
			{ field: 'provenance.archiveLocation' },
		);
	}

	return {
		context: context
			? {
					channel: readEnumField(jobId, ACQUISITION_CHANNELS, context.channel, 'provenance.context.channel'),
					submittedAt: readStringField(context, 'submittedAt', 'submitted_at') ?? undefined,
					collectionId: readNullableStringField(context, 'collectionId', 'collection_id'),
					submissionNotes: readNullableStringField(context, 'submissionNotes', 'submission_notes'),
					submissionMetadata: readOptionalRecord(context.submissionMetadata ?? context.submission_metadata),
					authenticityStatus: readEnumField(
						jobId,
						AUTHENTICITY_STATUSES,
						context.authenticityStatus ?? context.authenticity_status,
						'provenance.context.authenticityStatus',
					),
					authenticityNotes: readNullableStringField(context, 'authenticityNotes', 'authenticity_notes'),
				}
			: undefined,
		originalSource: originalSource
			? {
					sourceType: sourceType ?? 'other',
					sourceDescription:
						readStringField(originalSource, 'sourceDescription', 'source_description') ??
						readStringField(originalSource, 'description') ??
						'Uploaded source',
					sourceDate: readNullableStringField(originalSource, 'sourceDate', 'source_date'),
					sourceAuthor: readNullableStringField(originalSource, 'sourceAuthor', 'source_author'),
					sourceLanguage: readStringField(originalSource, 'sourceLanguage', 'source_language') ?? undefined,
					sourceInstitution: readNullableStringField(originalSource, 'sourceInstitution', 'source_institution'),
					foiaReference: readNullableStringField(originalSource, 'foiaReference', 'foia_reference'),
				}
			: undefined,
		custodyChain: parseCustodyChain(jobId, value.custodyChain ?? value.custody_chain),
		archiveLocation: archiveLocation
			? {
					archiveId: archiveId ?? '',
					originalPath: originalPath ?? '',
					originalFilename: originalFilename ?? '',
					pathSegments: Array.isArray(archiveLocation.pathSegments ?? archiveLocation.path_segments)
						? ((archiveLocation.pathSegments ?? archiveLocation.path_segments) as unknown[])
								.filter(isRecord)
								.map((segment) => ({
									depth: typeof segment.depth === 'number' ? segment.depth : 0,
									name: readStringField(segment, 'name') ?? 'unknown',
									segmentType:
										readEnumField(
											jobId,
											PATH_SEGMENT_TYPES,
											segment.segmentType ?? segment.segment_type,
											'pathSegment.segmentType',
										) ?? 'unknown',
								}))
						: undefined,
					physicalLocation: parsePhysicalLocation(
						archiveLocation.physicalLocation ?? archiveLocation.physical_location,
					),
					sourceStatus: readEnumField(
						jobId,
						ARCHIVE_SOURCE_STATUSES,
						archiveLocation.sourceStatus ?? archiveLocation.source_status,
						'provenance.archiveLocation.sourceStatus',
					),
					recordedAt: readStringField(archiveLocation, 'recordedAt', 'recorded_at') ?? undefined,
					validFrom: readNullableStringField(archiveLocation, 'validFrom', 'valid_from'),
					validUntil: readNullableStringField(archiveLocation, 'validUntil', 'valid_until'),
				}
			: undefined,
	};
}

function parseExpectedSensitivity(jobId: string, value: unknown): DocumentUploadExpectedSensitivity | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}
	if (!isRecord(value)) {
		throw invalidPayload(jobId, 'document_upload_finalize', 'expectedSensitivity must be an object', {
			field: 'expectedSensitivity',
		});
	}
	const level = value.level;
	if (!isSensitivityLevel(level)) {
		throw invalidPayload(jobId, 'document_upload_finalize', 'expectedSensitivity requires a valid level', {
			field: 'expectedSensitivity.level',
		});
	}
	const rawPiiTypes = value.piiTypes ?? value.pii_types;
	const piiTypes = Array.isArray(rawPiiTypes)
		? rawPiiTypes
				.filter((item: unknown): item is PIIType => typeof item === 'string' && PII_TYPES.includes(item as PIIType))
				.sort()
		: undefined;
	return {
		level,
		reason: readStringField(value, 'reason') ?? undefined,
		piiTypes,
		declassifyDate: readNullableStringField(value, 'declassifyDate', 'declassify_date'),
	};
}

function invalidPayload(
	jobId: string,
	jobType: WorkerJobType,
	reason: string,
	context?: Record<string, unknown>,
): WorkerError {
	return new WorkerError(reason, WORKER_ERROR_CODES.WORKER_INVALID_JOB_PAYLOAD, {
		context: { jobId, jobType, ...(context ?? {}) },
	});
}

export function isWorkerPipelineStep(value: string): value is WorkerPipelineStepName {
	return (
		value === 'quality' ||
		value === 'extract' ||
		value === 'segment' ||
		value === 'enrich' ||
		value === 'embed' ||
		value === 'graph'
	);
}

function parseStepChainingPayload(
	jobId: string,
	jobType: StepScopedJobType,
	payload: Record<string, unknown>,
): StepChainingPayload {
	const parsed: StepChainingPayload = {};

	const runId = readStringField(payload, 'runId', 'run_id');
	if (runId) {
		parsed.runId = runId;
	}

	const upTo = readStringField(payload, 'upTo', 'up_to');
	if (upTo) {
		if (!isWorkerPipelineStep(upTo)) {
			throw invalidPayload(jobId, jobType, `${jobType} jobs require a valid upTo step`, {
				field: 'upTo',
				value: upTo,
			});
		}
		parsed.upTo = upTo;
	}

	const tag = readStringField(payload, 'tag');
	if (tag) {
		parsed.tag = tag;
	}

	const force = asBoolean(payload.force);
	if (force !== undefined) {
		parsed.force = force;
	}

	return parsed;
}

function parseSourceStepPayload(jobId: string, jobType: SourceStepJobType, payload: unknown): SourceStepJobPayload {
	if (!isRecord(payload)) {
		throw invalidPayload(jobId, jobType, `Job ${jobId} payload must be an object`, { field: 'payload' });
	}

	const sourceId = readStringField(payload, 'sourceId', 'source_id');
	if (!sourceId) {
		throw invalidPayload(jobId, jobType, `${jobType} jobs require a non-empty sourceId`, { field: 'sourceId' });
	}

	const parsed: SourceStepJobPayload = { sourceId, ...parseStepChainingPayload(jobId, jobType, payload) };

	const fallbackOnly = asBoolean(payload.fallbackOnly);
	if (fallbackOnly !== undefined) {
		parsed.fallbackOnly = fallbackOnly;
	}

	return parsed;
}

function parseStoryStepPayload(jobId: string, jobType: StoryStepJobType, payload: unknown): StoryStepJobPayload {
	if (!isRecord(payload)) {
		throw invalidPayload(jobId, jobType, `Job ${jobId} payload must be an object`, { field: 'payload' });
	}

	const storyId = readStringField(payload, 'storyId', 'story_id');
	const sourceId = readStringField(payload, 'sourceId', 'source_id');
	if ((storyId && sourceId) || (!storyId && !sourceId)) {
		throw invalidPayload(jobId, jobType, `${jobType} jobs require exactly one of storyId or sourceId`, {
			field: 'storyId|sourceId',
			hasStoryId: Boolean(storyId),
			hasSourceId: Boolean(sourceId),
		});
	}

	const parsed: StoryStepJobPayload = { ...parseStepChainingPayload(jobId, jobType, payload) };
	if (storyId) {
		parsed.storyId = storyId;
	}
	if (sourceId) {
		parsed.sourceId = sourceId;
	}

	return parsed;
}

function parsePipelineRunPayload(jobId: string, payload: unknown): PipelineRunJobPayload {
	if (!isRecord(payload)) {
		throw invalidPayload(jobId, 'pipeline_run', `Job ${jobId} payload must be an object`, { field: 'payload' });
	}

	const sourceId = readStringField(payload, 'sourceId', 'source_id');
	if (!sourceId) {
		throw invalidPayload(jobId, 'pipeline_run', 'pipeline_run jobs require a non-empty sourceId', {
			field: 'sourceId',
		});
	}

	const parsed: PipelineRunJobPayload = { sourceId };

	const runId = readStringField(payload, 'runId', 'run_id');
	if (runId) {
		parsed.runId = runId;
	}

	const from = readStringField(payload, 'from');
	if (from) {
		if (!isWorkerPipelineStep(from)) {
			throw invalidPayload(jobId, 'pipeline_run', 'pipeline_run jobs require a valid from step', {
				field: 'from',
				value: from,
			});
		}
		parsed.from = from;
	}

	const upTo = readStringField(payload, 'upTo', 'up_to');
	if (upTo) {
		if (!isWorkerPipelineStep(upTo)) {
			throw invalidPayload(jobId, 'pipeline_run', 'pipeline_run jobs require a valid upTo step', {
				field: 'upTo',
				value: upTo,
			});
		}
		parsed.upTo = upTo;
	}

	const tag = readStringField(payload, 'tag');
	if (tag) {
		parsed.tag = tag;
	}

	const force = asBoolean(payload.force);
	if (force !== undefined) {
		parsed.force = force;
	}

	const fallbackOnly = asBoolean(payload.fallbackOnly);
	if (fallbackOnly !== undefined) {
		parsed.fallbackOnly = fallbackOnly;
	}

	return parsed;
}

function parseDocumentUploadFinalizePayload(jobId: string, payload: unknown): DocumentUploadFinalizeJobPayload {
	if (!isRecord(payload)) {
		throw invalidPayload(jobId, 'document_upload_finalize', `Job ${jobId} payload must be an object`, {
			field: 'payload',
		});
	}

	const sourceId = readStringField(payload, 'sourceId', 'source_id');
	const filename = readStringField(payload, 'filename');
	const storagePath = readStringField(payload, 'storagePath', 'storage_path');
	if (!sourceId || !filename || !storagePath) {
		throw invalidPayload(
			jobId,
			'document_upload_finalize',
			'document_upload_finalize jobs require sourceId, filename, and storagePath',
			{ field: 'payload' },
		);
	}

	const parsed: DocumentUploadFinalizeJobPayload = {
		sourceId,
		filename,
		storagePath,
	};

	if (Array.isArray(payload.tags)) {
		parsed.tags = payload.tags.filter((tag): tag is string => typeof tag === 'string');
	}

	const startPipeline = asBoolean(payload.startPipeline);
	if (startPipeline !== undefined) {
		parsed.startPipeline = startPipeline;
	}

	const declaredSizeBytes = asPositiveInteger(payload.declaredSizeBytes ?? payload.declared_size_bytes);
	if (declaredSizeBytes !== undefined) {
		parsed.declaredSizeBytes = declaredSizeBytes;
	}

	const submittedBy = parseSubmittedBy(jobId, payload.submittedBy ?? payload.submitted_by);
	if (submittedBy) {
		parsed.submittedBy = submittedBy;
	}

	const provenance = parseUploadProvenance(jobId, payload.provenance);
	if (provenance) {
		parsed.provenance = provenance;
	}

	const expectedSensitivity = parseExpectedSensitivity(
		jobId,
		payload.expectedSensitivity ?? payload.expected_sensitivity,
	);
	if (expectedSensitivity) {
		parsed.expectedSensitivity = expectedSensitivity;
	}

	return parsed;
}

function parseTranslatePayload(jobId: string, payload: unknown): TranslateJobPayload {
	if (!isRecord(payload)) {
		throw invalidPayload(jobId, 'translate', `Job ${jobId} payload must be an object`, { field: 'payload' });
	}

	const sourceId = readStringField(payload, 'sourceId', 'source_id');
	const targetLanguage = readStringField(payload, 'targetLanguage', 'target_language');
	if (!sourceId || !targetLanguage) {
		throw invalidPayload(jobId, 'translate', 'translate jobs require sourceId and targetLanguage', {
			field: 'payload',
		});
	}

	const parsed: TranslateJobPayload = { sourceId, targetLanguage };

	const sourceLanguage = readStringField(payload, 'sourceLanguage', 'source_language');
	if (sourceLanguage) {
		parsed.sourceLanguage = sourceLanguage;
	}

	const pipelinePath = readStringField(payload, 'pipelinePath', 'pipeline_path');
	if (pipelinePath) {
		if (pipelinePath !== 'full' && pipelinePath !== 'translation_only') {
			throw invalidPayload(jobId, 'translate', 'translate jobs require a valid pipelinePath', {
				field: 'pipelinePath',
				value: pipelinePath,
			});
		}
		parsed.pipelinePath = pipelinePath;
	}

	const outputFormat = readStringField(payload, 'outputFormat', 'output_format');
	if (outputFormat) {
		if (outputFormat !== 'markdown' && outputFormat !== 'html') {
			throw invalidPayload(jobId, 'translate', 'translate jobs require a valid outputFormat', {
				field: 'outputFormat',
				value: outputFormat,
			});
		}
		parsed.outputFormat = outputFormat;
	}

	const refresh = asBoolean(payload.refresh);
	if (refresh !== undefined) {
		parsed.refresh = refresh;
	}

	return parsed;
}

export function parseWorkerJobPayload(
	jobId: string,
	jobType: SourceStepJobType,
	payload: unknown,
): SourceStepJobPayload;
export function parseWorkerJobPayload(jobId: string, jobType: StoryStepJobType, payload: unknown): StoryStepJobPayload;
export function parseWorkerJobPayload(
	jobId: string,
	jobType: UploadFinalizeJobType,
	payload: unknown,
): DocumentUploadFinalizeJobPayload;
export function parseWorkerJobPayload(jobId: string, jobType: TranslateJobType, payload: unknown): TranslateJobPayload;
export function parseWorkerJobPayload(
	jobId: string,
	jobType: LegacyWorkerJobType,
	payload: unknown,
): LegacyPipelineRunJobPayload;
export function parseWorkerJobPayload(
	jobId: string,
	jobType: WorkerJobType,
	payload: unknown,
): WorkerJobPayloadMap[WorkerJobType] {
	if (jobType === 'quality' || jobType === 'extract' || jobType === 'segment') {
		return parseSourceStepPayload(jobId, jobType, payload);
	}

	if (jobType === 'enrich' || jobType === 'embed' || jobType === 'graph') {
		return parseStoryStepPayload(jobId, jobType, payload);
	}

	if (jobType === 'document_upload_finalize') {
		return parseDocumentUploadFinalizePayload(jobId, payload);
	}

	if (jobType === 'translate') {
		return parseTranslatePayload(jobId, payload);
	}

	return parsePipelineRunPayload(jobId, payload);
}

export function parseWorkerJobEnvelope(job: Job): WorkerJobEnvelope {
	if (!isWorkerJobType(job.type)) {
		throw new WorkerError(`Unsupported job type "${job.type}"`, WORKER_ERROR_CODES.WORKER_UNKNOWN_JOB_TYPE, {
			context: { jobId: job.id, jobType: job.type },
		});
	}

	switch (job.type) {
		case 'quality':
			return {
				...job,
				type: 'quality',
				payload: parseWorkerJobPayload(job.id, 'quality', job.payload),
			};
		case 'extract':
			return {
				...job,
				type: 'extract',
				payload: parseWorkerJobPayload(job.id, 'extract', job.payload),
			};
		case 'segment':
			return {
				...job,
				type: 'segment',
				payload: parseWorkerJobPayload(job.id, 'segment', job.payload),
			};
		case 'enrich':
			return {
				...job,
				type: 'enrich',
				payload: parseWorkerJobPayload(job.id, 'enrich', job.payload),
			};
		case 'embed':
			return {
				...job,
				type: 'embed',
				payload: parseWorkerJobPayload(job.id, 'embed', job.payload),
			};
		case 'graph':
			return {
				...job,
				type: 'graph',
				payload: parseWorkerJobPayload(job.id, 'graph', job.payload),
			};
		case 'document_upload_finalize':
			return {
				...job,
				type: 'document_upload_finalize',
				payload: parseWorkerJobPayload(job.id, 'document_upload_finalize', job.payload),
			};
		case 'translate':
			return {
				...job,
				type: 'translate',
				payload: parseWorkerJobPayload(job.id, 'translate', job.payload),
			};
		case 'pipeline_run':
			return {
				...job,
				type: 'pipeline_run',
				payload: parseWorkerJobPayload(job.id, 'pipeline_run', job.payload),
			};
	}
}

export function createWorkerId(slot = 0): string {
	const suffix = slot > 0 ? `-${slot + 1}` : '';
	return `worker-${hostname()}-${process.pid}${suffix}`;
}
