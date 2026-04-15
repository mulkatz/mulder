/**
 * Pipeline orchestrator — chains the v1.0 pipeline steps with cursor-based
 * resume.
 *
 * The orchestrator is a coordinator. It does not reimplement any step
 * logic — it calls the existing `executeIngest`, `executeExtract`,
 * `executeSegment`, `executeEnrich`, `executeEmbed`, `executeGraph`
 * functions and persists per-source progress in the
 * `pipeline_runs` / `pipeline_run_sources` tables. A failed source is
 * marked `failed` and the batch continues.
 *
 * Workers (M7) will eventually drive the same step functions and reuse
 * the same `pipeline_runs` schema. This module is intentionally
 * synchronous in-process for v1.0.
 *
 * @see docs/specs/36_pipeline_orchestrator.spec.md
 * @see docs/functional-spec.md §3.1, §3.2, §3.3
 */

import { performance } from 'node:perf_hooks';
import type { Logger, MulderConfig, Services, Source, SourceStatus, StepError, Story, StoryStatus } from '@mulder/core';
import {
	completedStepsFromProgress,
	createChildLogger,
	finalizeBudgetReservation,
	finalizeMonthlyBudgetReservation,
	createPipelineRun,
	finalizePipelineRun,
	findMonthlyBudgetReservationByRunId,
	findAllSources,
	findPipelineRunById,
	findPipelineRunSourcesByRunId,
	findSourceById,
	findStoriesBySourceId,
	PIPELINE_ERROR_CODES,
	PipelineError,
	upsertPipelineRunSource,
} from '@mulder/core';
import type pg from 'pg';
import { execute as executeAnalyze } from '../analyze/index.js';
import { execute as executeEmbed } from '../embed/index.js';
import { execute as executeEnrich } from '../enrich/index.js';
import { execute as executeExtract } from '../extract/index.js';
import { execute as executeGraph } from '../graph/index.js';
import { execute as executeIngest } from '../ingest/index.js';
import { execute as executeSegment } from '../segment/index.js';
import type {
	PipelineGlobalAnalysisOutcome,
	PipelineRunInput,
	PipelineRunOptions,
	PipelineRunResult,
	PipelineRunSourceOutcome,
	PipelineStepName,
} from './types.js';

// Re-export types for the package barrel.
export type {
	PipelineGlobalAnalysisOutcome,
	PipelineRunInput,
	PipelineRunOptions,
	PipelineRunResult,
	PipelineRunSourceOutcome,
	PipelineStepName,
} from './types.js';

// ────────────────────────────────────────────────────────────
// Step ordering
// ────────────────────────────────────────────────────────────

/**
 * Ordered v1.0 pipeline steps. Ground (v2.0) and Analyze (v2.0) are
 * deliberately omitted — when they ship, they will be appended to the
 * tuple and `plannedSteps` will naturally pick them up.
 *
 * Exported so the CLI and tests can validate `--from`/`--up-to`.
 */
export const STEP_ORDER: readonly PipelineStepName[] = [
	'ingest',
	'extract',
	'segment',
	'enrich',
	'embed',
	'graph',
] as const;

/** Source statuses ordered to match `STEP_ORDER` (the state *after* each step). */
const SOURCE_STATUS_ORDER: readonly SourceStatus[] = [
	'ingested',
	'extracted',
	'segmented',
	'enriched',
	'embedded',
	'graphed',
	'analyzed',
] as const;

/** Story statuses ordered (the state *after* each per-story step). */
const STORY_STATUS_ORDER: readonly StoryStatus[] = [
	'segmented',
	'enriched',
	'embedded',
	'graphed',
	'analyzed',
] as const;

const STEP_NAME = 'pipeline-orchestrator';

// ────────────────────────────────────────────────────────────
// Pure helpers
// ────────────────────────────────────────────────────────────

/**
 * Type guard: does `value` have a string `code` property? Used to read the
 * `code` field off a caught `unknown` error without resorting to `as`
 * assertions. Uses `Reflect.get` so no type assertions are needed.
 */
function hasStringCode(value: unknown): value is { code: string } {
	return typeof value === 'object' && value !== null && typeof Reflect.get(value, 'code') === 'string';
}

function stepIndex(step: PipelineStepName): number {
	return STEP_ORDER.indexOf(step);
}

function sourceStatusIndex(status: SourceStatus): number {
	return SOURCE_STATUS_ORDER.indexOf(status);
}

function storyStatusIndex(status: StoryStatus): number {
	return STORY_STATUS_ORDER.indexOf(status);
}

/** The source status that a step transitions the source *into* on success. */
function targetSourceStatusForStep(step: PipelineStepName): SourceStatus {
	switch (step) {
		case 'ingest':
			return 'ingested';
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

/** The story status that a per-story step transitions the story *into* on success. */
function targetStoryStatusForStep(step: PipelineStepName): StoryStatus | null {
	switch (step) {
		case 'enrich':
			return 'enriched';
		case 'embed':
			return 'embedded';
		case 'graph':
			return 'graphed';
		default:
			return null;
	}
}

/**
 * Whether a step should be attempted for a source given its current status
 * and the statuses of any of its stories. Mirrors §4.5 of the spec.
 *
 * - For source-level steps (`extract`, `segment`), the source must be at
 *   the prior status (`ingested` for extract, `extracted` for segment).
 * - For story-fanout steps (`enrich`, `embed`, `graph`), the source must
 *   be at the prior status OR at least one story must be at the prior
 *   story status.
 * - If `options.force` is true, the eligibility relaxes — the per-step
 *   `execute*` call will trigger its own cascading reset.
 * - If the source is already past the step (e.g. status `segmented` and
 *   we asked for `extract`), returns `false` and the orchestrator leaves
 *   `current_step` at the higher-reached step.
 */
export function shouldRun(
	step: PipelineStepName,
	sourceStatus: SourceStatus,
	storyStatuses: StoryStatus[],
	options: PipelineRunOptions,
): boolean {
	if (step === 'ingest') {
		// Ingest is handled outside the per-source loop. Should never be
		// asked of `shouldRun`, but defensively return false.
		return false;
	}

	const targetIdx = sourceStatusIndex(targetSourceStatusForStep(step));
	const currentSrcIdx = sourceStatusIndex(sourceStatus);

	// Already past this step's target → skip (unless --force).
	if (currentSrcIdx >= targetIdx && !options.force) {
		return false;
	}

	if (options.force) {
		// Retry path: trust the caller. Per-step execute will reset.
		return true;
	}

	// Source-level steps require the source to be at the immediately prior status.
	if (step === 'extract') {
		return sourceStatus === 'ingested';
	}
	if (step === 'segment') {
		return sourceStatus === 'extracted';
	}

	// Story-fanout steps: source at prior status OR any story at prior story status.
	const targetStoryStatus = targetStoryStatusForStep(step);
	if (targetStoryStatus === null) {
		return false;
	}
	const targetStoryIdx = storyStatusIndex(targetStoryStatus);

	if (step === 'enrich') {
		if (sourceStatus === 'segmented') return true;
		return storyStatuses.some((s) => storyStatusIndex(s) < targetStoryIdx);
	}
	if (step === 'embed') {
		if (sourceStatus === 'enriched') return true;
		return storyStatuses.some((s) => storyStatusIndex(s) < targetStoryIdx);
	}
	if (step === 'graph') {
		if (sourceStatus === 'embedded') return true;
		return storyStatuses.some((s) => storyStatusIndex(s) < targetStoryIdx);
	}

	return false;
}

/** Computes the slice of `STEP_ORDER` between `from` and `upTo` (both inclusive). */
function computePlannedSteps(options: PipelineRunOptions): PipelineStepName[] {
	const fromIdx = options.from ? stepIndex(options.from) : 0;
	const upToIdx = options.upTo ? stepIndex(options.upTo) : STEP_ORDER.length - 1;

	if (fromIdx === -1) {
		throw new PipelineError(`Unknown step in --from: ${options.from}`, PIPELINE_ERROR_CODES.PIPELINE_WRONG_STATUS, {
			context: { from: options.from, validSteps: [...STEP_ORDER] },
		});
	}
	if (upToIdx === -1) {
		throw new PipelineError(`Unknown step in --up-to: ${options.upTo}`, PIPELINE_ERROR_CODES.PIPELINE_WRONG_STATUS, {
			context: { upTo: options.upTo, validSteps: [...STEP_ORDER] },
		});
	}
	if (fromIdx > upToIdx) {
		throw new PipelineError(
			`--from ${options.from} comes after --up-to ${options.upTo} in step order`,
			PIPELINE_ERROR_CODES.PIPELINE_WRONG_STATUS,
			{ context: { from: options.from, upTo: options.upTo } },
		);
	}

	return STEP_ORDER.slice(fromIdx, upToIdx + 1);
}

function createSkippedGlobalAnalysis(summary: string): PipelineGlobalAnalysisOutcome {
	return {
		status: 'skipped',
		summary,
		result: null,
	};
}

async function reconcileRunBudgetReservation(
	pool: pg.Pool,
	config: MulderConfig,
	runId: string,
): Promise<void> {
	const reservation = await findMonthlyBudgetReservationByRunId(pool, runId);
	if (!reservation) {
		return;
	}

	const source = await findSourceById(pool, reservation.sourceId);
	if (!source) {
		await finalizeMonthlyBudgetReservation(pool, {
			runId,
			status: 'released',
			committedUsd: 0,
			releasedUsd: reservation.reservedEstimatedUsd,
			metadata: { reason: 'source_missing' },
		});
		return;
	}

	const progressRows = await findPipelineRunSourcesByRunId(pool, runId);
	const progress = progressRows.find((row) => row.sourceId === reservation.sourceId);
	const completedSteps = progress
		? completedStepsFromProgress(reservation.plannedSteps, progress.currentStep, progress.status)
		: [];
	const finalization = finalizeBudgetReservation({
		source,
		plannedSteps: reservation.plannedSteps,
		completedSteps,
		budget: config.api.budget,
		extraction: config.extraction,
		force: reservation.metadata.force === true,
	});

	await finalizeMonthlyBudgetReservation(pool, {
		runId,
		status: finalization.status,
		committedUsd: finalization.committedUsd,
		releasedUsd: finalization.releasedUsd,
		metadata: {
			progress_status: progress?.status ?? null,
			current_step: progress?.currentStep ?? null,
		},
	});
}

function summarizeGlobalAnalyzeResult(result: Awaited<ReturnType<typeof executeAnalyze>>): string {
	if (result.data.mode === 'full') {
		return `${result.data.successCount} successful, ${result.data.partialCount} partial, ${result.data.failedCount} failed, ${result.data.skippedCount} skipped`;
	}

	return result.status;
}

// ────────────────────────────────────────────────────────────
// Phase 1: Source enumeration
// ────────────────────────────────────────────────────────────

interface EnumerationOutcome {
	sources: Source[];
	/** Per-file ingest failures, written to pipeline_run_sources later. */
	ingestErrors: StepError[];
}

/**
 * Discovers the sources to process for this run.
 *
 * - Retry path (`options.sourceIds` set): load sources by id; missing → error.
 * - Ingest path (`plannedSteps` includes `'ingest'`): call `executeIngest`,
 *   load resulting sources from the DB.
 * - Resume path (no ingest, no sourceIds): enumerate via `findAllSources`
 *   filtered to a status compatible with the first planned step.
 */
async function enumerateSources(
	input: PipelineRunInput,
	plannedSteps: PipelineStepName[],
	pool: pg.Pool,
	config: MulderConfig,
	services: Services,
	logger: Logger,
): Promise<EnumerationOutcome> {
	const options = input.options;

	// Retry path
	if (options.sourceIds && options.sourceIds.length > 0) {
		const sources: Source[] = [];
		for (const sourceId of options.sourceIds) {
			const src = await findSourceById(pool, sourceId);
			if (!src) {
				throw new PipelineError(`Source not found: ${sourceId}`, PIPELINE_ERROR_CODES.PIPELINE_SOURCE_NOT_FOUND, {
					context: { sourceId },
				});
			}
			sources.push(src);
		}
		return { sources, ingestErrors: [] };
	}

	// Ingest path
	if (plannedSteps.includes('ingest')) {
		if (!input.path) {
			throw new PipelineError(
				'Pipeline run with ingest step requires <path>',
				PIPELINE_ERROR_CODES.PIPELINE_WRONG_STATUS,
				{ context: { plannedSteps } },
			);
		}
		const ingestResult = await executeIngest({ path: input.path }, config, services, pool, logger);
		const sources: Source[] = [];
		for (const file of ingestResult.data) {
			const src = await findSourceById(pool, file.sourceId);
			if (src) {
				sources.push(src);
			}
		}
		return { sources, ingestErrors: ingestResult.errors };
	}

	// Resume path: pull sources whose status is compatible with the first planned step.
	// Eligible source statuses for each step's first run.
	const firstStep = plannedSteps[0];
	const eligibleStatuses: SourceStatus[] = [];
	switch (firstStep) {
		case 'extract':
			eligibleStatuses.push('ingested');
			break;
		case 'segment':
			eligibleStatuses.push('extracted');
			break;
		case 'enrich':
			eligibleStatuses.push('segmented');
			break;
		case 'embed':
			eligibleStatuses.push('enriched', 'segmented');
			break;
		case 'graph':
			eligibleStatuses.push('embedded', 'enriched', 'segmented');
			break;
		default:
			eligibleStatuses.push('ingested');
	}

	const collected: Source[] = [];
	for (const status of eligibleStatuses) {
		const batch = await findAllSources(pool, { status, limit: 1000 });
		collected.push(...batch);
	}
	// Dedup by id (a source might match multiple statuses across iterations, defensive).
	const seen = new Set<string>();
	const unique: Source[] = [];
	for (const src of collected) {
		if (!seen.has(src.id)) {
			seen.add(src.id);
			unique.push(src);
		}
	}
	return { sources: unique, ingestErrors: [] };
}

// ────────────────────────────────────────────────────────────
// Phase 2: Per-source processing
// ────────────────────────────────────────────────────────────

interface ProcessSourceContext {
	runId: string;
	plannedSteps: PipelineStepName[];
	options: PipelineRunOptions;
	config: MulderConfig;
	services: Services;
	pool: pg.Pool;
	logger: Logger;
}

interface ProcessSourceResult {
	finalStep: PipelineStepName | null;
	status: 'completed' | 'failed';
	errorMessage: string | null;
}

/** Processes a single source through the planned steps. Catches per-step errors. */
async function processSource(source: Source, ctx: ProcessSourceContext): Promise<ProcessSourceResult> {
	const sourceLog = createChildLogger(ctx.logger, { sourceId: source.id });
	let finalStep: PipelineStepName | null = null;
	let lastError: { message: string; code: string } | null = null;

	// Steps to attempt for this source: planned steps minus ingest.
	const stepsForSource = ctx.plannedSteps.filter((s): s is Exclude<PipelineStepName, 'ingest'> => s !== 'ingest');

	// Re-load the source to ensure status is current after any prior step.
	let currentSource: Source = source;

	for (const step of stepsForSource) {
		// Refresh the source status before each step (the previous iteration may have changed it).
		const refreshed = await findSourceById(ctx.pool, currentSource.id);
		if (!refreshed) {
			lastError = {
				message: `Source disappeared mid-pipeline: ${currentSource.id}`,
				code: PIPELINE_ERROR_CODES.PIPELINE_SOURCE_NOT_FOUND,
			};
			break;
		}
		currentSource = refreshed;

		// Load story statuses (only required for fanout steps; harmless to compute always).
		const stories = await findStoriesBySourceId(ctx.pool, currentSource.id);
		const storyStatuses = stories.map((s) => s.status);

		if (!shouldRun(step, currentSource.status, storyStatuses, ctx.options)) {
			sourceLog.debug({ step, sourceStatus: currentSource.status }, 'pipeline.source.step.skipped');
			continue;
		}

		const stepStart = performance.now();
		sourceLog.info({ step }, 'pipeline.source.start');

		try {
			await runStepForSource(step, currentSource, stories, ctx);
			finalStep = step;
			const durationMs = Math.round(performance.now() - stepStart);
			sourceLog.info({ step, duration_ms: durationMs }, 'pipeline.source.step.ok');
			await upsertPipelineRunSource(ctx.pool, {
				runId: ctx.runId,
				sourceId: currentSource.id,
				currentStep: step,
				status: 'processing',
			});
		} catch (cause: unknown) {
			const message = cause instanceof Error ? cause.message : String(cause);
			const code = hasStringCode(cause) ? cause.code : PIPELINE_ERROR_CODES.PIPELINE_STEP_FAILED;
			lastError = { message, code };
			sourceLog.warn({ step, errorCode: code, errorMessage: message }, 'pipeline.source.step.failed');
			break;
		}
	}

	if (lastError) {
		await upsertPipelineRunSource(ctx.pool, {
			runId: ctx.runId,
			sourceId: currentSource.id,
			currentStep: finalStep ?? 'ingest',
			status: 'failed',
			errorMessage: lastError.message,
		});
		return { finalStep, status: 'failed', errorMessage: lastError.message };
	}

	await upsertPipelineRunSource(ctx.pool, {
		runId: ctx.runId,
		sourceId: currentSource.id,
		currentStep: finalStep ?? 'ingest',
		status: 'completed',
	});
	return { finalStep, status: 'completed', errorMessage: null };
}

/** Dispatches a single step for a single source. */
async function runStepForSource(
	step: Exclude<PipelineStepName, 'ingest'>,
	source: Source,
	stories: Story[],
	ctx: ProcessSourceContext,
): Promise<void> {
	const force = ctx.options.force ?? false;

	if (step === 'extract') {
		await executeExtract({ sourceId: source.id, force }, ctx.config, ctx.services, ctx.pool, ctx.logger);
		return;
	}
	if (step === 'segment') {
		await executeSegment({ sourceId: source.id, force }, ctx.config, ctx.services, ctx.pool, ctx.logger);
		return;
	}

	// Fanout steps — iterate stories. Re-fetch to pick up newly created stories from a prior step.
	const freshStories = stories.length > 0 ? stories : await findStoriesBySourceId(ctx.pool, source.id);

	if (step === 'enrich') {
		const target = storyStatusIndex('enriched');
		for (const story of freshStories) {
			if (storyStatusIndex(story.status) >= target && !force) {
				continue;
			}
			await executeEnrich({ storyId: story.id, force }, ctx.config, ctx.services, ctx.pool, ctx.logger);
		}
		return;
	}
	if (step === 'embed') {
		const target = storyStatusIndex('embedded');
		for (const story of freshStories) {
			if (storyStatusIndex(story.status) >= target && !force) {
				continue;
			}
			await executeEmbed({ storyId: story.id, force }, ctx.config, ctx.services, ctx.pool, ctx.logger);
		}
		return;
	}
	if (step === 'graph') {
		const target = storyStatusIndex('graphed');
		for (const story of freshStories) {
			if (storyStatusIndex(story.status) >= target && !force) {
				continue;
			}
			await executeGraph({ storyId: story.id, force }, ctx.config, ctx.services, ctx.pool, ctx.logger);
		}
		return;
	}
}

// ────────────────────────────────────────────────────────────
// Main execute function
// ────────────────────────────────────────────────────────────

/**
 * Executes a pipeline run.
 *
 * Validates options, computes the planned step slice, optionally enumerates
 * sources via ingest or resume, then iterates each source through the
 * planned steps with cursor-based progress tracking.
 *
 * `--dry-run` returns immediately after computing the plan, with no DB
 * writes.
 */
export async function execute(
	input: PipelineRunInput,
	config: MulderConfig,
	services: Services,
	pool: pg.Pool | undefined,
	logger: Logger,
): Promise<PipelineRunResult> {
	const startTime = performance.now();
	const options = input.options ?? {};

	// 1. Compute planned steps (validates `from` / `upTo`).
	const plannedSteps = computePlannedSteps(options);

	const log = createChildLogger(logger, { module: STEP_NAME });

	// 2. Dry-run path — print the plan and bail before any DB writes.
	if (options.dryRun) {
		// For dry-run, we cannot enumerate via ingest (no upload). We can
		// estimate the source count for the resume / retry paths, but we
		// avoid running any side effects.
		let dryRunSourceCount = 0;
		if (options.sourceIds && options.sourceIds.length > 0) {
			dryRunSourceCount = options.sourceIds.length;
		} else if (pool && !plannedSteps.includes('ingest')) {
			// Resume path: estimate by listing.
			const firstStep = plannedSteps[0];
			const eligibleStatuses: SourceStatus[] = [];
			switch (firstStep) {
				case 'extract':
					eligibleStatuses.push('ingested');
					break;
				case 'segment':
					eligibleStatuses.push('extracted');
					break;
				case 'enrich':
					eligibleStatuses.push('segmented');
					break;
				case 'embed':
					eligibleStatuses.push('enriched', 'segmented');
					break;
				case 'graph':
					eligibleStatuses.push('embedded', 'enriched', 'segmented');
					break;
				default:
					break;
			}
			for (const status of eligibleStatuses) {
				const batch = await findAllSources(pool, { status, limit: 1000 });
				dryRunSourceCount += batch.length;
			}
		}

		log.info({ plannedSteps, dryRunSourceCount }, 'pipeline.run.dry_run');

		const dryRunAnalysis =
			config.analysis.enabled && plannedSteps.includes('graph') && options.upTo === undefined
				? createSkippedGlobalAnalysis('dry run — global analyze would run after graph')
				: createSkippedGlobalAnalysis('dry run — global analyze would not run');

		return {
			status: 'success',
			runId: '',
			data: {
				runId: '',
				tag: options.tag ?? null,
				plannedSteps,
				totalSources: dryRunSourceCount,
				completedSources: 0,
				failedSources: 0,
				skippedSources: dryRunSourceCount,
				sources: [],
				analysis: dryRunAnalysis,
			},
			errors: [],
			metadata: {
				duration_ms: Math.round(performance.now() - startTime),
				items_processed: 0,
				items_skipped: dryRunSourceCount,
			},
		};
	}

	if (!pool) {
		throw new PipelineError('Database pool is required for pipeline run', PIPELINE_ERROR_CODES.PIPELINE_WRONG_STATUS, {
			context: { plannedSteps },
		});
	}

	// 3. Create or reuse the run row.
	const run = options.runId
		? await findPipelineRunById(pool, options.runId)
		: await createPipelineRun(pool, {
				tag: options.tag ?? null,
				options: serializeOptions(options),
			});
	if (!run) {
		throw new PipelineError(`Pipeline run not found: ${options.runId}`, PIPELINE_ERROR_CODES.PIPELINE_RUN_NOT_FOUND, {
			context: { runId: options.runId },
		});
	}
	const runLog = createChildLogger(log, { runId: run.id });
	runLog.info({ runId: run.id, tag: run.tag, plannedSteps }, 'pipeline.run.start');

	// 4. Enumerate sources (Phase 1).
	let enumeration: EnumerationOutcome;
	try {
		enumeration = await enumerateSources(input, plannedSteps, pool, config, services, runLog);
	} catch (cause: unknown) {
		// Source enumeration failures are fatal: finalize the run as failed.
		await finalizePipelineRun(pool, run.id, 'failed').catch(() => undefined);
		throw cause;
	}

	// Phase 2 + finalisation are wrapped in a try/catch so that any
	// unexpected throw (e.g. DB failure during `upsertPipelineRunSource`
	// or `findStoriesBySourceId`) still marks the run as `failed` rather
	// than leaving `pipeline_runs` stuck at `status='running'`. Spec §3.2
	// requires crash-safe resume; without this guard an orphaned row
	// would break `pipeline status` and `pipeline retry` until a reaper
	// (M7/M8) exists. The nested `.catch(() => undefined)` is
	// intentional: if the DB is down, we still want to surface the
	// original error rather than masking it with a finalisation failure.
	try {
		const { sources, ingestErrors } = enumeration;
		const errors: StepError[] = [...ingestErrors];

		// Seed pending rows for all enumerated sources.
		for (const src of sources) {
			await upsertPipelineRunSource(pool, {
				runId: run.id,
				sourceId: src.id,
				currentStep: 'ingest',
				status: 'pending',
			});
		}

		// 5. Process each source (Phase 2).
		const sourceOutcomes: PipelineRunSourceOutcome[] = [];
		let completedCount = 0;
		let failedCount = 0;

		const ctx: ProcessSourceContext = {
			runId: run.id,
			plannedSteps,
			options,
			config,
			services,
			pool,
			logger: runLog,
		};

		for (const src of sources) {
			const result = await processSource(src, ctx);
			sourceOutcomes.push({
				sourceId: src.id,
				finalStep: result.finalStep,
				status: result.status,
				errorMessage: result.errorMessage,
			});
			if (result.status === 'completed') {
				completedCount++;
			} else {
				failedCount++;
				errors.push({
					code: PIPELINE_ERROR_CODES.PIPELINE_STEP_FAILED,
					message: result.errorMessage ?? 'unknown error',
				});
			}
		}

		let globalAnalysis: PipelineGlobalAnalysisOutcome;
		if (options.upTo !== undefined) {
			globalAnalysis = createSkippedGlobalAnalysis('pipeline stopped before global analyze');
		} else if (!plannedSteps.includes('graph')) {
			globalAnalysis = createSkippedGlobalAnalysis('planned steps stop before graph');
		} else if (!config.analysis.enabled) {
			globalAnalysis = createSkippedGlobalAnalysis('analysis disabled by config');
		} else if (completedCount === 0) {
			globalAnalysis = createSkippedGlobalAnalysis('no sources reached graph successfully');
		} else {
			const analyzeResult = await executeAnalyze({ full: true }, config, services, pool, runLog);
			errors.push(...analyzeResult.errors);
			globalAnalysis = {
				status: analyzeResult.status,
				summary: summarizeGlobalAnalyzeResult(analyzeResult),
				result: analyzeResult,
			};
		}

		// 6. Finalisation (Phase 3).
		let runStatus: 'success' | 'partial' | 'failed';
		if (sources.length === 0) {
			runStatus = 'success';
		} else if (failedCount === 0) {
			runStatus = 'success';
		} else if (completedCount === 0) {
			runStatus = 'failed';
		} else {
			runStatus = 'partial';
		}

		if (globalAnalysis.status === 'failed') {
			runStatus = 'failed';
		} else if (globalAnalysis.status === 'partial' && runStatus !== 'failed') {
			runStatus = 'partial';
		}

		const finalRunStatus = runStatus === 'success' ? 'completed' : runStatus === 'partial' ? 'partial' : 'failed';
		await finalizePipelineRun(pool, run.id, finalRunStatus);
		await reconcileRunBudgetReservation(pool, config, run.id);

		const durationMs = Math.round(performance.now() - startTime);
		runLog.info(
			{
				runId: run.id,
				status: finalRunStatus,
				totalSources: sources.length,
				completedSources: completedCount,
				failedSources: failedCount,
				globalAnalysisStatus: globalAnalysis.status,
			},
			'pipeline.run.finish',
		);

		return {
			status: runStatus,
			runId: run.id,
			data: {
				runId: run.id,
				tag: run.tag,
				plannedSteps,
				totalSources: sources.length,
				completedSources: completedCount,
				failedSources: failedCount,
				skippedSources: 0,
				sources: sourceOutcomes,
				analysis: globalAnalysis,
			},
			errors,
			metadata: {
				duration_ms: durationMs,
				items_processed: completedCount + (globalAnalysis.result?.metadata.items_processed ?? 0),
				items_skipped: globalAnalysis.result?.metadata.items_skipped ?? 0,
			},
		};
	} catch (cause) {
		await finalizePipelineRun(pool, run.id, 'failed').catch(() => undefined);
		await reconcileRunBudgetReservation(pool, config, run.id).catch(() => undefined);
		throw cause;
	}
}

/** Serializes user-facing options to the JSONB column on `pipeline_runs`. */
function serializeOptions(options: PipelineRunOptions): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	if (options.upTo) out.upTo = options.upTo;
	if (options.from) out.from = options.from;
	if (options.tag) out.tag = options.tag;
	if (options.dryRun) out.dryRun = true;
	if (options.force) out.force = true;
	if (options.sourceIds && options.sourceIds.length > 0) out.sourceIds = options.sourceIds;
	return out;
}
