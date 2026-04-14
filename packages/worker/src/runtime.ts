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
	countJobs,
	createChildLogger,
	dequeueJob,
	findJobs,
	markJobCompleted,
	markJobFailed,
	reapRunningJobs,
} from '@mulder/core';
import type pg from 'pg';
import { dispatchJob } from './dispatch.js';
import {
	createWorkerId,
	describeWorkerError,
	type WorkerDispatchContext,
	type WorkerActiveJobSnapshot,
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

function toWorkerJobEnvelope(job: Job): WorkerJobEnvelope {
	return {
		...job,
		type: job.type as WorkerJobEnvelope['type'],
		payload: job.payload as unknown as WorkerJobEnvelope['payload'],
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

	const typedJob = toWorkerJobEnvelope(job);

	const claim = {
		jobId: typedJob.id,
		workerId,
		attempts: typedJob.attempts,
	};
	const jobLog = createChildLogger(workerLog, { jobId: typedJob.id, jobType: typedJob.type });
	const dispatch = context.dispatch ?? dispatchJob;

	jobLog.info({ attempts: typedJob.attempts }, 'Job claimed');

	try {
		await dispatch(typedJob, getWorkerDispatchContext(context, workerId));
		await markJobCompleted(context.pool, claim);
		jobLog.info('Job completed');
		return { state: 'completed', job: typedJob, error: null };
	} catch (error: unknown) {
		const errorLog = describeWorkerError(error);
		const updated = await markJobFailed(context.pool, claim, errorLog);
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
