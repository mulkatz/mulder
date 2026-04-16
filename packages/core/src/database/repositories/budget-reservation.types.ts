import type { BudgetablePipelineStep } from '../../shared/budget.js';

export type MonthlyBudgetReservationStatus = 'reserved' | 'committed' | 'released' | 'reconciled';

export interface MonthlyBudgetReservation {
	id: string;
	budgetMonth: string;
	sourceId: string;
	runId: string;
	jobId: string;
	retryOfReservationId: string | null;
	status: MonthlyBudgetReservationStatus;
	plannedSteps: BudgetablePipelineStep[];
	reservedEstimatedUsd: number;
	committedUsd: number;
	releasedUsd: number;
	metadata: Record<string, unknown>;
	createdAt: Date;
	finalizedAt: Date | null;
}

export interface CreateMonthlyBudgetReservationInput {
	budgetMonth: string;
	sourceId: string;
	runId: string;
	jobId: string;
	retryOfReservationId?: string | null;
	plannedSteps: BudgetablePipelineStep[];
	reservedEstimatedUsd: number;
	metadata?: Record<string, unknown>;
}

export interface FinalizeMonthlyBudgetReservationInput {
	runId: string;
	status: Exclude<MonthlyBudgetReservationStatus, 'reserved'>;
	committedUsd: number;
	releasedUsd: number;
	metadata?: Record<string, unknown>;
}

export interface MonthlyBudgetSummary {
	budgetMonth: string;
	reservedUsd: number;
	committedUsd: number;
	releasedUsd: number;
}
