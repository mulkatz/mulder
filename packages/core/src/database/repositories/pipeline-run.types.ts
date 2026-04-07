/**
 * Type definitions for the pipeline-run repository.
 *
 * Covers the `pipeline_runs` and `pipeline_run_sources` tables — the
 * cursor-based progress store consumed by the pipeline orchestrator
 * (spec 36) and, eventually, by the async worker (M7).
 *
 * @see docs/specs/36_pipeline_orchestrator.spec.md §4.2
 * @see docs/functional-spec.md §4.3 (pipeline_runs, pipeline_run_sources)
 */

// ────────────────────────────────────────────────────────────
// Status enums
// ────────────────────────────────────────────────────────────

/** Lifecycle of a pipeline run row. */
export type PipelineRunStatus = 'running' | 'completed' | 'partial' | 'failed';

/** Lifecycle of a per-source progress row inside a pipeline run. */
export type PipelineRunSourceStatus = 'pending' | 'processing' | 'completed' | 'failed';

// ────────────────────────────────────────────────────────────
// Pipeline run
// ────────────────────────────────────────────────────────────

/** A pipeline run row from the database. */
export interface PipelineRun {
	id: string;
	tag: string | null;
	options: Record<string, unknown>;
	status: PipelineRunStatus;
	createdAt: Date;
	finishedAt: Date | null;
}

/** Input for creating a new pipeline run. */
export interface CreatePipelineRunInput {
	tag?: string | null;
	options?: Record<string, unknown>;
}

// ────────────────────────────────────────────────────────────
// Per-source progress row
// ────────────────────────────────────────────────────────────

/** A pipeline_run_sources row from the database. */
export interface PipelineRunSource {
	runId: string;
	sourceId: string;
	/** Last step successfully completed. Starts at `'ingested'`. */
	currentStep: string;
	status: PipelineRunSourceStatus;
	errorMessage: string | null;
	updatedAt: Date;
}

/** Input for upserting a pipeline_run_sources row. */
export interface UpsertPipelineRunSourceInput {
	runId: string;
	sourceId: string;
	currentStep: string;
	status: PipelineRunSourceStatus;
	errorMessage?: string | null;
}
