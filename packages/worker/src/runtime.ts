/**
 * Worker runtime: polling loop, job execution, status snapshot, and stale
 * job recovery helpers.
 *
 * The loop intentionally keeps queue claim, dispatch, and terminal update as
 * separate auto-commit operations. No long-lived transaction spans job work.
 *
 * @see docs/specs/68_worker_loop.spec.md §4.1, §4.2
 * @see docs/functional-spec.md §10.3, §10.4, §10.5
 */

import { setTimeout as delay } from 'node:timers/promises';
import type { Job, Logger, MulderConfig, Services } from '@mulder/core';
import {
	completedStepsFromProgress,
	countJobs,
	createChildLogger,
	dequeueJob,
	finalizeBudgetReservation,
	finalizeMonthlyBudgetReservation,
	findJobs,
	findMonthlyBudgetReservationByRunId,
	findPipelineRunSourcesByRunId,
	findSourceById,
	markJobCompleted,
	markJobFailed,
	reapRunningJobs,
} from '@mulder/core';
import type pg from 'pg';
import { dispatchJob } from './dispatch.js';
import {
	createWorkerId,
	describeWorkerError,
	type PipelineRunJobPayload,
	type WorkerActiveJobSnapshot,
	type WorkerDispatchContext,
	type WorkerDispatchFn,
	type WorkerJobEnvelope,
	type WorkerJobStatusSnapshot,
	type WorkerQueueCounts,
	type WorkerReapOptions,
	type WorkerRuntimeOptions,
	type WorkerRuntimeResult,
	type WorkerStatusSnapshot,
} from './worker.types.js';

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_STALE_JOB_AGE_MS = 2 * 60 * 60 * 1000;

export interface WorkerRuntimeContext {
	config: MulderConfig;
	services: Services;
	pool: pg.Pool;
	logger: Logger;
	dispatch?: WorkerDispatchFn;
}

export interface WorkerProcessResult {
	state: 'idle' | 'completed' | 'failed' | 'dead_letter';
	job: WorkerJobEnvelope | null;
	error: unknown | null;
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === 'AbortError';
}

function buildQueueCounts(
	pending: number,
	running: number,
	completed: number,
	failed: number,
	deadLetter: number,
): WorkerQueueCounts {
	return {
		pending,
		running,
		completed,
		failed,
		deadLetter,
		total: pending + running + completed + failed + deadLetter,
	};
}

function mapJob(job: Awaited<ReturnType<typeof findJobs>>[number]): WorkerJobStatusSnapshot {
	return {
		id: job.id,
		type: job.type,
		status: job.status,
		workerId: job.workerId,
		attempts: job.attempts,
		startedAt: job.startedAt,
		finishedAt: job.finishedAt,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isWorkerJobEnvelopeType(type: string): type is WorkerJobEnvelope['type'] {
	return (
		type === 'extract' ||
		type === 'segment' ||
		type === 'enrich' ||
		type === 'embed' ||
		type === 'graph' ||
		type === 'pipeline_run'
	);
}

function readOptionalBoolean(payload: Record<string, unknown>, key: string): boolean | undefined {
	return typeof payload[key] === 'boolean' ? payload[key] : undefined;
}

function readOptionalString(
	payload: Record<string, unknown>,
	primaryKey: string,
	fallbackKey?: string,
): string | undefined {
	if (typeof payload[primaryKey] === 'string' && payload[primaryKey].trim().length > 0) {
		return payload[primaryKey].trim();
	}
	if (fallbackKey && typeof payload[fallbackKey] === 'string' && payload[fallbackKey].trim().length > 0) {
		return payload[fallbackKey].trim();
	}
	return undefined;
}

function toWorkerJobPayload(job: Job): WorkerJobEnvelope['payload'] {
	if (!isRecord(job.payload)) {
		throw new Error(`Job ${job.id} payload must be an object`);
	}

	if (job.type === 'extract' || job.type === 'segment') {
		const sourceId = readOptionalString(job.payload, 'sourceId', 'source_id');
		if (!sourceId) {
			throw new Error(`Job ${job.id} is missing sourceId`);
		}

		const payload: WorkerJobEnvelope['payload'] = {
			sourceId,
		};

		const force = readOptionalBoolean(job.payload, 'force');
		if (force !== undefined) {
			payload.force = force;
		}

		const fallbackOnly = readOptionalBoolean(job.payload, 'fallbackOnly');
		if (fallbackOnly !== undefined) {
			payload.fallbackOnly = fallbackOnly;
		}

		return payload;
	}

	if (job.type === 'pipeline_run') {
		const sourceId = readOptionalString(job.payload, 'sourceId', 'source_id');
		if (!sourceId) {
			throw new Error(`Job ${job.id} is missing sourceId`);
		}

		const payload: PipelineRunJobPayload = { sourceId };

		const force = readOptionalBoolean(job.payload, 'force');
		if (force !== undefined) {
			payload.force = force;
		}

		const fallbackOnly = readOptionalBoolean(job.payload, 'fallbackOnly');
		if (fallbackOnly !== undefined) {
			payload.fallbackOnly = fallbackOnly;
		}

		const runId = readOptionalString(job.payload, 'runId', 'run_id');
		if (runId) {
			payload.runId = runId;
		}

		const from = readOptionalString(job.payload, 'from');
		if (from) {
			payload.from = from;
		}

		const upTo = readOptionalString(job.payload, 'upTo', 'up_to');
		if (upTo) {
			payload.upTo = upTo;
		}

		const tag = readOptionalString(job.payload, 'tag');
		if (tag) {
			payload.tag = tag;
		}

		return payload;
	}

	if (job.type === 'enrich' || job.type === 'embed' || job.type === 'graph') {
		const storyId =
			typeof job.payload.storyId === 'string'
				? job.payload.storyId
				: typeof job.payload.story_id === 'string'
					? job.payload.story_id
					: null;
		if (!storyId) {
			throw new Error(`Job ${job.id} is missing storyId`);
		}

		return {
			storyId,
			force: readOptionalBoolean(job.payload, 'force'),
		};
	}

	throw new Error(`Unsupported job type "${job.type}"`);
}

function toWorkerJobEnvelope(job: Job): WorkerJobEnvelope {
	if (!isWorkerJobEnvelopeType(job.type)) {
		throw new Error(`Unsupported job type "${job.type}"`);
	}

	return {
		...job,
		type: job.type,
		payload: toWorkerJobPayload(job),
	};
}

function groupActiveWorkers(runningJobs: WorkerJobStatusSnapshot[]): WorkerActiveJobSnapshot[] {
	const groups = new Map<string, WorkerJobStatusSnapshot[]>();
	for (const job of runningJobs) {
		const key = job.workerId ?? 'unassigned';
		const current = groups.get(key);
		if (current) {
			current.push(job);
		} else {
			groups.set(key, [job]);
		}
	}

	return [...groups.entries()]
		.map(([workerId, jobs]) => ({
			workerId,
			jobCount: jobs.length,
			jobs: jobs.sort((a, b) => {
				const timeA = a.startedAt?.getTime() ?? 0;
				const timeB = b.startedAt?.getTime() ?? 0;
				return timeA - timeB;
			}),
		}))
		.sort((a, b) => b.jobCount - a.jobCount || a.workerId.localeCompare(b.workerId));
}

function getWorkerDispatchContext(base: WorkerRuntimeContext, workerId: string): WorkerDispatchContext {
	return {
		config: base.config,
		services: base.services,
		pool: base.pool,
		workerId,
		logger: base.logger,
	};
}

async function reconcileBudgetReservationAfterJobFailure(
	context: WorkerRuntimeContext,
	job: WorkerJobEnvelope | null,
): Promise<void> {
	if (job?.type !== 'pipeline_run') {
		return;
	}

	const runId =
		'runId' in job.payload && typeof job.payload.runId === 'string' ? job.payload.runId : undefined;
	if (!runId) {
		return;
	}

	const reservation = await findMonthlyBudgetReservationByRunId(context.pool, runId);
	if (!reservation) {
		return;
	}

	const source = await findSourceById(context.pool, reservation.sourceId);
	if (!source) {
		await finalizeMonthlyBudgetReservation(context.pool, {
			runId,
			status: 'released',
			committedUsd: 0,
			releasedUsd: reservation.reservedEstimatedUsd,
			metadata: { reason: 'source_missing_after_job_failure' },
		});
		return;
	}

	const progressRows = await findPipelineRunSourcesByRunId(context.pool, runId);
	const progress = progressRows.find((row) => row.sourceId === reservation.sourceId);
	const completedSteps = progress
		? completedStepsFromProgress(reservation.plannedSteps, progress.currentStep, progress.status)
		: [];
	const finalization = finalizeBudgetReservation({
		source,
		plannedSteps: reservation.plannedSteps,
		completedSteps,
		budget: context.config.api.budget,
		extraction: context.config.extraction,
		force: reservation.metadata.force === true,
	});

	await finalizeMonthlyBudgetReservation(context.pool, {
		runId,
		status: finalization.status,
		committedUsd: finalization.committedUsd,
		releasedUsd: finalization.releasedUsd,
		metadata: {
			progress_status: progress?.status ?? null,
			current_step: progress?.currentStep ?? null,
			reason: 'worker_job_failed',
		},
	});
}

async function waitForPollInterval(ms: number, signal?: AbortSignal): Promise<boolean> {
	try {
		await delay(ms, undefined, signal ? { signal } : undefined);
		return true;
	} catch (error: unknown) {
		if (isAbortError(error) || signal?.aborted) {
			return false;
		}
		throw error;
	}
}

export async function processNextJob(context: WorkerRuntimeContext, workerId: string): Promise<WorkerProcessResult> {
	const workerLog = createChildLogger(context.logger, { workerId });
	const job = await dequeueJob(context.pool, workerId);
	if (!job) {
		return { state: 'idle', job: null, error: null };
	}

	const claim = {
		jobId: job.id,
		workerId,
		attempts: job.attempts,
	};
	const jobLog = createChildLogger(workerLog, { jobId: job.id, jobType: job.type });
	const dispatch = context.dispatch ?? dispatchJob;

	jobLog.info({ attempts: job.attempts }, 'Job claimed');

	let typedJob: WorkerJobEnvelope | null = null;
	try {
		typedJob = toWorkerJobEnvelope(job);
		await dispatch(typedJob, getWorkerDispatchContext(context, workerId));
		await markJobCompleted(context.pool, claim);
		jobLog.info('Job completed');
		return { state: 'completed', job: typedJob, error: null };
	} catch (error: unknown) {
		const errorLog = describeWorkerError(error);
		const updated = await markJobFailed(context.pool, claim, errorLog);
		await reconcileBudgetReservationAfterJobFailure(context, typedJob).catch(() => undefined);
		jobLog.warn({ status: updated.status, err: error }, 'Job failed');
		return {
			state: updated.status === 'dead_letter' ? 'dead_letter' : 'failed',
			job: typedJob,
			error,
		};
	}
}

export async function startWorker(
	context: WorkerRuntimeContext,
	options: WorkerRuntimeOptions,
): Promise<WorkerRuntimeResult> {
	const workerId = options.workerId ?? createWorkerId();
	const workerLog = createChildLogger(context.logger, {
		module: 'worker',
		workerId,
		concurrency: options.concurrency,
		poll_interval_ms: options.pollIntervalMs,
	});

	workerLog.info(
		{
			concurrency: options.concurrency,
			poll_interval_ms: options.pollIntervalMs,
		},
		'Worker started',
	);

	let processedCount = 0;
	let succeededCount = 0;
	let failedCount = 0;
	let deadLetterCount = 0;
	let idlePollCount = 0;

	while (!options.abortSignal?.aborted) {
		const result = await processNextJob(context, workerId);

		if (result.state === 'idle') {
			idlePollCount++;
			const shouldContinue = await waitForPollInterval(options.pollIntervalMs, options.abortSignal);
			if (!shouldContinue) {
				break;
			}
			continue;
		}

		processedCount++;
		if (result.state === 'completed') {
			succeededCount++;
		} else if (result.state === 'dead_letter') {
			deadLetterCount++;
			failedCount++;
		} else {
			failedCount++;
		}
	}

	workerLog.info(
		{
			processedCount,
			succeededCount,
			failedCount,
			deadLetterCount,
			idlePollCount,
		},
		'Worker stopped',
	);

	return {
		workerId,
		processedCount,
		succeededCount,
		failedCount,
		deadLetterCount,
		idlePollCount,
	};
}

export async function getWorkerStatus(pool: pg.Pool): Promise<WorkerStatusSnapshot> {
	const [pending, running, completed, failed, deadLetter, runningJobs] = await Promise.all([
		countJobs(pool, { status: 'pending' }),
		countJobs(pool, { status: 'running' }),
		countJobs(pool, { status: 'completed' }),
		countJobs(pool, { status: 'failed' }),
		countJobs(pool, { status: 'dead_letter' }),
		findJobs(pool, { status: 'running', limit: 500 }),
	]);

	const mappedJobs = runningJobs.map(mapJob);
	const activeWorkers = groupActiveWorkers(mappedJobs);

	return {
		checkedAt: new Date(),
		queue: buildQueueCounts(pending, running, completed, failed, deadLetter),
		runningJobs: mappedJobs,
		activeWorkers,
	};
}

export async function reapStaleJobs(
	pool: pg.Pool,
	options?: WorkerReapOptions,
): Promise<{ count: number; jobIds: string[]; staleBefore: Date }> {
	const staleBefore = options?.staleAfter ?? new Date(Date.now() - DEFAULT_STALE_JOB_AGE_MS);
	const result = await reapRunningJobs(pool, staleBefore);
	return {
		count: result.count,
		jobIds: result.jobIds,
		staleBefore,
	};
}

export { DEFAULT_POLL_INTERVAL_MS, DEFAULT_STALE_JOB_AGE_MS };
