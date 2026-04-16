import type pg from 'pg';
import { isBudgetablePipelineStep } from '../../shared/budget.js';
import { DATABASE_ERROR_CODES, DatabaseError } from '../../shared/errors.js';
import { createChildLogger, createLogger } from '../../shared/logger.js';
import type {
	CreateMonthlyBudgetReservationInput,
	FinalizeMonthlyBudgetReservationInput,
	MonthlyBudgetReservation,
	MonthlyBudgetReservationStatus,
	MonthlyBudgetSummary,
} from './budget-reservation.types.js';

const logger = createLogger();
const repoLogger = createChildLogger(logger, { module: 'budget-reservation-repository' });

type Queryable = pg.Pool | pg.PoolClient;

interface MonthlyBudgetReservationRow {
	id: string;
	budget_month: string | Date;
	source_id: string;
	run_id: string;
	job_id: string;
	retry_of_reservation_id: string | null;
	status: MonthlyBudgetReservationStatus;
	planned_steps: string[] | string;
	reserved_estimated_usd: string | number;
	committed_usd: string | number;
	released_usd: string | number;
	metadata: Record<string, unknown> | string | null;
	created_at: Date;
	finalized_at: Date | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseObject(value: Record<string, unknown> | string | null): Record<string, unknown> {
	if (value === null || value === undefined) {
		return {};
	}

	if (typeof value === 'string') {
		try {
			const parsed: unknown = JSON.parse(value);
			return isPlainObject(parsed) ? parsed : {};
		} catch {
			return {};
		}
	}

	return value;
}

function parseSteps(value: string[] | string): CreateMonthlyBudgetReservationInput['plannedSteps'] {
	if (Array.isArray(value)) {
		return value.filter(isBudgetablePipelineStep);
	}

	try {
		const parsed: unknown = JSON.parse(value);
		return Array.isArray(parsed) ? parsed.filter(isBudgetablePipelineStep) : [];
	} catch {
		return [];
	}
}

function parseNumeric(value: string | number): number {
	return typeof value === 'number' ? value : Number.parseFloat(value);
}

function normalizeBudgetMonth(value: string | Date): string {
	if (value instanceof Date) {
		return value.toISOString().slice(0, 10);
	}

	return value.slice(0, 10);
}

function mapRow(row: MonthlyBudgetReservationRow): MonthlyBudgetReservation {
	return {
		id: row.id,
		budgetMonth: normalizeBudgetMonth(row.budget_month),
		sourceId: row.source_id,
		runId: row.run_id,
		jobId: row.job_id,
		retryOfReservationId: row.retry_of_reservation_id,
		status: row.status,
		plannedSteps: parseSteps(row.planned_steps),
		reservedEstimatedUsd: parseNumeric(row.reserved_estimated_usd),
		committedUsd: parseNumeric(row.committed_usd),
		releasedUsd: parseNumeric(row.released_usd),
		metadata: parseObject(row.metadata),
		createdAt: row.created_at,
		finalizedAt: row.finalized_at,
	};
}

export async function createMonthlyBudgetReservation(
	pool: Queryable,
	input: CreateMonthlyBudgetReservationInput,
): Promise<MonthlyBudgetReservation> {
	const sql = `
		INSERT INTO monthly_budget_reservations (
			budget_month,
			source_id,
			run_id,
			job_id,
			retry_of_reservation_id,
			status,
			planned_steps,
			reserved_estimated_usd,
			metadata
		)
		VALUES ($1, $2, $3, $4, $5, 'reserved', $6, $7, $8)
		RETURNING *
	`;

	try {
		const result = await pool.query<MonthlyBudgetReservationRow>(sql, [
			input.budgetMonth,
			input.sourceId,
			input.runId,
			input.jobId,
			input.retryOfReservationId ?? null,
			JSON.stringify(input.plannedSteps),
			input.reservedEstimatedUsd,
			JSON.stringify(input.metadata ?? {}),
		]);
		repoLogger.debug({ runId: input.runId, sourceId: input.sourceId }, 'Monthly budget reservation created');
		return mapRow(result.rows[0]);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to create monthly budget reservation', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { runId: input.runId, sourceId: input.sourceId },
		});
	}
}

export async function findMonthlyBudgetReservationByRunId(
	pool: Queryable,
	runId: string,
): Promise<MonthlyBudgetReservation | null> {
	const sql = 'SELECT * FROM monthly_budget_reservations WHERE run_id = $1';

	try {
		const result = await pool.query<MonthlyBudgetReservationRow>(sql, [runId]);
		if (result.rows.length === 0) {
			return null;
		}
		return mapRow(result.rows[0]);
	} catch (error: unknown) {
		throw new DatabaseError(
			'Failed to find monthly budget reservation by run ID',
			DATABASE_ERROR_CODES.DB_QUERY_FAILED,
			{
				cause: error,
				context: { runId },
			},
		);
	}
}

export async function findLatestMonthlyBudgetReservationForSource(
	pool: Queryable,
	sourceId: string,
): Promise<MonthlyBudgetReservation | null> {
	const sql = `
		SELECT *
		FROM monthly_budget_reservations
		WHERE source_id = $1
		ORDER BY created_at DESC, id DESC
		LIMIT 1
	`;

	try {
		const result = await pool.query<MonthlyBudgetReservationRow>(sql, [sourceId]);
		if (result.rows.length === 0) {
			return null;
		}
		return mapRow(result.rows[0]);
	} catch (error: unknown) {
		throw new DatabaseError(
			'Failed to find latest monthly budget reservation for source',
			DATABASE_ERROR_CODES.DB_QUERY_FAILED,
			{
				cause: error,
				context: { sourceId },
			},
		);
	}
}

export async function finalizeMonthlyBudgetReservation(
	pool: Queryable,
	input: FinalizeMonthlyBudgetReservationInput,
): Promise<MonthlyBudgetReservation | null> {
	const sql = `
		UPDATE monthly_budget_reservations
		SET status = $2,
				committed_usd = $3,
				released_usd = $4,
				metadata = metadata || $5::jsonb,
				finalized_at = now()
		WHERE run_id = $1
			AND status = 'reserved'
		RETURNING *
	`;

	try {
		const result = await pool.query<MonthlyBudgetReservationRow>(sql, [
			input.runId,
			input.status,
			input.committedUsd,
			input.releasedUsd,
			JSON.stringify(input.metadata ?? {}),
		]);
		if (result.rows.length === 0) {
			return null;
		}
		repoLogger.debug({ runId: input.runId, status: input.status }, 'Monthly budget reservation finalized');
		return mapRow(result.rows[0]);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to finalize monthly budget reservation', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { runId: input.runId, status: input.status },
		});
	}
}

export async function summarizeMonthlyBudgetReservations(
	pool: Queryable,
	budgetMonth: string,
): Promise<MonthlyBudgetSummary> {
	const sql = `
		SELECT
			COALESCE(SUM(CASE WHEN status = 'reserved' THEN reserved_estimated_usd ELSE 0 END), 0)::numeric(12,4) AS reserved_usd,
			COALESCE(SUM(committed_usd), 0)::numeric(12,4) AS committed_usd,
			COALESCE(SUM(released_usd), 0)::numeric(12,4) AS released_usd
		FROM monthly_budget_reservations
		WHERE budget_month = $1
	`;

	try {
		const result = await pool.query<{
			reserved_usd: string | number;
			committed_usd: string | number;
			released_usd: string | number;
		}>(sql, [budgetMonth]);
		const row = result.rows[0];
		return {
			budgetMonth,
			reservedUsd: parseNumeric(row?.reserved_usd ?? 0),
			committedUsd: parseNumeric(row?.committed_usd ?? 0),
			releasedUsd: parseNumeric(row?.released_usd ?? 0),
		};
	} catch (error: unknown) {
		throw new DatabaseError('Failed to summarize monthly budget reservations', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { budgetMonth },
		});
	}
}
