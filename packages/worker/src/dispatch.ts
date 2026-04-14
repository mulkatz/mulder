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
import {
	executeEmbed,
	executeEnrich,
	executeExtract,
	executeGraph,
	executePipelineRun,
	executeSegment,
	type PipelineRunOptions,
	type PipelineStepName,
} from '@mulder/pipeline';
import {
	type SupportedJobType,
	WORKER_ERROR_CODES,
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

function readStringField(job: WorkerJobEnvelope, primaryKey: string, fallbackKey?: string): string | null {
	if (isRecord(job.payload)) {
		const primary = asString(job.payload[primaryKey]);
		if (primary) {
			return primary;
		}
		if (fallbackKey) {
			return asString(job.payload[fallbackKey]);
		}
	}
	return null;
}

function invalidPayload(job: WorkerJobEnvelope, reason: string, context?: Record<string, unknown>): WorkerError {
	return new WorkerError(reason, WORKER_ERROR_CODES.WORKER_INVALID_JOB_PAYLOAD, {
		context: { jobId: job.id, jobType: job.type, ...(context ?? {}) },
	});
}

function parseSourceStepPayload(job: WorkerJobEnvelope): {
	sourceId: string;
	force?: boolean;
	fallbackOnly?: boolean;
} {
	if (!isRecord(job.payload)) {
		throw invalidPayload(job, `Job ${job.id} payload must be an object`, { field: 'payload' });
	}

	const sourceId = readStringField(job, 'sourceId', 'source_id');
	if (!sourceId) {
		throw invalidPayload(job, `${job.type} jobs require a non-empty sourceId`, { field: 'sourceId' });
	}

	const payload: {
		sourceId: string;
		force?: boolean;
		fallbackOnly?: boolean;
	} = { sourceId };

	const force = asBoolean(job.payload.force);
	if (force !== undefined) {
		payload.force = force;
	}

	const fallbackOnly = asBoolean(job.payload.fallbackOnly);
	if (fallbackOnly !== undefined) {
		payload.fallbackOnly = fallbackOnly;
	}

	return payload;
}

function parseStoryStepPayload(job: WorkerJobEnvelope): {
	storyId: string;
	force?: boolean;
} {
	if (!isRecord(job.payload)) {
		throw invalidPayload(job, `Job ${job.id} payload must be an object`, { field: 'payload' });
	}

	const storyId = readStringField(job, 'storyId', 'story_id');
	if (!storyId) {
		throw invalidPayload(job, `${job.type} jobs require a non-empty storyId`, { field: 'storyId' });
	}

	const payload: {
		storyId: string;
		force?: boolean;
	} = { storyId };

	const force = asBoolean(job.payload.force);
	if (force !== undefined) {
		payload.force = force;
	}

	return payload;
}

function isPipelineStep(value: string): value is PipelineStepName {
	return value === 'extract' || value === 'segment' || value === 'enrich' || value === 'embed' || value === 'graph';
}

function parsePipelineRunPayload(job: WorkerJobEnvelope): {
	sourceId: string;
	runId?: string;
	from?: PipelineStepName;
	upTo?: PipelineStepName;
	tag?: string;
	force?: boolean;
} {
	if (!isRecord(job.payload)) {
		throw invalidPayload(job, `Job ${job.id} payload must be an object`, { field: 'payload' });
	}

	const sourceId = readStringField(job, 'sourceId', 'source_id');
	if (!sourceId) {
		throw invalidPayload(job, `pipeline_run jobs require a non-empty sourceId`, { field: 'sourceId' });
	}

	const payload: {
		sourceId: string;
		runId?: string;
		from?: PipelineStepName;
		upTo?: PipelineStepName;
		tag?: string;
		force?: boolean;
	} = { sourceId };

	const runId = readStringField(job, 'runId', 'run_id');
	if (runId) {
		payload.runId = runId;
	}

	const from = readStringField(job, 'from');
	if (from) {
		if (!isPipelineStep(from)) {
			throw invalidPayload(job, `pipeline_run jobs require a valid from step`, { field: 'from', value: from });
		}
		payload.from = from;
	}

	const upTo = readStringField(job, 'upTo', 'up_to');
	if (upTo) {
		if (!isPipelineStep(upTo)) {
			throw invalidPayload(job, `pipeline_run jobs require a valid upTo step`, { field: 'upTo', value: upTo });
		}
		payload.upTo = upTo;
	}

	const tag = readStringField(job, 'tag');
	if (tag) {
		payload.tag = tag;
	}

	const force = asBoolean(job.payload.force);
	if (force !== undefined) {
		payload.force = force;
	}

	return payload;
}

function assertStepSucceeded(job: WorkerJobEnvelope, stepName: string, status: string): void {
	if (status === 'success') {
		return;
	}

	throw new WorkerError(
		`${stepName} job ${job.id} finished with status ${status}`,
		WORKER_ERROR_CODES.WORKER_LOOP_FAILED,
		{ context: { jobId: job.id, jobType: job.type, status } },
	);
}

function assertPipelineRunCompleted(job: WorkerJobEnvelope, status: string): void {
	if (status === 'success' || status === 'partial') {
		return;
	}

	throw new WorkerError(`pipeline_run job ${job.id} finished with status ${status}`, WORKER_ERROR_CODES.WORKER_LOOP_FAILED, {
		context: { jobId: job.id, jobType: job.type, status },
	});
}

export const dispatchJob: WorkerDispatchFn = async (job, context) => {
	const log = createChildLogger(context.logger, { jobId: job.id, jobType: job.type });
	const config: MulderConfig = context.config;
	const services: Services = context.services;
	const pool = context.pool;

	switch (job.type) {
		case 'extract': {
			const payload = parseSourceStepPayload(job);
			const result = await executeExtract(payload, config, services, pool, log);
			assertStepSucceeded(job, 'extract', result.status);
			return;
		}
		case 'segment': {
			const payload = parseSourceStepPayload(job);
			const result = await executeSegment(payload, config, services, pool, log);
			assertStepSucceeded(job, 'segment', result.status);
			return;
		}
		case 'enrich': {
			const payload = parseStoryStepPayload(job);
			const result = await executeEnrich(payload, config, services, pool, log);
			assertStepSucceeded(job, 'enrich', result.status);
			return;
		}
		case 'embed': {
			const payload = parseStoryStepPayload(job);
			const result = await executeEmbed(payload, config, services, pool, log);
			assertStepSucceeded(job, 'embed', result.status);
			return;
		}
		case 'graph': {
			const payload = parseStoryStepPayload(job);
			const result = await executeGraph(payload, config, services, pool, log);
			assertStepSucceeded(job, 'graph', result.status);
			return;
		}
		case 'pipeline_run': {
			const payload = parsePipelineRunPayload(job);
			if (!payload.runId) {
				const result = await executeExtract(
					{ sourceId: payload.sourceId, force: payload.force ?? false },
					config,
					services,
					pool,
					log,
				);
				assertStepSucceeded(job, 'pipeline_run', result.status);
				return;
			}

			const runOptions: PipelineRunOptions = {
				sourceIds: [payload.sourceId],
				force: payload.force ?? false,
			};
			if (payload.runId) {
				runOptions.runId = payload.runId;
			}
			if (payload.from) {
				runOptions.from = payload.from;
			}
			if (payload.upTo) {
				runOptions.upTo = payload.upTo;
			}
			if (payload.tag) {
				runOptions.tag = payload.tag;
			}
			const result = await executePipelineRun({ options: runOptions }, config, services, pool, log);
			assertPipelineRunCompleted(job, result.status);
			return;
		}
		default:
			throw new WorkerError(`Unsupported job type "${job.type}"`, WORKER_ERROR_CODES.WORKER_UNKNOWN_JOB_TYPE, {
				context: { jobId: job.id, jobType: job.type },
			});
	}
};
