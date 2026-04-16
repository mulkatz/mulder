import type { BudgetablePipelineStep, Job, MulderConfig, PipelineRun, PipelineRunSource, Source } from '@mulder/core';
import {
	budgetMonthStart,
	createMonthlyBudgetReservation,
	createPipelineRun,
	enqueueJob,
	estimateBudgetForSourceRun,
	findLatestMonthlyBudgetReservationForSource,
	findLatestPipelineRunSourceForSource,
	findSourceById,
	getWorkerPool,
	loadConfig,
	PIPELINE_ERROR_CODES,
	PipelineError,
	type PipelineStep,
	secondsUntilNextBudgetMonth,
	summarizeMonthlyBudgetReservations,
} from '@mulder/core';
import type { Pool, PoolClient } from 'pg';
import type { PipelineRetryRequest, PipelineRunRequest } from '../routes/pipeline.schemas.js';
import { PIPELINE_STEP_VALUES } from '../routes/pipeline.schemas.js';

type Queryable = Pool | PoolClient;

type PipelineJobPayload = {
	sourceId: string;
	runId: string;
	from?: PipelineStep;
	upTo?: PipelineStep;
	tag?: string;
	force: boolean;
};

interface PipelineJobContext {
	config: MulderConfig;
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
		config,
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

function derivePlannedSteps(from?: PipelineStep, upTo?: PipelineStep): BudgetablePipelineStep[] {
	const fromIndex = from ? PIPELINE_STEP_VALUES.indexOf(from) : 0;
	const upToIndex = upTo ? PIPELINE_STEP_VALUES.indexOf(upTo) : PIPELINE_STEP_VALUES.length - 1;

	return PIPELINE_STEP_VALUES.slice(fromIndex, upToIndex + 1) as BudgetablePipelineStep[];
}

async function requireSource(pool: Queryable, sourceId: string): Promise<Source> {
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

async function lockBudgetMonth(pool: Queryable, budgetMonth: string): Promise<void> {
	await pool.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`monthly-budget:${budgetMonth}`]);
}

async function reserveBudgetForAcceptedRun(
	pool: Queryable,
	context: PipelineJobContext,
	input: {
		source: Source;
		run: PipelineRun;
		job: Job;
		plannedSteps: BudgetablePipelineStep[];
		force: boolean;
		kind: 'run' | 'retry';
		retryOfReservationId?: string | null;
	},
): Promise<void> {
	if (!context.config.api.budget.enabled) {
		return;
	}

	const budgetMonth = budgetMonthStart(new Date());
	await lockBudgetMonth(pool, budgetMonth);

	const estimate = estimateBudgetForSourceRun({
		source: input.source,
		plannedSteps: input.plannedSteps,
		budget: context.config.api.budget,
		extraction: context.config.extraction,
		force: input.force,
	});
	const summary = await summarizeMonthlyBudgetReservations(pool, budgetMonth);
	const neededUsd = estimate.totalUsd;
	const usedUsd = summary.reservedUsd + summary.committedUsd;
	const nextUsedUsd = Number((usedUsd + neededUsd).toFixed(4));

	if (nextUsedUsd > context.config.api.budget.monthly_limit_usd) {
		throw new PipelineError(
			`Monthly API budget exceeded for ${budgetMonth}`,
			PIPELINE_ERROR_CODES.PIPELINE_BUDGET_EXCEEDED,
			{
				context: {
					budget_month: budgetMonth,
					limit_usd: context.config.api.budget.monthly_limit_usd,
					reserved_usd: summary.reservedUsd,
					committed_usd: summary.committedUsd,
					remaining_usd: Number((context.config.api.budget.monthly_limit_usd - usedUsd).toFixed(4)),
					needed_usd: neededUsd,
					retry_after_seconds: secondsUntilNextBudgetMonth(new Date()),
				},
			},
		);
	}

	await createMonthlyBudgetReservation(pool, {
		budgetMonth,
		sourceId: input.source.id,
		runId: input.run.id,
		jobId: input.job.id,
		retryOfReservationId: input.retryOfReservationId ?? null,
		plannedSteps: input.plannedSteps,
		reservedEstimatedUsd: neededUsd,
		metadata: {
			kind: input.kind,
			force: input.force,
			breakdown: estimate.byStep,
		},
	});
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
	return await enqueueJob(pool, {
		type: 'pipeline_run',
		payload: buildJobPayload(input),
		maxAttempts: 3,
	});
}

export async function createPipelineRunJob(input: PipelineRunRequest): Promise<PipelineRunAcceptance> {
	const context = resolveContext();
	return await runInTransaction(context.pool, async (client) => {
		const source = await requireSource(client, input.source_id);
		await assertNoInFlightPipelineJob(client, source.id);
		const run = await createPipelineRun(client, {
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
		await reserveBudgetForAcceptedRun(client, context, {
			source,
			run,
			job,
			plannedSteps: derivePlannedSteps(input.from, input.up_to),
			force: input.force ?? false,
			kind: 'run',
		});

		return { run, job };
	});
}

export async function createPipelineRetryJob(input: PipelineRetryRequest): Promise<PipelineRunAcceptance> {
	const context = resolveContext();
	return await runInTransaction(context.pool, async (client) => {
		const source = await requireSource(client, input.source_id);
		await assertNoInFlightPipelineJob(client, source.id);
		const latest = await findLatestPipelineRunSourceForSource(client, source.id);
		const step = deriveRetryStep(assertRetryableSource(source, latest), input.step);
		const previousReservation = await findLatestMonthlyBudgetReservationForSource(client, source.id);
		const run = await createPipelineRun(client, {
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
		await reserveBudgetForAcceptedRun(client, context, {
			source,
			run,
			job,
			plannedSteps: [step],
			force: true,
			kind: 'retry',
			retryOfReservationId: previousReservation?.id ?? null,
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
