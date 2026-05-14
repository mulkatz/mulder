import type {
	Job,
	JobStatus,
	MulderConfig,
	PipelineRun,
	PipelineRunSource,
	PipelineRunSourceStatus,
} from '@mulder/core';
import {
	countJobs,
	countPipelineRunSourcesByStatus,
	DATABASE_ERROR_CODES,
	DatabaseError,
	findJobById,
	findJobs,
	findPipelineRunById,
	findPipelineRunSourcesByRunId,
	findSourceById,
	getWorkerPool,
	loadConfig,
	MulderError,
	PIPELINE_ERROR_CODES,
	PipelineError,
} from '@mulder/core';
import type { Pool } from 'pg';
import type { AuthPrincipal } from '../middleware/auth.js';
import type { JobDetailResponse, JobListQuery, JobListResponse } from '../routes/jobs.schemas.js';
import { allowedSensitivity, isOperatorPrincipal, resolveReadMaxSensitivity } from './api-runtime.js';

interface JobStatusContext {
	config: MulderConfig;
	pool: Pool;
}

interface JobRouteOptions {
	authPrincipal?: AuthPrincipal;
}

interface JobRow {
	id: string;
	type: string;
	payload: Job['payload'] | string;
	status: JobStatus;
	attempts: number;
	max_attempts: number;
	error_log: string | null;
	worker_id: string | null;
	created_at: Date;
	started_at: Date | null;
	finished_at: Date | null;
}

interface JobProgress {
	run_id: string;
	run_status: PipelineRun['status'];
	source_counts: Record<PipelineRunSourceStatus, number>;
	sources: Array<{
		source_id: string;
		source: {
			id: string;
			filename: string;
			status: string;
		} | null;
		current_step: string;
		status: PipelineRunSource['status'];
		error_message: string | null;
		updated_at: string;
	}>;
}

type JobSubject = JobListResponse['data'][number]['subject'];
type SourceSummary = NonNullable<JobProgress['sources'][number]['source']>;

interface SourceSummaryRow {
	id: string;
	filename: string;
	status: string;
}

interface RunSourceSummaryRow extends SourceSummaryRow {
	run_id: string;
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

	return { config, pool: getWorkerPool(config.gcp.cloud_sql) };
}

function toIsoString(value: Date | null): string | null {
	return value ? value.toISOString() : null;
}

function resolveRunId(payload: Job['payload']): string | null {
	const candidate = payload.runId ?? payload.run_id;
	return typeof candidate === 'string' && candidate.length > 0 ? candidate : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJobPayload(payload: Job['payload'] | string): Job['payload'] {
	if (typeof payload !== 'string') {
		return payload;
	}
	try {
		const parsed: unknown = JSON.parse(payload);
		return isPlainObject(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

function mapJobRow(row: JobRow): Job {
	return {
		id: row.id,
		type: row.type,
		payload: parseJobPayload(row.payload),
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

function readPayloadString(payload: Job['payload'], ...keys: string[]): string | null {
	for (const key of keys) {
		const value = payload[key];
		if (typeof value === 'string' && value.trim().length > 0) {
			return value.trim();
		}
	}
	return null;
}

function resolveSourceId(payload: Job['payload']): string | null {
	return readPayloadString(payload, 'sourceId', 'source_id');
}

function resolveSubmittedByUserId(payload: Job['payload']): string | null {
	const submittedBy = payload.submittedBy ?? payload.submitted_by;
	if (!isPlainObject(submittedBy)) {
		return null;
	}
	const userId = submittedBy.userId ?? submittedBy.user_id;
	return typeof userId === 'string' && userId.trim().length > 0 ? userId.trim() : null;
}

function defaultJobSubject(job: Job): JobSubject {
	return {
		kind: 'job',
		label: job.type,
	};
}

function mapSourceSummary(source: SourceSummaryRow): SourceSummary {
	return {
		id: source.id,
		filename: source.filename,
		status: source.status,
	};
}

async function findVisibleSourceSummaryMap(
	pool: Pool,
	sourceIds: string[],
	maxSensitivityLevel?: ReturnType<typeof resolveReadMaxSensitivity>,
): Promise<Map<string, SourceSummary>> {
	const uniqueSourceIds = Array.from(new Set(sourceIds));
	if (uniqueSourceIds.length === 0) {
		return new Map();
	}

	const params: unknown[] = [uniqueSourceIds];
	const conditions = ['id = ANY($1::uuid[])', "deletion_status NOT IN ('soft_deleted', 'purging', 'purged')"];
	const allowed = allowedSensitivity(maxSensitivityLevel);
	if (allowed) {
		params.push(allowed);
		conditions.push(`sensitivity_level = ANY($${params.length})`);
	}

	const result = await pool.query<SourceSummaryRow>(
		`
			SELECT id::text AS id, filename, status
			FROM sources
			WHERE ${conditions.join(' AND ')}
		`,
		params,
	);

	return new Map(result.rows.map((row) => [row.id, mapSourceSummary(row)]));
}

async function findVisibleRunSourceSummaryMap(
	pool: Pool,
	runIds: string[],
	options?: { maxSensitivityLevel?: ReturnType<typeof resolveReadMaxSensitivity> },
): Promise<Map<string, SourceSummary[]>> {
	const uniqueRunIds = Array.from(new Set(runIds));
	if (uniqueRunIds.length === 0) {
		return new Map();
	}

	const params: unknown[] = [uniqueRunIds];
	const conditions = [
		'prs.run_id = ANY($1::uuid[])',
		"sources.deletion_status NOT IN ('soft_deleted', 'purging', 'purged')",
	];
	const allowed = allowedSensitivity(options?.maxSensitivityLevel);
	if (allowed) {
		params.push(allowed);
		conditions.push(`sources.sensitivity_level = ANY($${params.length})`);
	}

	const result = await pool.query<RunSourceSummaryRow>(
		`
			SELECT prs.run_id::text AS run_id, sources.id::text AS id, sources.filename, sources.status
			FROM pipeline_run_sources prs
			JOIN sources ON sources.id = prs.source_id
			WHERE ${conditions.join(' AND ')}
			ORDER BY prs.run_id, prs.updated_at ASC, sources.filename ASC
		`,
		params,
	);

	const byRun = new Map<string, SourceSummary[]>();
	for (const row of result.rows) {
		const current = byRun.get(row.run_id) ?? [];
		current.push(mapSourceSummary(row));
		byRun.set(row.run_id, current);
	}
	return byRun;
}

function subjectFromSources(job: Job, sources: SourceSummary[] | undefined): JobSubject {
	if (!sources || sources.length === 0) {
		return defaultJobSubject(job);
	}
	if (sources.length === 1) {
		const source = sources[0];
		return {
			kind: 'source',
			label: source.filename,
			source_id: source.id,
			source_count: 1,
		};
	}
	return {
		kind: 'batch',
		label: `${sources[0].filename} + ${sources.length - 1}`,
		source_count: sources.length,
	};
}

async function resolveJobSubjects(
	pool: Pool,
	jobs: Job[],
	options?: { maxSensitivityLevel?: ReturnType<typeof resolveReadMaxSensitivity> },
): Promise<Map<string, JobSubject>> {
	const directSourceIds: string[] = [];
	const runIds: string[] = [];
	for (const job of jobs) {
		const sourceId = resolveSourceId(job.payload);
		if (sourceId) {
			directSourceIds.push(sourceId);
			continue;
		}
		const runId = resolveRunId(job.payload);
		if (runId) {
			runIds.push(runId);
		}
	}

	const [sourceMap, runSourceMap] = await Promise.all([
		findVisibleSourceSummaryMap(pool, directSourceIds, options?.maxSensitivityLevel),
		findVisibleRunSourceSummaryMap(pool, runIds, options),
	]);

	const subjects = new Map<string, JobSubject>();
	for (const job of jobs) {
		const sourceId = resolveSourceId(job.payload);
		if (sourceId) {
			const source = sourceMap.get(sourceId);
			subjects.set(job.id, subjectFromSources(job, source ? [source] : []));
			continue;
		}
		const runId = resolveRunId(job.payload);
		subjects.set(job.id, runId ? subjectFromSources(job, runSourceMap.get(runId)) : defaultJobSubject(job));
	}
	return subjects;
}

function mapJobSummary(job: Job, subject: JobSubject = defaultJobSubject(job)): JobListResponse['data'][number] {
	return {
		id: job.id,
		type: job.type,
		subject,
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

function mapRedactedJobSummary(
	job: Job,
	subject: JobSubject = defaultJobSubject(job),
): JobListResponse['data'][number] {
	return {
		id: job.id,
		type: job.type,
		subject,
		status: job.status,
		attempts: job.attempts,
		max_attempts: job.maxAttempts,
		created_at: job.createdAt.toISOString(),
		started_at: toIsoString(job.startedAt),
		finished_at: toIsoString(job.finishedAt),
		links: {
			self: `/api/jobs/${job.id}`,
		},
	};
}

function mapJobDetail(job: Job, subject: JobSubject = defaultJobSubject(job)): JobDetailResponse['data']['job'] {
	return {
		id: job.id,
		type: job.type,
		subject,
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

function mapRedactedJobDetail(
	job: Job,
	subject: JobSubject = defaultJobSubject(job),
): JobDetailResponse['data']['job'] {
	return {
		...mapRedactedJobSummary(job, subject),
	};
}

function emptySourceCounts(): Record<PipelineRunSourceStatus, number> {
	return {
		pending: 0,
		processing: 0,
		completed: 0,
		failed: 0,
	};
}

function countProgressSources(sources: PipelineRunSource[]): Record<PipelineRunSourceStatus, number> {
	const counts = emptySourceCounts();
	for (const source of sources) {
		counts[source.status]++;
	}
	return counts;
}

async function filterVisibleProgressSources(
	pool: Pool,
	sources: PipelineRunSource[],
	maxSensitivityLevel: ReturnType<typeof resolveReadMaxSensitivity>,
): Promise<PipelineRunSource[]> {
	if (!maxSensitivityLevel) {
		return sources;
	}
	const visible = await Promise.all(
		sources.map(async (source) => ({
			source,
			visible: Boolean(await findSourceById(pool, source.sourceId, { maxSensitivityLevel })),
		})),
	);
	return visible.filter((entry) => entry.visible).map((entry) => entry.source);
}

async function mapProgressSource(
	source: PipelineRunSource,
	sourceSummaries: Map<string, SourceSummary>,
	options?: { redacted?: boolean; maxSensitivityLevel?: ReturnType<typeof resolveReadMaxSensitivity> },
): Promise<JobProgress['sources'][number]> {
	return {
		source_id: source.sourceId,
		source: sourceSummaries.get(source.sourceId) ?? null,
		current_step: source.currentStep,
		status: source.status,
		error_message: options?.redacted ? null : source.errorMessage,
		updated_at: source.updatedAt.toISOString(),
	};
}

async function resolveProgress(
	pool: Pool,
	job: Job,
	options?: { redacted?: boolean; maxSensitivityLevel?: ReturnType<typeof resolveReadMaxSensitivity> },
): Promise<JobProgress | null> {
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

	const allSources = await findPipelineRunSourcesByRunId(pool, runId);
	const sources = options?.redacted
		? await filterVisibleProgressSources(pool, allSources, options.maxSensitivityLevel)
		: allSources;
	const sourceSummaries = await findVisibleSourceSummaryMap(
		pool,
		sources.map((source) => source.sourceId),
		options?.maxSensitivityLevel,
	);

	return {
		run_id: run.id,
		run_status: run.status,
		source_counts: options?.redacted ? countProgressSources(sources) : sourceCounts,
		sources: await Promise.all(sources.map((source) => mapProgressSource(source, sourceSummaries, options))),
	};
}

function buildJobFilterSql(input: JobListQuery): { conditions: string[]; params: unknown[] } {
	const conditions: string[] = [];
	const params: unknown[] = [];
	if (input.type) {
		params.push(input.type);
		conditions.push(`type = $${params.length}`);
	}
	if (input.status) {
		params.push(input.status);
		conditions.push(`status = $${params.length}`);
	}
	if (input.worker_id) {
		params.push(input.worker_id);
		conditions.push(`worker_id = $${params.length}`);
	}
	return { conditions, params };
}

async function listVisibleJobsForPrincipal(
	pool: Pool,
	input: JobListQuery,
	authPrincipal: Extract<AuthPrincipal, { type: 'session' }>,
	maxSensitivityLevel: ReturnType<typeof resolveReadMaxSensitivity>,
): Promise<JobListResponse> {
	const { conditions, params } = buildJobFilterSql(input);
	params.push(authPrincipal.userId);
	const userParam = params.length;
	const allowed = allowedSensitivity(maxSensitivityLevel);
	const sensitivityClause = allowed ? `AND sources.sensitivity_level = ANY($${params.push(allowed)})` : '';
	conditions.push(`
		(
			COALESCE(payload->'submittedBy'->>'userId', payload->'submitted_by'->>'user_id') = $${userParam}
			OR EXISTS (
				SELECT 1
				FROM sources
				WHERE sources.id::text = COALESCE(jobs.payload->>'sourceId', jobs.payload->>'source_id')
				  AND sources.deletion_status NOT IN ('soft_deleted', 'purging', 'purged')
				  ${sensitivityClause}
			)
		)
	`);
	const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
	const countResult = await pool.query<{ count: string }>(`SELECT COUNT(*) AS count FROM jobs ${whereClause}`, params);
	const pageParams = [...params, input.limit];
	const result = await pool.query<JobRow>(
		`
			SELECT *
			FROM jobs
			${whereClause}
			ORDER BY created_at DESC, id DESC
			LIMIT $${pageParams.length}
		`,
		pageParams,
	);
	const jobs = result.rows.map(mapJobRow);
	const subjects = await resolveJobSubjects(pool, jobs, { maxSensitivityLevel });
	return {
		data: jobs.map((job) => mapRedactedJobSummary(job, subjects.get(job.id))),
		meta: {
			count: Number.parseInt(countResult.rows[0]?.count ?? '0', 10) || 0,
			limit: input.limit,
		},
	};
}

async function canReadJob(
	pool: Pool,
	job: Job,
	authPrincipal: Extract<AuthPrincipal, { type: 'session' }>,
	maxSensitivityLevel: ReturnType<typeof resolveReadMaxSensitivity>,
): Promise<boolean> {
	if (resolveSubmittedByUserId(job.payload) === authPrincipal.userId) {
		return true;
	}
	const sourceId = resolveSourceId(job.payload);
	if (!sourceId) {
		return false;
	}
	return Boolean(await findSourceById(pool, sourceId, { maxSensitivityLevel }));
}

export async function listRecentJobs(input: JobListQuery, options?: JobRouteOptions): Promise<JobListResponse> {
	const { config, pool } = resolveContext();
	const filter = {
		type: input.type,
		status: input.status,
		workerId: input.worker_id,
	};
	if (!options?.authPrincipal || isOperatorPrincipal(options.authPrincipal)) {
		const [count, jobs] = await Promise.all([
			countJobs(pool, filter),
			findJobs(pool, {
				...filter,
				limit: input.limit,
			}),
		]);
		const subjects = await resolveJobSubjects(pool, jobs);
		return {
			data: jobs.map((job) => mapJobSummary(job, subjects.get(job.id))),
			meta: {
				count,
				limit: input.limit,
			},
		};
	}

	const authPrincipal = options.authPrincipal;
	if (authPrincipal.type !== 'session') {
		throw new MulderError('The current principal cannot inspect jobs', 'AUTH_FORBIDDEN', {
			context: { resource: 'jobs' },
		});
	}
	const maxSensitivityLevel = resolveReadMaxSensitivity(config, authPrincipal, 'jobs');
	return await listVisibleJobsForPrincipal(pool, input, authPrincipal, maxSensitivityLevel);
}

export async function getJobStatusById(id: string, options?: JobRouteOptions): Promise<JobDetailResponse> {
	const { config, pool } = resolveContext();
	const job = await findJobById(pool, id);

	if (!job) {
		throw new DatabaseError(`Job not found: ${id}`, DATABASE_ERROR_CODES.DB_NOT_FOUND, {
			context: { id },
		});
	}

	if (options?.authPrincipal && !isOperatorPrincipal(options.authPrincipal)) {
		const authPrincipal = options.authPrincipal;
		if (authPrincipal.type !== 'session') {
			throw new DatabaseError(`Job not found: ${id}`, DATABASE_ERROR_CODES.DB_NOT_FOUND, {
				context: { id },
			});
		}
		const maxSensitivityLevel = resolveReadMaxSensitivity(config, authPrincipal, 'jobs');
		if (!(await canReadJob(pool, job, authPrincipal, maxSensitivityLevel))) {
			throw new DatabaseError(`Job not found: ${id}`, DATABASE_ERROR_CODES.DB_NOT_FOUND, {
				context: { id },
			});
		}
		const subjects = await resolveJobSubjects(pool, [job], { maxSensitivityLevel });
		return {
			data: {
				job: mapRedactedJobDetail(job, subjects.get(job.id)),
				progress: await resolveProgress(pool, job, { redacted: true, maxSensitivityLevel }),
			},
		};
	}

	const subjects = await resolveJobSubjects(pool, [job]);
	return {
		data: {
			job: mapJobDetail(job, subjects.get(job.id)),
			progress: await resolveProgress(pool, job),
		},
	};
}

export { mapJobDetail, mapJobSummary };
