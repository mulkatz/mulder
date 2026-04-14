import type { Job, PipelineRun, PipelineRunSource, PipelineRunSourceStatus } from '@mulder/core';
import {
	countJobs,
	countPipelineRunSourcesByStatus,
	DATABASE_ERROR_CODES,
	DatabaseError,
	findJobById,
	findJobs,
	findPipelineRunById,
	findPipelineRunSourcesByRunId,
	getWorkerPool,
	loadConfig,
	PIPELINE_ERROR_CODES,
	PipelineError,
} from '@mulder/core';
import type { Pool } from 'pg';
import type { JobDetailResponse, JobListQuery, JobListResponse } from '../routes/jobs.schemas.js';

interface JobStatusContext {
	pool: Pool;
}

interface JobProgress {
	run_id: string;
	run_status: PipelineRun['status'];
	source_counts: Record<PipelineRunSourceStatus, number>;
	sources: Array<{
		source_id: string;
		current_step: string;
		status: PipelineRunSource['status'];
		error_message: string | null;
		updated_at: string;
	}>;
}

function resolveContext(): JobStatusContext {
	const config = loadConfig();
	if (!config.gcp?.cloud_sql) {
		throw new PipelineError(
			'GCP cloud_sql configuration is required for job status routes',
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

function toIsoString(value: Date | null): string | null {
	return value ? value.toISOString() : null;
}

function resolveRunId(payload: Job['payload']): string | null {
	const candidate = payload.runId ?? payload.run_id;
	return typeof candidate === 'string' && candidate.length > 0 ? candidate : null;
}

function mapJobSummary(job: Job): JobListResponse['data'][number] {
	return {
		id: job.id,
		type: job.type,
		status: job.status,
		attempts: job.attempts,
		max_attempts: job.maxAttempts,
		worker_id: job.workerId,
		created_at: job.createdAt.toISOString(),
		started_at: toIsoString(job.startedAt),
		finished_at: toIsoString(job.finishedAt),
		links: {
			self: `/api/jobs/${job.id}`,
		},
	};
}

function mapJobDetail(job: Job): JobDetailResponse['data']['job'] {
	return {
		id: job.id,
		type: job.type,
		status: job.status,
		attempts: job.attempts,
		max_attempts: job.maxAttempts,
		worker_id: job.workerId,
		created_at: job.createdAt.toISOString(),
		started_at: toIsoString(job.startedAt),
		finished_at: toIsoString(job.finishedAt),
		error_log: job.errorLog,
		payload: job.payload,
	};
}

async function resolveProgress(pool: Pool, job: Job): Promise<JobProgress | null> {
	if (job.type !== 'pipeline_run') {
		return null;
	}

	const runId = resolveRunId(job.payload);
	if (!runId) {
		return null;
	}

	const [run, sourceCounts] = await Promise.all([
		findPipelineRunById(pool, runId),
		countPipelineRunSourcesByStatus(pool, runId),
	]);

	if (!run) {
		return null;
	}

	const sources = await findPipelineRunSourcesByRunId(pool, runId);

	return {
		run_id: run.id,
		run_status: run.status,
		source_counts: sourceCounts,
		sources: sources.map((source) => ({
			source_id: source.sourceId,
			current_step: source.currentStep,
			status: source.status,
			error_message: source.errorMessage,
			updated_at: source.updatedAt.toISOString(),
		})),
	};
}

export async function listRecentJobs(input: JobListQuery): Promise<JobListResponse> {
	const { pool } = resolveContext();
	const filter = {
		type: input.type,
		status: input.status,
		workerId: input.worker_id,
	};
	const [count, jobs] = await Promise.all([
		countJobs(pool, filter),
		findJobs(pool, {
			...filter,
			limit: input.limit,
		}),
	]);

	return {
		data: jobs.map(mapJobSummary),
		meta: {
			count,
			limit: input.limit,
		},
	};
}

export async function getJobStatusById(id: string): Promise<JobDetailResponse> {
	const { pool } = resolveContext();
	const job = await findJobById(pool, id);

	if (!job) {
		throw new DatabaseError(`Job not found: ${id}`, DATABASE_ERROR_CODES.DB_NOT_FOUND, {
			context: { id },
		});
	}

	return {
		data: {
			job: mapJobDetail(job),
			progress: await resolveProgress(pool, job),
		},
	};
}

export { mapJobDetail, mapJobSummary };
