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
import type { Job, Logger, MulderConfig, Services } from '@mulder/core';
import { MulderError } from '@mulder/core';
import type pg from 'pg';

// ────────────────────────────────────────────────────────────
// Supported job types
// ────────────────────────────────────────────────────────────

export type SourceStepJobType = 'extract' | 'segment';
export type StoryStepJobType = 'enrich' | 'embed' | 'graph';
export type StepScopedJobType = SourceStepJobType | StoryStepJobType;
export type UploadFinalizeJobType = 'document_upload_finalize';
export type LegacyWorkerJobType = 'pipeline_run';
export type SupportedJobType = StepScopedJobType | UploadFinalizeJobType;
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

export interface DocumentUploadFinalizeJobPayload {
	sourceId: string;
	filename: string;
	storagePath: string;
	tags?: string[];
	startPipeline?: boolean;
}

export type LegacyPipelineRunJobPayload = PipelineRunJobPayload;

export type WorkerJobPayloadMap = {
	extract: SourceStepJobPayload;
	segment: SourceStepJobPayload;
	enrich: StoryStepJobPayload;
	embed: StoryStepJobPayload;
	graph: StoryStepJobPayload;
	document_upload_finalize: DocumentUploadFinalizeJobPayload;
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
		type === 'extract' ||
		type === 'segment' ||
		type === 'enrich' ||
		type === 'embed' ||
		type === 'graph' ||
		type === 'document_upload_finalize'
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
	return value === 'extract' || value === 'segment' || value === 'enrich' || value === 'embed' || value === 'graph';
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

	return parsed;
}

export function parseWorkerJobPayload<TType extends WorkerJobType>(
	jobId: string,
	jobType: TType,
	payload: unknown,
): WorkerJobPayloadMap[TType] {
	if (jobType === 'extract' || jobType === 'segment') {
		return parseSourceStepPayload(jobId, jobType, payload) as WorkerJobPayloadMap[TType];
	}

	if (jobType === 'enrich' || jobType === 'embed' || jobType === 'graph') {
		return parseStoryStepPayload(jobId, jobType, payload) as WorkerJobPayloadMap[TType];
	}

	if (jobType === 'document_upload_finalize') {
		return parseDocumentUploadFinalizePayload(jobId, payload) as WorkerJobPayloadMap[TType];
	}

	return parsePipelineRunPayload(jobId, payload) as WorkerJobPayloadMap[TType];
}

export function parseWorkerJobEnvelope(job: Job): WorkerJobEnvelope {
	if (!isWorkerJobType(job.type)) {
		throw new WorkerError(`Unsupported job type "${job.type}"`, WORKER_ERROR_CODES.WORKER_UNKNOWN_JOB_TYPE, {
			context: { jobId: job.id, jobType: job.type },
		});
	}

	switch (job.type) {
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
