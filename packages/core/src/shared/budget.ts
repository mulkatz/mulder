import type { ApiBudgetConfig, ExtractionConfig } from '../config/types.js';
import type { Source, SourceStatus } from '../database/repositories/source.types.js';

export const BUDGETABLE_PIPELINE_STEP_VALUES = ['extract', 'segment', 'enrich', 'embed', 'graph'] as const;

export type BudgetablePipelineStep = (typeof BUDGETABLE_PIPELINE_STEP_VALUES)[number];

export function isBudgetablePipelineStep(value: string): value is BudgetablePipelineStep {
	return BUDGETABLE_PIPELINE_STEP_VALUES.some((step) => step === value);
}

export interface BudgetEstimate {
	totalUsd: number;
	byStep: Record<BudgetablePipelineStep, number>;
}

export interface BudgetReservationFinalization {
	status: 'committed' | 'released' | 'reconciled';
	committedUsd: number;
	releasedUsd: number;
}

const SOURCE_STATUS_ORDER: readonly SourceStatus[] = [
	'ingested',
	'extracted',
	'segmented',
	'enriched',
	'embedded',
	'graphed',
	'analyzed',
] as const;

function sourceStatusIndex(status: SourceStatus): number {
	return SOURCE_STATUS_ORDER.indexOf(status);
}

function targetStatusForStep(step: BudgetablePipelineStep): SourceStatus {
	switch (step) {
		case 'extract':
			return 'extracted';
		case 'segment':
			return 'segmented';
		case 'enrich':
			return 'enriched';
		case 'embed':
			return 'embedded';
		case 'graph':
			return 'graphed';
	}
}

function roundUsd(value: number): number {
	return Number(value.toFixed(4));
}

function emptyBreakdown(): Record<BudgetablePipelineStep, number> {
	return {
		extract: 0,
		segment: 0,
		enrich: 0,
		embed: 0,
		graph: 0,
	};
}

function sourceSkipsLayoutBudget(source: Source): boolean {
	return source.sourceType === 'docx';
}

function shouldChargeExtract(source: Source, extraction: ExtractionConfig): boolean {
	if (sourceSkipsLayoutBudget(source)) {
		return false;
	}

	if (!source.hasNativeText) {
		return true;
	}

	return source.nativeTextRatio < extraction.native_text_threshold;
}

function shouldChargeSegment(source: Source): boolean {
	return !sourceSkipsLayoutBudget(source);
}

function isChargeableStep(step: BudgetablePipelineStep, sourceStatus: SourceStatus, force: boolean): boolean {
	if (force) {
		return true;
	}

	return sourceStatusIndex(sourceStatus) < sourceStatusIndex(targetStatusForStep(step));
}

export function estimateBudgetForSourceRun(input: {
	source: Source;
	plannedSteps: BudgetablePipelineStep[];
	budget: ApiBudgetConfig;
	extraction: ExtractionConfig;
	force?: boolean;
}): BudgetEstimate {
	const pageCount = Math.max(input.source.pageCount ?? 1, 1);
	const breakdown = emptyBreakdown();

	for (const step of input.plannedSteps) {
		if (!isChargeableStep(step, input.source.status, input.force ?? false)) {
			continue;
		}

		switch (step) {
			case 'extract':
				if (shouldChargeExtract(input.source, input.extraction)) {
					breakdown.extract = roundUsd(pageCount * input.budget.extract_per_page_usd);
				}
				break;
			case 'segment':
				if (shouldChargeSegment(input.source)) {
					breakdown.segment = roundUsd(pageCount * input.budget.segment_per_page_usd);
				}
				break;
			case 'enrich':
				breakdown.enrich = roundUsd(input.budget.enrich_per_source_usd);
				break;
			case 'embed':
				breakdown.embed = roundUsd(input.budget.embed_per_source_usd);
				break;
			case 'graph':
				breakdown.graph = roundUsd(input.budget.graph_per_source_usd);
				break;
		}
	}

	const totalUsd = roundUsd(Object.values(breakdown).reduce((sum, value) => sum + value, 0));
	return {
		totalUsd,
		byStep: breakdown,
	};
}

export function completedStepsFromProgress(
	plannedSteps: BudgetablePipelineStep[],
	currentStep: string,
	status: 'pending' | 'processing' | 'completed' | 'failed',
): BudgetablePipelineStep[] {
	if (status === 'completed') {
		return [...plannedSteps];
	}

	if (!isBudgetablePipelineStep(currentStep)) {
		return [];
	}

	const currentIndex = plannedSteps.indexOf(currentStep);
	if (currentIndex === -1) {
		return [];
	}

	return plannedSteps.slice(0, currentIndex + 1);
}

export function finalizeBudgetReservation(input: {
	source: Source;
	plannedSteps: BudgetablePipelineStep[];
	completedSteps: BudgetablePipelineStep[];
	budget: ApiBudgetConfig;
	extraction: ExtractionConfig;
	force?: boolean;
}): BudgetReservationFinalization {
	const reserved = estimateBudgetForSourceRun(input).totalUsd;
	const committed = estimateBudgetForSourceRun({
		source: input.source,
		plannedSteps: input.completedSteps,
		budget: input.budget,
		extraction: input.extraction,
		force: input.force,
	}).totalUsd;
	const released = roundUsd(Math.max(reserved - committed, 0));

	if (committed === 0) {
		return {
			status: 'released',
			committedUsd: 0,
			releasedUsd: reserved,
		};
	}

	if (released === 0) {
		return {
			status: 'committed',
			committedUsd: reserved,
			releasedUsd: 0,
		};
	}

	return {
		status: 'reconciled',
		committedUsd: committed,
		releasedUsd: released,
	};
}

export function budgetMonthStart(date: Date): string {
	const year = date.getUTCFullYear();
	const month = String(date.getUTCMonth() + 1).padStart(2, '0');
	return `${year}-${month}-01`;
}

export function secondsUntilNextBudgetMonth(now: Date): number {
	const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0));
	return Math.max(Math.ceil((nextMonth.getTime() - now.getTime()) / 1000), 0);
}
