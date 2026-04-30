/**
 * Type definitions for the pipeline orchestrator (`mulder pipeline run`).
 *
 * The orchestrator is a coordinator that chains the existing v1.0 pipeline
 * steps (ingest → extract → segment → enrich → embed → graph) and persists
 * per-source progress in `pipeline_runs` / `pipeline_run_sources` so a
 * crash at document N resumes from document N — not from the beginning.
 *
 * @see docs/specs/36_pipeline_orchestrator.spec.md §4.1
 * @see docs/functional-spec.md §3.1, §3.2, §3.3
 */

import type { SourceType, StepError } from '@mulder/core';
import type { AnalyzeResult } from '../analyze/types.js';

// ────────────────────────────────────────────────────────────
// Step naming
// ────────────────────────────────────────────────────────────

/**
 * Ordered v1.0 pipeline steps. Ground (v2.0) and Analyze (v2.0) are
 * deliberately omitted — when they ship, they will be appended to the
 * tuple in `index.ts` and `plannedSteps` will naturally pick them up.
 */
export type PipelineStepName = 'ingest' | 'extract' | 'segment' | 'enrich' | 'embed' | 'graph';

// ────────────────────────────────────────────────────────────
// Run options + input
// ────────────────────────────────────────────────────────────

/** User-facing options for a `pipeline run` invocation. */
export interface PipelineRunOptions {
	/** Stop after this step (inclusive). Must be a known step name. */
	upTo?: PipelineStepName;
	/** Skip steps earlier than this step. Only processes sources whose state allows the step. */
	from?: PipelineStepName;
	/** Optional human-readable tag attached to the `pipeline_runs` row. */
	tag?: string;
	/** Reuse an externally created `pipeline_runs` row instead of creating a new one. */
	runId?: string;
	/** If true, emit the plan without executing any step or writing to the DB. */
	dryRun?: boolean;
	/** If provided, skip `ingest` and operate on existing sources with these ids. Used by `pipeline retry`. */
	sourceIds?: string[];
	/** If true (retry path), re-run the selected step even if the source is already past it. */
	force?: boolean;
}

/** Input to the orchestrator's `execute()` function. */
export interface PipelineRunInput {
	/** Path to a PDF file or directory. Ignored when `options.sourceIds` is set. */
	path?: string;
	options: PipelineRunOptions;
}

// ────────────────────────────────────────────────────────────
// Per-source outcome + aggregate result
// ────────────────────────────────────────────────────────────

/** Per-source outcome for a single pipeline run. */
export interface PipelineRunSourceOutcome {
	sourceId: string;
	/** Source discriminator used for source-specific planning. */
	sourceType?: SourceType;
	/** Requested global range after applying --from/--up-to. */
	requestedSteps?: PipelineStepName[];
	/** Steps that can execute for this source type. */
	executableSteps?: PipelineStepName[];
	/** Requested steps omitted because this source type never runs them. */
	skippedSteps?: PipelineStepName[];
	/** Last step the source reached, or `null` if no steps ran for it. */
	finalStep: PipelineStepName | null;
	status: 'pending' | 'processing' | 'completed' | 'failed';
	errorMessage: string | null;
}

export interface PipelineGlobalAnalysisOutcome {
	status: 'success' | 'partial' | 'failed' | 'skipped';
	summary: string;
	result: AnalyzeResult | null;
}

/** Orchestrator result. */
export interface PipelineRunResult {
	/** `success` = all sources completed; `partial` = some failed; `failed` = all failed. */
	status: 'success' | 'partial' | 'failed';
	/** UUID of the created `pipeline_runs` row. Empty string for `--dry-run`. */
	runId: string;
	data: {
		runId: string;
		tag: string | null;
		plannedSteps: PipelineStepName[];
		totalSources: number;
		completedSources: number;
		failedSources: number;
		skippedSources: number;
		sources: PipelineRunSourceOutcome[];
		analysis: PipelineGlobalAnalysisOutcome;
	};
	errors: StepError[];
	metadata: {
		duration_ms: number;
		items_processed: number;
		items_skipped: number;
	};
}
