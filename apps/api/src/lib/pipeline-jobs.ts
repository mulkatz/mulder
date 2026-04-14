import type { PipelineRun, PipelineRunSource, Source } from '@mulder/core';
import {
	createPipelineRun,
	enqueueJob,
	findLatestPipelineRunSourceForSource,
	findSourceById,
	getWorkerPool,
	type Job,
	loadConfig,
	PIPELINE_ERROR_CODES,
	PipelineError,
	type PipelineStep,
} from '@mulder/core';
import type { Pool } from 'pg';
import type { PipelineRetryRequest, PipelineRunRequest } from '../routes/pipeline.schemas.js';
import { PIPELINE_STEP_VALUES } from '../routes/pipeline.schemas.js';

type PipelineJobPayload = {
	sourceId: string;
	runId: string;
	from?: PipelineStep;
	upTo?: PipelineStep;
	tag?: string;
	force: boolean;
};

interface PipelineJobContext {
	pool: Pool;
}

interface PipelineRunAcceptance {
	run: PipelineRun;
	job: Job;
}

const PIPELINE_STEP_SET = new Set<string>(PIPELINE_STEP_VALUES);

function isPipelineStep(value: string): value is PipelineStep {
	return PIPELINE_STEP_SET.has(value);
}

function resolveContext(): PipelineJobContext {
	const config = loadConfig();
	if (!config.gcp?.cloud_sql) {
		throw new PipelineError(
			'GCP cloud_sql configuration is required for pipeline routes',
			PIPELINE_ERROR_CODES.PIPELINE_WRONG_STATUS,
			{
				context: { configPath: process.env.MULDER_CONFIG ?? 'mulder.config.yaml' },
			},
		);
	}

	return {
		pool: getWorkerPool(config.gcp.cloud_sql),
	};
}

function buildAcceptedJob(run: PipelineRun, job: Job): PipelineRunAcceptance {
	return { run, job };
}

function buildJobPayload(input: {
	sourceId: string;
	runId: string;
	from?: PipelineStep;
	upTo?: PipelineStep;
	tag?: string;
	force: boolean;
}): PipelineJobPayload {
	return {
		sourceId: input.sourceId,
		runId: input.runId,
		from: input.from,
		upTo: input.upTo,
		tag: input.tag,
		force: input.force,
	};
}

async function requireSource(pool: Pool, sourceId: string): Promise<Source> {
	const source = await findSourceById(pool, sourceId);
	if (!source) {
		throw new PipelineError(`Source not found: ${sourceId}`, PIPELINE_ERROR_CODES.PIPELINE_SOURCE_NOT_FOUND, {
			context: { sourceId },
		});
	}
	return source;
}

function assertRetryableSource(source: Source, latest: PipelineRunSource | null): PipelineRunSource {
	if (!latest || latest.status !== 'failed') {
		throw new PipelineError(
			`Source ${source.id} does not have a failed pipeline step to retry`,
			PIPELINE_ERROR_CODES.PIPELINE_RETRY_CONFLICT,
			{
				context: {
					sourceId: source.id,
					latestStatus: latest?.status ?? null,
				},
			},
		);
	}

	return latest;
}

function deriveRetryStep(latest: PipelineRunSource, explicitStep?: PipelineStep): PipelineStep {
	if (explicitStep) {
		return explicitStep;
	}

	if (!isPipelineStep(latest.currentStep)) {
		throw new PipelineError(
			`Latest failed step "${latest.currentStep}" is not retryable`,
			PIPELINE_ERROR_CODES.PIPELINE_RETRY_CONFLICT,
			{
				context: {
					currentStep: latest.currentStep,
					runId: latest.runId,
					sourceId: latest.sourceId,
				},
			},
		);
	}

	return latest.currentStep;
}

async function enqueuePipelineJob(
	pool: Pool,
	input: {
		sourceId: string;
		runId: string;
		from?: PipelineStep;
		upTo?: PipelineStep;
		tag?: string;
		force: boolean;
	},
): Promise<Job> {
	return await enqueueJob(pool, {
		type: 'pipeline_run',
		payload: buildJobPayload(input),
	});
}

export async function createPipelineRunJob(input: PipelineRunRequest): Promise<PipelineRunAcceptance> {
	const { pool } = resolveContext();
	const source = await requireSource(pool, input.source_id);
	const run = await createPipelineRun(pool, {
		tag: input.tag ?? null,
		options: {
			source_id: source.id,
			from: input.from ?? null,
			up_to: input.up_to ?? null,
			force: input.force ?? false,
		},
	});
	const job = await enqueuePipelineJob(pool, {
		sourceId: source.id,
		runId: run.id,
		from: input.from,
		upTo: input.up_to,
		tag: input.tag,
		force: input.force ?? false,
	});

	return buildAcceptedJob(run, job);
}

export async function createPipelineRetryJob(input: PipelineRetryRequest): Promise<PipelineRunAcceptance> {
	const { pool } = resolveContext();
	const source = await requireSource(pool, input.source_id);
	const latest = assertRetryableSource(source, await findLatestPipelineRunSourceForSource(pool, source.id));
	const step = deriveRetryStep(latest, input.step);
	const run = await createPipelineRun(pool, {
		tag: input.tag ?? null,
		options: {
			source_id: source.id,
			step,
			force: true,
			retry: true,
		},
	});
	const job = await enqueuePipelineJob(pool, {
		sourceId: source.id,
		runId: run.id,
		from: step,
		upTo: step,
		tag: input.tag,
		force: true,
	});

	return buildAcceptedJob(run, job);
}

export function buildPipelineAcceptedResponse(
	run: PipelineRun,
	job: Job,
): {
	data: {
		job_id: string;
		status: 'pending';
		run_id: string;
	};
	links: {
		status: string;
	};
} {
	return {
		data: {
			job_id: job.id,
			status: 'pending',
			run_id: run.id,
		},
		links: {
			status: `/api/jobs/${job.id}`,
		},
	};
}
