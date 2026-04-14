import type { Job, PipelineRun, PipelineRunSource, Source } from '@mulder/core';
import { getWorkerPool, loadConfig, PIPELINE_ERROR_CODES, PipelineError, type PipelineStep } from '@mulder/core';
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

interface SourceRow {
	id: string;
	filename: string;
	storage_path: string;
	file_hash: string;
	page_count: number | null;
	has_native_text: boolean;
	native_text_ratio: number;
	status: Source['status'];
	reliability_score: number | null;
	tags: string[] | null;
	metadata: Record<string, unknown>;
	created_at: Date;
	updated_at: Date;
}

interface PipelineRunRow {
	id: string;
	tag: string | null;
	options: Record<string, unknown> | string | null;
	status: PipelineRun['status'];
	created_at: Date;
	finished_at: Date | null;
}

interface JobRow {
	id: string;
	type: string;
	payload: Record<string, unknown> | string;
	status: Job['status'];
	attempts: number;
	max_attempts: number;
	error_log: string | null;
	worker_id: string | null;
	created_at: Date;
	started_at: Date | null;
	finished_at: Date | null;
}

interface LatestPipelineRunSourceRow {
	run_id: string;
	source_id: string;
	current_step: string;
	status: PipelineRunSource['status'];
	error_message: string | null;
	updated_at: Date;
}

const PIPELINE_STEP_SET = new Set<string>(PIPELINE_STEP_VALUES);

function isPipelineStep(value: string): value is PipelineStep {
	return PIPELINE_STEP_SET.has(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
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

function parseObject(value: Record<string, unknown> | string | null): Record<string, unknown> {
	if (value === null || value === undefined) {
		return {};
	}
	if (typeof value === 'string') {
		try {
			const parsed: unknown = JSON.parse(value);
			if (isRecord(parsed)) {
				return parsed;
			}
		} catch {
			// Fall back to an empty object when the column stores unexpected JSON.
		}
		return {};
	}
	return value;
}

function mapSourceRow(row: SourceRow): Source {
	return {
		id: row.id,
		filename: row.filename,
		storagePath: row.storage_path,
		fileHash: row.file_hash,
		pageCount: row.page_count,
		hasNativeText: row.has_native_text,
		nativeTextRatio: row.native_text_ratio,
		status: row.status,
		reliabilityScore: row.reliability_score,
		tags: row.tags ?? [],
		metadata: row.metadata ?? {},
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function mapPipelineRunRow(row: PipelineRunRow): PipelineRun {
	return {
		id: row.id,
		tag: row.tag,
		options: parseObject(row.options),
		status: row.status,
		createdAt: row.created_at,
		finishedAt: row.finished_at,
	};
}

function mapJobRow(row: JobRow): Job {
	return {
		id: row.id,
		type: row.type,
		payload: parseObject(row.payload),
		status: row.status,
		attempts: row.attempts,
		maxAttempts: row.max_attempts,
		errorLog: row.error_log,
		workerId: row.worker_id,
		createdAt: row.created_at,
		startedAt: row.started_at,
		finishedAt: row.finished_at,
	};
}

async function requireSource(pool: Queryable, sourceId: string): Promise<Source> {
	const result = await pool.query<SourceRow>(
		`
			SELECT
				id,
				filename,
				storage_path,
				file_hash,
				page_count,
				has_native_text,
				native_text_ratio,
				status,
				reliability_score,
				tags,
				metadata,
				created_at,
				updated_at
			FROM sources
			WHERE id = $1
		`,
		[sourceId],
	);

	const row = result.rows[0];
	if (!row) {
		throw new PipelineError(`Source not found: ${sourceId}`, PIPELINE_ERROR_CODES.PIPELINE_SOURCE_NOT_FOUND, {
			context: { sourceId },
		});
	}
	return mapSourceRow(row);
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
	const result = await pool.query<JobRow>(
		`
			INSERT INTO jobs (type, payload, max_attempts)
			VALUES ($1, $2, $3)
			RETURNING *
		`,
		['pipeline_run', JSON.stringify(buildJobPayload(input)), 3],
	);

	return mapJobRow(result.rows[0]);
}

export async function createPipelineRunJob(input: PipelineRunRequest): Promise<PipelineRunAcceptance> {
	const { pool } = resolveContext();
	return await runInTransaction(pool, async (client) => {
		const source = await requireSource(client, input.source_id);
		const run = mapPipelineRunRow(
			(
				await client.query<PipelineRunRow>(
					`
						INSERT INTO pipeline_runs (tag, options, status)
						VALUES ($1, $2, 'running')
						RETURNING *
					`,
					[
						input.tag ?? null,
						JSON.stringify({
							source_id: source.id,
							from: input.from ?? null,
							up_to: input.up_to ?? null,
							force: input.force ?? false,
						}),
					],
				)
			).rows[0],
		);
		const job = await enqueuePipelineJob(client, {
			sourceId: source.id,
			runId: run.id,
			from: input.from,
			upTo: input.up_to,
			tag: input.tag,
			force: input.force ?? false,
		});

		return buildAcceptedJob(run, job);
	});
}

export async function createPipelineRetryJob(input: PipelineRetryRequest): Promise<PipelineRunAcceptance> {
	const { pool } = resolveContext();
	return await runInTransaction(pool, async (client) => {
		const source = await requireSource(client, input.source_id);
		const latestResult = await client.query<LatestPipelineRunSourceRow>(
			`
				SELECT
					prs.run_id,
					prs.source_id,
					prs.current_step,
					prs.status,
					prs.error_message,
					prs.updated_at
				FROM pipeline_run_sources prs
				JOIN pipeline_runs pr ON pr.id = prs.run_id
				WHERE prs.source_id = $1
				ORDER BY pr.created_at DESC, prs.updated_at DESC
				LIMIT 1
			`,
			[source.id],
		);
		const latestRow = latestResult.rows[0];
		const latest = latestRow
			? {
					runId: latestRow.run_id,
					sourceId: latestRow.source_id,
					currentStep: latestRow.current_step,
					status: latestRow.status,
					errorMessage: latestRow.error_message,
					updatedAt: latestRow.updated_at,
				}
			: null;
		const step = deriveRetryStep(assertRetryableSource(source, latest), input.step);
		const run = mapPipelineRunRow(
			(
				await client.query<PipelineRunRow>(
					`
						INSERT INTO pipeline_runs (tag, options, status)
						VALUES ($1, $2, 'running')
						RETURNING *
					`,
					[
						input.tag ?? null,
						JSON.stringify({
							source_id: source.id,
							step,
							force: true,
							retry: true,
						}),
					],
				)
			).rows[0],
		);
		const job = await enqueuePipelineJob(client, {
			sourceId: source.id,
			runId: run.id,
			from: step,
			upTo: step,
			tag: input.tag,
			force: true,
		});

		return buildAcceptedJob(run, job);
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
