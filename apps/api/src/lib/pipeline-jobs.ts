import type { Job, PipelineRun, PipelineRunSource, Source } from '@mulder/core';
import {
	createPipelineRun,
	enqueueJob,
	findLatestPipelineRunSourceForSource,
	findSourceById,
	getWorkerPool,
	loadConfig,
	PIPELINE_ERROR_CODES,
	PipelineError,
	type PipelineStep,
} from '@mulder/core';
import type { Pool } from 'pg';
import type { PipelineRetryRequest, PipelineRunRequest } from '../routes/pipeline.schemas.js';
import { PIPELINE_STEP_VALUES } from '../routes/pipeline.schemas.js';

type Queryable = Pick<Pool, 'query'>;

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

interface CountRow {
	count: string;
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

async function runInTransaction<T>(pool: Pool, fn: (client: Queryable) => Promise<T>): Promise<T> {
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
			// Ignore rollback failures; the original error is the one we need to surface.
		}
		throw error;
	} finally {
		client.release();
	}
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
function buildRunOptions(input: {
	sourceId: string;
	from?: PipelineStep;
	upTo?: PipelineStep;
	force: boolean;
	retry?: boolean;
	step?: PipelineStep;
}): Record<string, unknown> {
	return input.retry
		? {
				source_id: input.sourceId,
				step: input.step,
				force: input.force,
				retry: true,
			}
		: {
				source_id: input.sourceId,
				from: input.from ?? null,
				up_to: input.upTo ?? null,
				force: input.force,
			};
}

async function requireSource(pool: Queryable, sourceId: string): Promise<Source> {
	const source = await findSourceById(pool as Pool, sourceId);
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

async function assertNoInFlightPipelineJob(pool: Queryable, sourceId: string): Promise<void> {
	const result = await pool.query<CountRow>(
		`
			SELECT COUNT(*) AS count
			FROM jobs
			WHERE type = 'pipeline_run'
				AND status IN ('pending', 'running')
				AND COALESCE(payload->>'sourceId', payload->>'source_id') = $1
		`,
		[sourceId],
	);

	if ((Number.parseInt(result.rows[0]?.count ?? '0', 10) || 0) > 0) {
		throw new PipelineError(
			`Source ${sourceId} already has an accepted pipeline job in progress`,
			PIPELINE_ERROR_CODES.PIPELINE_RETRY_CONFLICT,
			{
				context: { sourceId },
			},
		);
	}
}

async function enqueuePipelineJob(
	pool: Queryable,
	input: {
		sourceId: string;
		runId: string;
		from?: PipelineStep;
		upTo?: PipelineStep;
		tag?: string;
		force: boolean;
	},
): Promise<Job> {
	return await enqueueJob(pool as Pool, {
		type: 'pipeline_run',
		payload: buildJobPayload(input),
		maxAttempts: 3,
	});
}

export async function createPipelineRunJob(input: PipelineRunRequest): Promise<PipelineRunAcceptance> {
	const { pool } = resolveContext();
	return await runInTransaction(pool, async (client) => {
		const source = await requireSource(client, input.source_id);
		const run = await createPipelineRun(client as Pool, {
			tag: input.tag ?? null,
			options: buildRunOptions({
				sourceId: source.id,
				from: input.from,
				upTo: input.up_to,
				force: input.force ?? false,
			}),
		});
		const job = await enqueuePipelineJob(client, {
			sourceId: source.id,
			runId: run.id,
			from: input.from,
			upTo: input.up_to,
			tag: input.tag,
			force: input.force ?? false,
		});

		return { run, job };
	});
}

export async function createPipelineRetryJob(input: PipelineRetryRequest): Promise<PipelineRunAcceptance> {
	const { pool } = resolveContext();
	return await runInTransaction(pool, async (client) => {
		const source = await requireSource(client, input.source_id);
		await assertNoInFlightPipelineJob(client, source.id);
		const latest = await findLatestPipelineRunSourceForSource(client as Pool, source.id);
		const step = deriveRetryStep(assertRetryableSource(source, latest), input.step);
		const run = await createPipelineRun(client as Pool, {
			tag: input.tag ?? null,
			options: buildRunOptions({
				sourceId: source.id,
				force: true,
				retry: true,
				step,
			}),
		});
		const job = await enqueuePipelineJob(client, {
			sourceId: source.id,
			runId: run.id,
			from: step,
			upTo: step,
			tag: input.tag,
			force: true,
		});

		return { run, job };
	});
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
