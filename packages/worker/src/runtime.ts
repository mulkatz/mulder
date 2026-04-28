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
import type { Logger, MulderConfig, Services } from '@mulder/core';
import {
	completedStepsFromProgress,
	countJobs,
	createChildLogger,
	dequeueJob,
	enqueueJob,
	finalizeBudgetReservation,
	finalizeMonthlyBudgetReservation,
	finalizePipelineRun,
	findJobs,
	findMonthlyBudgetReservationByRunId,
	findPipelineRunSourcesByRunId,
	findSourceById,
	markJobCompleted,
	markJobFailed,
	reapRunningJobs,
	upsertPipelineRunSource,
} from '@mulder/core';
import type pg from 'pg';
import { dispatchJob } from './dispatch.js';
import {
	createWorkerId,
	describeWorkerError,
	parseWorkerJobEnvelope,
	type WorkerActiveJobSnapshot,
	type WorkerDispatchContext,
	type WorkerDispatchFn,
	type WorkerJobEnvelope,
	type WorkerJobStatusSnapshot,
	type WorkerPipelineStepName,
	type WorkerQueueCounts,
	type WorkerReapOptions,
	type WorkerRuntimeOptions,
	type WorkerRuntimeResult,
	type WorkerStatusSnapshot,
} from './worker.types.js';

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_STALE_JOB_AGE_MS = 2 * 60 * 60 * 1000;
const STEP_ORDER = [
	'extract',
	'segment',
	'enrich',
	'embed',
	'graph',
] as const satisfies readonly WorkerPipelineStepName[];

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

async function runInTransaction<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
	const client = await pool.connect();
	try {
		await client.query('BEGIN');
		const result = await fn(client);
		await client.query('COMMIT');
		return result;
	} catch (error) {
		try {
			await client.query('ROLLBACK');
		} catch {
			// Preserve the original failure if rollback itself fails.
		}
		throw error;
	} finally {
		client.release();
	}
}

function isStepJob(job: WorkerJobEnvelope | null): job is WorkerJobEnvelope<WorkerPipelineStepName> {
	return Boolean(job && STEP_ORDER.some((step) => step === job.type));
}

function nextStepAfter(step: WorkerPipelineStepName, upTo?: WorkerPipelineStepName): WorkerPipelineStepName | null {
	const currentIndex = STEP_ORDER.indexOf(step);
	const terminalIndex = upTo ? STEP_ORDER.indexOf(upTo) : STEP_ORDER.length - 1;
	if (currentIndex < 0 || terminalIndex < 0 || currentIndex >= terminalIndex) {
		return null;
	}
	return STEP_ORDER[currentIndex + 1] ?? null;
}

function getSourceScopedRunPayload(job: WorkerJobEnvelope<WorkerPipelineStepName>): {
	sourceId: string;
	runId: string;
	upTo?: WorkerPipelineStepName;
	tag?: string;
	force: boolean;
	fallbackOnly?: boolean;
} | null {
	const { payload } = job;
	if (!('sourceId' in payload) || !payload.sourceId || !payload.runId) {
		return null;
	}

	return {
		sourceId: payload.sourceId,
		runId: payload.runId,
		upTo: payload.upTo,
		tag: payload.tag,
		force: payload.force ?? false,
		...('fallbackOnly' in payload && payload.fallbackOnly !== undefined ? { fallbackOnly: payload.fallbackOnly } : {}),
	};
}

async function reconcileBudgetReservationAfterJobFailure(
	context: WorkerRuntimeContext,
	job: WorkerJobEnvelope | null,
): Promise<void> {
	if (job?.type !== 'pipeline_run') {
		return;
	}

	const runId = job.payload.runId;
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

async function reconcileBudgetReservationForRun(
	context: WorkerRuntimeContext,
	pool: pg.Pool | pg.PoolClient,
	runId: string,
	reason: string,
): Promise<void> {
	const reservation = await findMonthlyBudgetReservationByRunId(pool, runId);
	if (!reservation) {
		return;
	}

	const source = await findSourceById(pool, reservation.sourceId);
	if (!source) {
		await finalizeMonthlyBudgetReservation(pool, {
			runId,
			status: 'released',
			committedUsd: 0,
			releasedUsd: reservation.reservedEstimatedUsd,
			metadata: { reason: 'source_missing_after_step_job' },
		});
		return;
	}

	const progressRows = await findPipelineRunSourcesByRunId(pool, runId);
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

	await finalizeMonthlyBudgetReservation(pool, {
		runId,
		status: finalization.status,
		committedUsd: finalization.committedUsd,
		releasedUsd: finalization.releasedUsd,
		metadata: {
			progress_status: progress?.status ?? null,
			current_step: progress?.currentStep ?? null,
			reason,
		},
	});
}

async function chainStepJobAfterSuccess(
	pool: pg.PoolClient,
	context: WorkerRuntimeContext,
	job: WorkerJobEnvelope | null,
): Promise<void> {
	if (!isStepJob(job)) {
		return;
	}

	const sourceRunPayload = getSourceScopedRunPayload(job);
	if (!sourceRunPayload) {
		return;
	}

	const nextStep = nextStepAfter(job.type, sourceRunPayload.upTo);
	await upsertPipelineRunSource(pool, {
		runId: sourceRunPayload.runId,
		sourceId: sourceRunPayload.sourceId,
		currentStep: job.type,
		status: nextStep ? 'processing' : 'completed',
	});

	if (nextStep) {
		await enqueueJob(pool, {
			type: nextStep,
			payload: {
				sourceId: sourceRunPayload.sourceId,
				runId: sourceRunPayload.runId,
				upTo: sourceRunPayload.upTo,
				tag: sourceRunPayload.tag,
				force: sourceRunPayload.force,
			},
			maxAttempts: job.maxAttempts,
		});
		return;
	}

	await finalizePipelineRun(pool, sourceRunPayload.runId, 'completed');
	await reconcileBudgetReservationForRun(context, pool, sourceRunPayload.runId, 'step_chain_completed');
}

async function markStepRunFailedIfTerminal(
	pool: pg.PoolClient,
	context: WorkerRuntimeContext,
	job: WorkerJobEnvelope | null,
	errorLog: string,
): Promise<void> {
	if (!isStepJob(job)) {
		return;
	}

	const sourceRunPayload = getSourceScopedRunPayload(job);
	if (!sourceRunPayload) {
		return;
	}

	await upsertPipelineRunSource(pool, {
		runId: sourceRunPayload.runId,
		sourceId: sourceRunPayload.sourceId,
		currentStep: job.type,
		status: 'failed',
		errorMessage: errorLog,
	});
	await finalizePipelineRun(pool, sourceRunPayload.runId, 'failed');
	await reconcileBudgetReservationForRun(context, pool, sourceRunPayload.runId, 'step_job_dead_letter');
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
		typedJob = parseWorkerJobEnvelope(job);
		const completionPayload = await dispatch(typedJob, getWorkerDispatchContext(context, workerId));
		await runInTransaction(context.pool, async (client) => {
			await markJobCompleted(client, claim, isRecord(completionPayload) ? completionPayload : undefined);
			await chainStepJobAfterSuccess(client, context, typedJob);
		});
		jobLog.info('Job completed');
		return { state: 'completed', job: typedJob, error: null };
	} catch (error: unknown) {
		const errorLog = describeWorkerError(error);
		let updated: Awaited<ReturnType<typeof markJobFailed>> | null = null;
		try {
			updated = await runInTransaction(context.pool, async (client) => {
				const failedJob = await markJobFailed(client, claim, errorLog);
				if (failedJob.status === 'dead_letter') {
					await markStepRunFailedIfTerminal(client, context, typedJob, errorLog);
				}
				return failedJob;
			});
		} catch (markError) {
			jobLog.error({ err: markError, originalErr: error }, 'Job failure could not be persisted');
			throw error;
		}
		if (updated.status === 'dead_letter') {
			await reconcileBudgetReservationAfterJobFailure(context, typedJob).catch(() => undefined);
		}
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
