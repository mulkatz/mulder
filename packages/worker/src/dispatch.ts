/**
 * Job dispatch layer for the worker runtime.
 *
 * Validates payloads and maps queue job types to the corresponding pipeline
 * or taxonomy execution function.
 *
 * @see docs/specs/68_worker_loop.spec.md §4.1
 * @see docs/functional-spec.md §10.2, §10.4
 */

import type { MulderConfig, Services } from '@mulder/core';
import { createChildLogger } from '@mulder/core';
import { executePipelineRun } from '@mulder/pipeline';
import {
	type SupportedJobType,
	WORKER_ERROR_CODES,
	type WorkerDispatchContext,
	type WorkerDispatchFn,
	WorkerError,
	type WorkerJobEnvelope,
} from './worker.types.js';

export interface DispatchResult {
	jobType: SupportedJobType;
}

export type DispatchResultKind = DispatchResult['jobType'];

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown): string | null {
	return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function asBoolean(value: unknown): boolean | undefined {
	return typeof value === 'boolean' ? value : undefined;
}

function invalidPayload(job: WorkerJobEnvelope, reason: string, context?: Record<string, unknown>): WorkerError {
	return new WorkerError(reason, WORKER_ERROR_CODES.WORKER_INVALID_JOB_PAYLOAD, {
		context: { jobId: job.id, jobType: job.type, ...(context ?? {}) },
	});
}

function parsePipelineRunPayload(job: WorkerJobEnvelope): {
	sourceId: string;
	force?: boolean;
} {
	if (!isRecord(job.payload)) {
		throw invalidPayload(job, `Job ${job.id} payload must be an object`, { field: 'payload' });
	}

	const sourceId = asString(job.payload.sourceId);
	if (!sourceId) {
		throw invalidPayload(job, 'pipeline_run jobs require a non-empty sourceId', { field: 'sourceId' });
	}

	const payload: {
		sourceId: string;
		force?: boolean;
	} = { sourceId };

	const force = asBoolean(job.payload.force);
	if (force !== undefined) {
		payload.force = force;
	}

	return payload;
}

async function dispatchPipelineJob(job: WorkerJobEnvelope, context: WorkerDispatchContext): Promise<void> {
	const log = createChildLogger(context.logger, { jobId: job.id, jobType: job.type });
	const config: MulderConfig = context.config;
	const services: Services = context.services;
	const pool = context.pool;

	if (job.type !== 'pipeline_run') {
		throw new WorkerError(`Unsupported job type "${job.type}"`, WORKER_ERROR_CODES.WORKER_UNKNOWN_JOB_TYPE, {
			context: { jobId: job.id, jobType: job.type },
		});
	}

	const payload = parsePipelineRunPayload(job);
	const result = await executePipelineRun(
		{
			options: {
				sourceIds: [payload.sourceId],
				force: payload.force,
			},
		},
		config,
		services,
		pool,
		log,
	);
	if (result.status !== 'success') {
		throw new WorkerError(
			`pipeline_run job ${job.id} finished with status ${result.status}`,
			WORKER_ERROR_CODES.WORKER_LOOP_FAILED,
			{ context: { jobId: job.id, jobType: job.type, status: result.status } },
		);
	}
}

export const dispatchJob: WorkerDispatchFn = async (job, context) => {
	await dispatchPipelineJob(job, context);
};
