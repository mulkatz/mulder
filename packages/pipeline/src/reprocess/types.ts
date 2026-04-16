/**
 * Types for selective reprocessing.
 */

import type { SourceStatus, StepError } from '@mulder/core';

export type ReprocessStepName = 'extract' | 'segment' | 'enrich' | 'embed' | 'graph';

export type ReprocessPlanReason = 'hash-mismatch' | 'missing-history' | 'forced-step' | 'downstream';

export interface ReprocessInput {
	step?: ReprocessStepName;
	dryRun?: boolean;
	costEstimate?: boolean;
}

export interface ReprocessPlannedStep {
	stepName: ReprocessStepName;
	force: boolean;
	reason: ReprocessPlanReason;
	currentHash: string;
	storedHash: string | null;
}

export interface ReprocessSourcePlan {
	sourceId: string;
	filename: string;
	status: SourceStatus;
	planned: boolean;
	skipReason: string | null;
	steps: ReprocessPlannedStep[];
}

export interface ReprocessPlan {
	requestedStep: ReprocessStepName | null;
	mode: 'dry-run' | 'cost-estimate' | 'live';
	sourcesConsidered: number;
	plannedSourceCount: number;
	skippedSourceCount: number;
	plannedStepCount: number;
	globalAnalyzePlanned: boolean;
	sources: ReprocessSourcePlan[];
}

export interface ReprocessRunSummary {
	runId: string | null;
	completedSources: number;
	skippedSources: number;
	failedSources: number;
	globalAnalyzeStatus: 'not-run' | 'success' | 'partial' | 'failed';
}

export interface ReprocessResult {
	status: 'success' | 'partial' | 'failed' | 'skipped';
	plan: ReprocessPlan;
	summary: ReprocessRunSummary;
	errors: StepError[];
	metadata: {
		duration_ms: number;
		items_processed: number;
		items_skipped: number;
		items_cached: number;
	};
}
