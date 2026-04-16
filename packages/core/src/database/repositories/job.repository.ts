/**
 * Job queue repository — CRUD + queue operations for the `jobs` table.
 *
 * Plain functions that accept a `pg.Pool` as the first argument, matching
 * the surrounding Mulder repository pattern. All queries use parameterized
 * SQL and the dequeue claim stays a single auto-commit statement.
 *
 * @see docs/specs/67_job_queue_repository.spec.md §4.1
 * @see docs/specs/78_dead_letter_queue_retry.spec.md §4.1
 * @see docs/functional-spec.md §4.3, §10.2, §10.3
 */

import type pg from 'pg';
import { DATABASE_ERROR_CODES, DatabaseError } from '../../shared/errors.js';
import { createChildLogger, createLogger } from '../../shared/logger.js';
import type {
	DeadLetterRetryFilter,
	DeadLetterRetryResult,
	DequeueJobResult,
	EnqueueJobInput,
	Job,
	JobClaim,
	JobFilter,
	JobPayload,
	JobStatus,
	ReapJobsResult,
} from './job.types.js';

const logger = createLogger();
const repoLogger = createChildLogger(logger, { module: 'job-repository' });

type Queryable = pg.Pool | pg.PoolClient;

interface JobRow {
	id: string;
	type: string;
	payload: JobPayload | string;
	status: JobStatus;
	attempts: number;
	max_attempts: number;
	error_log: string | null;
	worker_id: string | null;
	created_at: Date;
	started_at: Date | null;
	finished_at: Date | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJobPayload(payload: JobPayload | string): JobPayload {
	if (typeof payload !== 'string') {
		return payload;
	}

	try {
		const parsed: unknown = JSON.parse(payload);
		if (isPlainObject(parsed)) {
			return parsed;
		}
		return {};
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

function buildJobFilter(filter?: JobFilter): { whereClause: string; params: unknown[] } {
	const conditions: string[] = [];
	const params: unknown[] = [];

	if (filter?.type) {
		params.push(filter.type);
		conditions.push(`type = $${params.length}`);
	}

	if (filter?.status) {
		params.push(filter.status);
		conditions.push(`status = $${params.length}`);
	}

	if (filter?.workerId) {
		params.push(filter.workerId);
		conditions.push(`worker_id = $${params.length}`);
	}

	return {
		whereClause: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
		params,
	};
}

function readPayloadString(payload: JobPayload, ...keys: string[]): string | null {
	for (const key of keys) {
		const value = payload[key];
		if (typeof value === 'string' && value.trim().length > 0) {
			return value.trim();
		}
	}

	return null;
}

function resolveDeadLetterDocumentId(job: Job): string | null {
	return readPayloadString(job.payload, 'sourceId', 'source_id');
}

function resolveDeadLetterStep(job: Job): string | null {
	if (job.type === 'pipeline_run') {
		const from = readPayloadString(job.payload, 'from');
		const upTo = readPayloadString(job.payload, 'upTo', 'up_to');
		return from && upTo && from === upTo ? from : null;
	}

	return job.type;
}

function matchesDeadLetterRetryFilter(job: Job, filter?: DeadLetterRetryFilter): boolean {
	if (!filter) {
		return true;
	}

	if (filter.documentId && resolveDeadLetterDocumentId(job) !== filter.documentId) {
		return false;
	}

	if (filter.step && resolveDeadLetterStep(job) !== filter.step) {
		return false;
	}

	return true;
}

export async function enqueueJob(pool: Queryable, input: EnqueueJobInput): Promise<Job> {
	const sql = `
    INSERT INTO jobs (type, payload, max_attempts)
    VALUES ($1, $2, $3)
    RETURNING *
  `;
	const params = [input.type, JSON.stringify(input.payload), input.maxAttempts ?? 3];

	try {
		const result = await pool.query<JobRow>(sql, params);
		const row = result.rows[0];
		repoLogger.debug({ jobId: row.id, type: row.type }, 'Job enqueued');
		return mapJobRow(row);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to enqueue job', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { type: input.type },
		});
	}
}

export async function mergeJobPayload(pool: Queryable, id: string, patch: JobPayload): Promise<Job> {
	const sql = `
    UPDATE jobs
    SET payload = COALESCE(payload, '{}'::jsonb) || $2::jsonb
    WHERE id = $1
    RETURNING *
  `;

	try {
		const result = await pool.query<JobRow>(sql, [id, JSON.stringify(patch)]);
		if (result.rows.length === 0) {
			throw new DatabaseError(`Job not found: ${id}`, DATABASE_ERROR_CODES.DB_NOT_FOUND, {
				context: { id },
			});
		}
		repoLogger.debug({ jobId: id }, 'Job payload merged');
		return mapJobRow(result.rows[0]);
	} catch (error: unknown) {
		if (error instanceof DatabaseError) {
			throw error;
		}
		throw new DatabaseError('Failed to merge job payload', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { id },
		});
	}
}

export async function findJobById(pool: pg.Pool, id: string): Promise<Job | null> {
	const sql = 'SELECT * FROM jobs WHERE id = $1';

	try {
		const result = await pool.query<JobRow>(sql, [id]);
		if (result.rows.length === 0) {
			return null;
		}
		return mapJobRow(result.rows[0]);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to find job by ID', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { id },
		});
	}
}

export async function findJobs(pool: pg.Pool, filter?: JobFilter): Promise<Job[]> {
	const { whereClause, params } = buildJobFilter(filter);
	const limit = filter?.limit ?? 100;
	const offset = filter?.offset ?? 0;
	const sql = `
    SELECT *
    FROM jobs
    ${whereClause}
    ORDER BY created_at DESC, id DESC
    LIMIT $${params.length + 1}
    OFFSET $${params.length + 2}
  `;

	try {
		const result = await pool.query<JobRow>(sql, [...params, limit, offset]);
		return result.rows.map(mapJobRow);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to find jobs', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { filter },
		});
	}
}

export async function countJobs(pool: pg.Pool, filter?: JobFilter): Promise<number> {
	const { whereClause, params } = buildJobFilter(filter);
	const sql = `SELECT COUNT(*) FROM jobs ${whereClause}`;

	try {
		const result = await pool.query<{ count: string }>(sql, params);
		return Number.parseInt(result.rows[0].count, 10);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to count jobs', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { filter },
		});
	}
}

export async function findDeadLetterJobs(pool: Queryable, filter?: DeadLetterRetryFilter): Promise<Job[]> {
	const sql = `
    SELECT *
    FROM jobs
    WHERE status = 'dead_letter'
    ORDER BY created_at ASC, id ASC
  `;

	try {
		const result = await pool.query<JobRow>(sql);
		return result.rows.map(mapJobRow).filter((job) => matchesDeadLetterRetryFilter(job, filter));
	} catch (error: unknown) {
		throw new DatabaseError('Failed to find dead-letter jobs', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { filter },
		});
	}
}

export async function resetDeadLetterJobs(
	pool: Queryable,
	filter?: DeadLetterRetryFilter,
): Promise<DeadLetterRetryResult> {
	const matchedJobs = await findDeadLetterJobs(pool, filter);

	if (matchedJobs.length === 0) {
		repoLogger.debug({ count: 0, filter }, 'Dead-letter jobs reset');
		return {
			count: 0,
			jobIds: [],
		};
	}

	const matchedIds = matchedJobs.map((job) => job.id);
	const matchedIndex = new Map(matchedIds.map((id, index) => [id, index]));
	const sql = `
    UPDATE jobs
    SET status = 'pending',
        attempts = 0,
        worker_id = NULL,
        started_at = NULL,
        finished_at = NULL,
        error_log = NULL
    WHERE id = ANY($1::uuid[])
      AND status = 'dead_letter'
    RETURNING id
  `;

	try {
		const result = await pool.query<{ id: string }>(sql, [matchedIds]);
		const jobIds = result.rows
			.map((row) => row.id)
			.sort((left, right) => (matchedIndex.get(left) ?? 0) - (matchedIndex.get(right) ?? 0));
		repoLogger.debug({ count: jobIds.length, filter }, 'Dead-letter jobs reset');
		return {
			count: jobIds.length,
			jobIds,
		};
	} catch (error: unknown) {
		throw new DatabaseError('Failed to reset dead-letter jobs', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { filter },
		});
	}
}

export async function dequeueJob(pool: pg.Pool, workerId: string): Promise<DequeueJobResult> {
	const sql = `
    UPDATE jobs
    SET status = 'running',
        started_at = now(),
        attempts = attempts + 1,
        worker_id = $1
    WHERE id = (
      SELECT id
      FROM jobs
      WHERE status = 'pending' AND attempts <= max_attempts
      ORDER BY created_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING *
  `;

	try {
		const result = await pool.query<JobRow>(sql, [workerId]);
		if (result.rows.length === 0) {
			return null;
		}
		const row = result.rows[0];
		repoLogger.debug({ jobId: row.id, workerId }, 'Job dequeued');
		return mapJobRow(row);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to dequeue job', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { workerId },
		});
	}
}

export async function markJobCompleted(pool: pg.Pool, claim: JobClaim, payloadPatch?: JobPayload): Promise<Job> {
	const id = claim.jobId;
	const sql = payloadPatch
		? `
    UPDATE jobs
    SET status = 'completed',
        finished_at = now(),
        payload = COALESCE(payload, '{}'::jsonb) || $4::jsonb
    WHERE id = $1
      AND status = 'running'
      AND worker_id = $2
      AND attempts = $3
    RETURNING *
  `
		: `
    UPDATE jobs
    SET status = 'completed',
        finished_at = now()
    WHERE id = $1
      AND status = 'running'
      AND worker_id = $2
      AND attempts = $3
    RETURNING *
  `;

	try {
		const result = await pool.query<JobRow>(
			sql,
			payloadPatch
				? [id, claim.workerId, claim.attempts, JSON.stringify(payloadPatch)]
				: [id, claim.workerId, claim.attempts],
		);
		if (result.rows.length === 0) {
			throw new DatabaseError(`Active job claim not found: ${id}`, DATABASE_ERROR_CODES.DB_NOT_FOUND, {
				context: { id, claim },
			});
		}
		repoLogger.debug({ jobId: id, claim }, 'Job marked completed');
		return mapJobRow(result.rows[0]);
	} catch (error: unknown) {
		if (error instanceof DatabaseError) {
			throw error;
		}
		throw new DatabaseError('Failed to mark job completed', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { id, claim },
		});
	}
}

export async function markJobFailed(pool: pg.Pool, claim: JobClaim, errorLog: string): Promise<Job> {
	const id = claim.jobId;
	const sql = `
    UPDATE jobs
    SET status = CASE
      WHEN attempts >= max_attempts THEN 'dead_letter'::job_status
      ELSE 'failed'::job_status
    END,
        error_log = $2,
        finished_at = now()
    WHERE id = $1
      AND status = 'running'
      AND worker_id = $3
      AND attempts = $4
    RETURNING *
  `;

	try {
		const result = await pool.query<JobRow>(sql, [id, errorLog, claim.workerId, claim.attempts]);
		if (result.rows.length === 0) {
			throw new DatabaseError(`Active job claim not found: ${id}`, DATABASE_ERROR_CODES.DB_NOT_FOUND, {
				context: { id, claim },
			});
		}
		repoLogger.debug({ jobId: id, claim, status: result.rows[0].status }, 'Job marked failed');
		return mapJobRow(result.rows[0]);
	} catch (error: unknown) {
		if (error instanceof DatabaseError) {
			throw error;
		}
		throw new DatabaseError('Failed to mark job failed', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { id, claim },
		});
	}
}

export async function markJobDeadLetter(pool: pg.Pool, id: string, errorLog?: string | null): Promise<Job> {
	const sql = `
    UPDATE jobs
    SET status = 'dead_letter',
        error_log = COALESCE($2, error_log),
        finished_at = now()
    WHERE id = $1
      AND attempts >= max_attempts
      AND status IN ('pending', 'running', 'failed')
    RETURNING *
  `;

	try {
		const result = await pool.query<JobRow>(sql, [id, errorLog ?? null]);
		if (result.rows.length === 0) {
			throw new DatabaseError(`Job not found: ${id}`, DATABASE_ERROR_CODES.DB_NOT_FOUND, {
				context: { id },
			});
		}
		repoLogger.debug({ jobId: id }, 'Job marked dead letter');
		return mapJobRow(result.rows[0]);
	} catch (error: unknown) {
		if (error instanceof DatabaseError) {
			throw error;
		}
		throw new DatabaseError('Failed to mark job dead letter', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { id },
		});
	}
}

export async function reapRunningJobs(pool: pg.Pool, staleBefore: Date): Promise<ReapJobsResult> {
	const sql = `
    UPDATE jobs
    SET status = CASE
          WHEN attempts > max_attempts THEN 'dead_letter'::job_status
          ELSE 'pending'::job_status
        END,
        worker_id = NULL,
        started_at = NULL,
        finished_at = CASE
          WHEN attempts > max_attempts THEN now()
          ELSE NULL
        END
    WHERE status = 'running'
      AND started_at IS NOT NULL
      AND started_at < $1
    RETURNING id
  `;

	try {
		const result = await pool.query<{ id: string }>(sql, [staleBefore]);
		const jobIds = result.rows.map((row) => row.id);
		repoLogger.debug({ count: jobIds.length }, 'Stale running jobs reaped');
		return {
			count: jobIds.length,
			jobIds,
		};
	} catch (error: unknown) {
		throw new DatabaseError('Failed to reap running jobs', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { staleBefore: staleBefore.toISOString() },
		});
	}
}
