import {
	budgetMonthStart,
	countJobs,
	getWorkerPool,
	loadConfig,
	PIPELINE_ERROR_CODES,
	PipelineError,
	summarizeMonthlyBudgetReservations,
} from '@mulder/core';
import type { Pool } from 'pg';
import type { StatusResponse } from '../routes/status.schemas.js';

interface StatusContext {
	pool: Pool;
	monthlyLimitUsd: number;
}

function resolveContext(): StatusContext {
	const config = loadConfig();
	if (!config.gcp?.cloud_sql) {
		throw new PipelineError(
			'GCP cloud_sql configuration is required for status routes',
			PIPELINE_ERROR_CODES.PIPELINE_WRONG_STATUS,
			{
				context: { configPath: process.env.MULDER_CONFIG ?? 'mulder.config.yaml' },
			},
		);
	}

	return {
		pool: getWorkerPool(config.gcp.cloud_sql),
		monthlyLimitUsd: config.api.budget.monthly_limit_usd,
	};
}

function roundUsd(value: number): number {
	return Number(value.toFixed(4));
}

export async function getApiStatus(): Promise<StatusResponse> {
	const { pool, monthlyLimitUsd } = resolveContext();
	const budgetMonth = budgetMonthStart(new Date());

	const [budget, pending, running, completed, failed, deadLetter] = await Promise.all([
		summarizeMonthlyBudgetReservations(pool, budgetMonth),
		countJobs(pool, { status: 'pending' }),
		countJobs(pool, { status: 'running' }),
		countJobs(pool, { status: 'completed' }),
		countJobs(pool, { status: 'failed' }),
		countJobs(pool, { status: 'dead_letter' }),
	]);

	return {
		data: {
			budget: {
				month: budgetMonth,
				limit_usd: monthlyLimitUsd,
				reserved_usd: budget.reservedUsd,
				committed_usd: budget.committedUsd,
				released_usd: budget.releasedUsd,
				remaining_usd: roundUsd(monthlyLimitUsd - budget.reservedUsd - budget.committedUsd),
			},
			jobs: {
				pending,
				running,
				completed,
				failed,
				dead_letter: deadLetter,
			},
		},
	};
}
