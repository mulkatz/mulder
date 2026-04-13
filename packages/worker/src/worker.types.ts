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
import type { Logger, MulderConfig, Services } from '@mulder/core';
import { MulderError } from '@mulder/core';
import type pg from 'pg';

// ────────────────────────────────────────────────────────────
// Supported job types
// ────────────────────────────────────────────────────────────

export type SupportedJobType = 'pipeline_run';

export interface PipelineRunJobPayload {
	sourceId: string;
	force?: boolean;
}

export type WorkerJobPayloadMap = {
	pipeline_run: PipelineRunJobPayload;
};

export interface WorkerJobEnvelope<TType extends SupportedJobType = SupportedJobType> {
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

export type WorkerDispatchFn = (job: WorkerJobEnvelope, context: WorkerDispatchContext) => Promise<void>;

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
	return type === 'pipeline_run';
}

export function createWorkerId(slot = 0): string {
	const suffix = slot > 0 ? `-${slot + 1}` : '';
	return `worker-${hostname()}-${process.pid}${suffix}`;
}
