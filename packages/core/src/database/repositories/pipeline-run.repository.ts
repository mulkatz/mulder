/**
 * Pipeline-run repository — CRUD operations for the `pipeline_runs` and
 * `pipeline_run_sources` tables.
 *
 * Plain functions that accept a `pg.Pool` as the first argument (same
 * pattern as `source.repository.ts`). All queries use parameterized SQL.
 * The per-source upsert is the cursor — it must be idempotent so the
 * orchestrator can re-stamp progress on every successful step without
 * fear of duplicates.
 *
 * @see docs/specs/36_pipeline_orchestrator.spec.md §4.3
 * @see docs/functional-spec.md §4.3 (pipeline_runs, pipeline_run_sources)
 */

import type pg from 'pg';
import { DATABASE_ERROR_CODES, DatabaseError } from '../../shared/errors.js';
import { createChildLogger, createLogger } from '../../shared/logger.js';
import type {
	CreatePipelineRunInput,
	PipelineRun,
	PipelineRunSource,
	PipelineRunSourceStatus,
	PipelineRunStatus,
	UpsertPipelineRunSourceInput,
} from './pipeline-run.types.js';

const logger = createLogger();
const repoLogger = createChildLogger(logger, { module: 'pipeline-run-repository' });

// ────────────────────────────────────────────────────────────
// Row mappers (snake_case DB → camelCase TS)
// ────────────────────────────────────────────────────────────

interface PipelineRunRow {
	id: string;
	tag: string | null;
	options: Record<string, unknown> | string | null;
	status: PipelineRunStatus;
	created_at: Date;
	finished_at: Date | null;
}

interface PipelineRunSourceRow {
	run_id: string;
	source_id: string;
	current_step: string;
	status: PipelineRunSourceStatus;
	error_message: string | null;
	updated_at: Date;
}

function parseOptions(value: Record<string, unknown> | string | null): Record<string, unknown> {
	if (value === null || value === undefined) {
		return {};
	}
	if (typeof value === 'string') {
		try {
			const parsed = JSON.parse(value);
			return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
		} catch {
			return {};
		}
	}
	return value;
}

function mapPipelineRunRow(row: PipelineRunRow): PipelineRun {
	return {
		id: row.id,
		tag: row.tag,
		options: parseOptions(row.options),
		status: row.status,
		createdAt: row.created_at,
		finishedAt: row.finished_at,
	};
}

function mapPipelineRunSourceRow(row: PipelineRunSourceRow): PipelineRunSource {
	return {
		runId: row.run_id,
		sourceId: row.source_id,
		currentStep: row.current_step,
		status: row.status,
		errorMessage: row.error_message,
		updatedAt: row.updated_at,
	};
}

// ────────────────────────────────────────────────────────────
// pipeline_runs CRUD
// ────────────────────────────────────────────────────────────

/**
 * Creates a new pipeline run row with `status = 'running'`.
 *
 * The orchestrator calls this exactly once per `pipeline run` invocation
 * (skipped on `--dry-run`). The returned `id` becomes the cursor key for
 * all subsequent `upsertPipelineRunSource` calls in this batch.
 */
export async function createPipelineRun(pool: pg.Pool, input: CreatePipelineRunInput): Promise<PipelineRun> {
	const sql = `
    INSERT INTO pipeline_runs (tag, options, status)
    VALUES ($1, $2, 'running')
    RETURNING *
  `;
	const params = [input.tag ?? null, JSON.stringify(input.options ?? {})];

	try {
		const result = await pool.query<PipelineRunRow>(sql, params);
		const row = result.rows[0];
		repoLogger.debug({ runId: row.id, tag: row.tag }, 'Pipeline run created');
		return mapPipelineRunRow(row);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to create pipeline run', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { tag: input.tag ?? null },
		});
	}
}

/**
 * Marks a pipeline run as terminal: sets `status` and `finished_at = now()`.
 *
 * Called by the orchestrator after the per-source loop ends. The status is
 * derived from per-source outcomes (`completed`, `partial`, or `failed`).
 *
 * @throws {DatabaseError} with `DB_NOT_FOUND` if no run row exists.
 */
export async function finalizePipelineRun(
	pool: pg.Pool,
	id: string,
	status: PipelineRunStatus,
): Promise<PipelineRun> {
	const sql = `
    UPDATE pipeline_runs
    SET status = $1, finished_at = now()
    WHERE id = $2
    RETURNING *
  `;

	try {
		const result = await pool.query<PipelineRunRow>(sql, [status, id]);
		if (result.rows.length === 0) {
			throw new DatabaseError(`Pipeline run not found: ${id}`, DATABASE_ERROR_CODES.DB_NOT_FOUND, {
				context: { id, status },
			});
		}
		repoLogger.debug({ runId: id, status }, 'Pipeline run finalized');
		return mapPipelineRunRow(result.rows[0]);
	} catch (error: unknown) {
		if (error instanceof DatabaseError) {
			throw error;
		}
		throw new DatabaseError('Failed to finalize pipeline run', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { id, status },
		});
	}
}

/**
 * Finds a pipeline run by its UUID.
 *
 * @returns The run, or `null` if not found.
 */
export async function findPipelineRunById(pool: pg.Pool, id: string): Promise<PipelineRun | null> {
	const sql = 'SELECT * FROM pipeline_runs WHERE id = $1';

	try {
		const result = await pool.query<PipelineRunRow>(sql, [id]);
		if (result.rows.length === 0) {
			return null;
		}
		return mapPipelineRunRow(result.rows[0]);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to find pipeline run by ID', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { id },
		});
	}
}

/**
 * Returns the most recent pipeline run, optionally filtered by tag.
 *
 * Used by `mulder pipeline status` (no flags → newest run) and
 * `mulder pipeline status --tag <tag>` (newest run with that tag).
 */
export async function findLatestPipelineRun(pool: pg.Pool, tag?: string | null): Promise<PipelineRun | null> {
	const sql = tag
		? 'SELECT * FROM pipeline_runs WHERE tag = $1 ORDER BY created_at DESC LIMIT 1'
		: 'SELECT * FROM pipeline_runs ORDER BY created_at DESC LIMIT 1';
	const params = tag ? [tag] : [];

	try {
		const result = await pool.query<PipelineRunRow>(sql, params);
		if (result.rows.length === 0) {
			return null;
		}
		return mapPipelineRunRow(result.rows[0]);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to find latest pipeline run', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { tag: tag ?? null },
		});
	}
}

// ────────────────────────────────────────────────────────────
// pipeline_run_sources CRUD
// ────────────────────────────────────────────────────────────

/**
 * Idempotent upsert for the per-source progress cursor.
 *
 * The composite primary key `(run_id, source_id)` makes this safe to
 * call once per successful step — `current_step`, `status`, and
 * `error_message` are overwritten on conflict, and `updated_at` is
 * refreshed via `now()`.
 */
export async function upsertPipelineRunSource(
	pool: pg.Pool,
	input: UpsertPipelineRunSourceInput,
): Promise<PipelineRunSource> {
	const sql = `
    INSERT INTO pipeline_run_sources (run_id, source_id, current_step, status, error_message, updated_at)
    VALUES ($1, $2, $3, $4, $5, now())
    ON CONFLICT (run_id, source_id) DO UPDATE SET
      current_step = EXCLUDED.current_step,
      status = EXCLUDED.status,
      error_message = EXCLUDED.error_message,
      updated_at = now()
    RETURNING *
  `;
	const params = [
		input.runId,
		input.sourceId,
		input.currentStep,
		input.status,
		input.errorMessage ?? null,
	];

	try {
		const result = await pool.query<PipelineRunSourceRow>(sql, params);
		repoLogger.debug(
			{
				runId: input.runId,
				sourceId: input.sourceId,
				currentStep: input.currentStep,
				status: input.status,
			},
			'Pipeline run source upserted',
		);
		return mapPipelineRunSourceRow(result.rows[0]);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to upsert pipeline run source', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: {
				runId: input.runId,
				sourceId: input.sourceId,
				currentStep: input.currentStep,
				status: input.status,
			},
		});
	}
}

/**
 * Returns all pipeline_run_sources rows for a run, in insertion order.
 */
export async function findPipelineRunSourcesByRunId(
	pool: pg.Pool,
	runId: string,
): Promise<PipelineRunSource[]> {
	const sql = `
    SELECT * FROM pipeline_run_sources
    WHERE run_id = $1
    ORDER BY updated_at ASC, source_id ASC
  `;

	try {
		const result = await pool.query<PipelineRunSourceRow>(sql, [runId]);
		return result.rows.map(mapPipelineRunSourceRow);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to find pipeline run sources', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { runId },
		});
	}
}

/**
 * Returns the pipeline_run_sources row for a specific (run, source) pair.
 *
 * @returns The row, or `null` if not found.
 */
export async function findPipelineRunSourceById(
	pool: pg.Pool,
	runId: string,
	sourceId: string,
): Promise<PipelineRunSource | null> {
	const sql = 'SELECT * FROM pipeline_run_sources WHERE run_id = $1 AND source_id = $2';

	try {
		const result = await pool.query<PipelineRunSourceRow>(sql, [runId, sourceId]);
		if (result.rows.length === 0) {
			return null;
		}
		return mapPipelineRunSourceRow(result.rows[0]);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to find pipeline run source', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { runId, sourceId },
		});
	}
}

/**
 * Returns the most recent pipeline_run_sources row across all runs for a
 * given source. Used by `mulder pipeline status --source <id>` and by
 * `mulder pipeline retry <source-id>` to find the failed step to retry.
 */
export async function findLatestPipelineRunSourceForSource(
	pool: pg.Pool,
	sourceId: string,
): Promise<PipelineRunSource | null> {
	const sql = `
    SELECT prs.*
    FROM pipeline_run_sources prs
    JOIN pipeline_runs pr ON pr.id = prs.run_id
    WHERE prs.source_id = $1
    ORDER BY pr.created_at DESC, prs.updated_at DESC
    LIMIT 1
  `;

	try {
		const result = await pool.query<PipelineRunSourceRow>(sql, [sourceId]);
		if (result.rows.length === 0) {
			return null;
		}
		return mapPipelineRunSourceRow(result.rows[0]);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to find latest pipeline run source', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { sourceId },
		});
	}
}

/**
 * Returns a zero-filled count of pipeline_run_sources rows by status for a
 * given run. The orchestrator uses this to derive the final `pipeline_runs.status`.
 */
export async function countPipelineRunSourcesByStatus(
	pool: pg.Pool,
	runId: string,
): Promise<Record<PipelineRunSourceStatus, number>> {
	const sql = `
    SELECT status, COUNT(*)::int AS count
    FROM pipeline_run_sources
    WHERE run_id = $1
    GROUP BY status
  `;

	try {
		const result = await pool.query<{ status: PipelineRunSourceStatus; count: number }>(sql, [runId]);
		const counts: Record<PipelineRunSourceStatus, number> = {
			pending: 0,
			processing: 0,
			completed: 0,
			failed: 0,
		};
		for (const row of result.rows) {
			counts[row.status] = row.count;
		}
		return counts;
	} catch (error: unknown) {
		throw new DatabaseError('Failed to count pipeline run sources by status', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { runId },
		});
	}
}
