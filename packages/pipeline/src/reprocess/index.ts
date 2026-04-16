/**
 * Selective reprocessing planner and executor.
 */

import { performance } from 'node:perf_hooks';
import type {
	Logger,
	MulderConfig,
	Services,
	SourceStatus,
	SourceStepStatus,
	SourceWithSteps,
	StepError,
} from '@mulder/core';
import {
	computeReprocessConfigHash,
	createChildLogger,
	createPipelineRun,
	finalizePipelineRun,
	findSourcesWithSteps,
	findStoriesBySourceId,
	getAllStepConfigHashes,
	upsertPipelineRunSource,
	upsertSourceStep,
} from '@mulder/core';
import type pg from 'pg';
import { execute as executeAnalyze } from '../analyze/index.js';
import { execute as executeEmbed, forceCleanupSource as forceCleanupEmbedSource } from '../embed/index.js';
import { execute as executeEnrich, forceCleanupSource as forceCleanupEnrichSource } from '../enrich/index.js';
import { execute as executeExtract } from '../extract/index.js';
import { execute as executeGraph, forceCleanupSource as forceCleanupGraphSource } from '../graph/index.js';
import { execute as executeSegment } from '../segment/index.js';
import type {
	ReprocessInput,
	ReprocessPlan,
	ReprocessPlannedStep,
	ReprocessPlanReason,
	ReprocessResult,
	ReprocessRunSummary,
	ReprocessSourcePlan,
	ReprocessStepName,
} from './types.js';

export type {
	ReprocessInput,
	ReprocessPlan,
	ReprocessPlannedStep,
	ReprocessPlanReason,
	ReprocessResult,
	ReprocessRunSummary,
	ReprocessSourcePlan,
	ReprocessStepName,
} from './types.js';

const STEP_ORDER: readonly ReprocessStepName[] = ['extract', 'segment', 'enrich', 'embed', 'graph'] as const;
const SOURCE_STATUS_ORDER: readonly SourceStatus[] = [
	'ingested',
	'extracted',
	'segmented',
	'enriched',
	'embedded',
	'graphed',
	'analyzed',
] as const;
const STEP_PREREQUISITES: Record<ReprocessStepName, SourceStatus> = {
	extract: 'ingested',
	segment: 'extracted',
	enrich: 'segmented',
	embed: 'enriched',
	graph: 'embedded',
};
const REQUESTED_STEP_MIN_STATUS: Record<ReprocessStepName, SourceStatus> = {
	extract: 'ingested',
	segment: 'extracted',
	enrich: 'segmented',
	embed: 'enriched',
	graph: 'embedded',
};
const STEP_IMPACT: Record<ReprocessStepName, readonly ReprocessStepName[]> = {
	extract: ['extract', 'segment', 'enrich', 'embed', 'graph'],
	segment: ['segment', 'enrich', 'embed', 'graph'],
	enrich: ['enrich', 'graph'],
	embed: ['embed', 'graph'],
	graph: ['graph'],
};
const TRACKED_STEP_SET = new Set<ReprocessStepName>(STEP_ORDER);

interface SourceStepRecord {
	stepName: string;
	status: SourceStepStatus;
	configHash: string | null;
}

interface PlannedSourceResult {
	plan: ReprocessSourcePlan;
	forceFirstStep: boolean;
}

function sourceStatusIndex(status: SourceStatus): number {
	return SOURCE_STATUS_ORDER.indexOf(status);
}

function isTrackedStep(stepName: string): stepName is ReprocessStepName {
	return TRACKED_STEP_SET.has(stepName as ReprocessStepName);
}

function findStoredHash(steps: SourceStepRecord[], stepName: ReprocessStepName): string | null {
	const match = steps.find((step) => step.stepName === stepName);
	return match?.configHash ?? null;
}

function findStoredStep(steps: SourceStepRecord[], stepName: ReprocessStepName | 'analyze'): SourceStepRecord | null {
	return steps.find((step) => step.stepName === stepName) ?? null;
}

function hasReachedAnalyzePrerequisite(source: SourceWithSteps): boolean {
	if (sourceStatusIndex(source.source.status) >= sourceStatusIndex('graphed')) {
		return true;
	}

	const graphStep = findStoredStep(
		source.steps.map((step) => ({
			stepName: step.stepName,
			status: step.status,
			configHash: step.configHash,
		})),
		'graph',
	);
	return graphStep?.status === 'completed';
}

function buildCurrentHashes(config: MulderConfig): Record<ReprocessStepName, string> {
	return getAllStepConfigHashes(config);
}

function buildCurrentAnalyzeHash(config: MulderConfig): string {
	return computeReprocessConfigHash(config, 'analyze');
}

function hasDirtyTrackedStep(steps: SourceStepRecord[], stepName: ReprocessStepName, currentHash: string): boolean {
	const storedStep = findStoredStep(steps, stepName);
	if (!storedStep) {
		return true;
	}
	if (storedStep.status !== 'completed') {
		return true;
	}
	return storedStep.configHash !== currentHash;
}

function hasDirtyAnalyzeStep(steps: SourceStepRecord[], currentAnalyzeHash: string): boolean {
	const storedStep = findStoredStep(steps, 'analyze');
	if (!storedStep) {
		return true;
	}
	if (storedStep.status !== 'completed') {
		return true;
	}
	return storedStep.configHash !== currentAnalyzeHash;
}

function buildImpactPlan(
	requestedStep: ReprocessStepName,
	currentHashes: Record<ReprocessStepName, string>,
	sourceSteps: SourceStepRecord[],
	sourceStatus: SourceStatus,
	reason: ReprocessPlanReason,
): PlannedSourceResult {
	const plannedSteps: ReprocessPlannedStep[] = [];
	const forceGraphCleanup = requestedStep === 'enrich';

	for (const [index, stepName] of STEP_IMPACT[requestedStep].entries()) {
		plannedSteps.push({
			stepName,
			force: index === 0 || (forceGraphCleanup && stepName === 'graph'),
			reason: index === 0 ? reason : 'downstream',
			currentHash: currentHashes[stepName],
			storedHash: findStoredHash(sourceSteps, stepName),
		});
	}

	return {
		plan: {
			sourceId: '',
			filename: '',
			status: sourceStatus,
			planned: true,
			skipReason: null,
			steps: plannedSteps,
		},
		forceFirstStep: true,
	};
}

function buildSelectivePlan(
	sourceId: string,
	filename: string,
	status: SourceStatus,
	sourceSteps: SourceStepRecord[],
	currentHashes: Record<ReprocessStepName, string>,
): PlannedSourceResult {
	const statusIndex = sourceStatusIndex(status);
	for (const stepName of STEP_ORDER) {
		if (statusIndex < sourceStatusIndex(STEP_PREREQUISITES[stepName])) {
			continue;
		}
		if (hasDirtyTrackedStep(sourceSteps, stepName, currentHashes[stepName])) {
			const result = buildImpactPlan(stepName, currentHashes, sourceSteps, status, 'missing-history');
			result.plan.sourceId = sourceId;
			result.plan.filename = filename;
			return result;
		}
	}

	return {
		plan: {
			sourceId,
			filename,
			status,
			planned: false,
			skipReason: 'up to date',
			steps: [],
		},
		forceFirstStep: false,
	};
}

function planSource(
	source: SourceWithSteps,
	currentHashes: Record<ReprocessStepName, string>,
	requestedStep?: ReprocessStepName,
): PlannedSourceResult {
	const sourceSteps: SourceStepRecord[] = source.steps
		.filter((step) => isTrackedStep(step.stepName))
		.map((step) => ({ stepName: step.stepName, status: step.status, configHash: step.configHash }));

	if (requestedStep) {
		if (sourceStatusIndex(source.source.status) < sourceStatusIndex(REQUESTED_STEP_MIN_STATUS[requestedStep])) {
			return {
				plan: {
					sourceId: source.source.id,
					filename: source.source.filename,
					status: source.source.status,
					planned: false,
					skipReason: `has not reached ${requestedStep}`,
					steps: [],
				},
				forceFirstStep: false,
			};
		}
		const result = buildImpactPlan(requestedStep, currentHashes, sourceSteps, source.source.status, 'forced-step');
		result.plan.sourceId = source.source.id;
		result.plan.filename = source.source.filename;
		return result;
	}

	return buildSelectivePlan(source.source.id, source.source.filename, source.source.status, sourceSteps, currentHashes);
}

function shouldPlanGlobalAnalyze(
	sources: SourceWithSteps[],
	config: MulderConfig,
	currentAnalyzeHash: string,
	requestedStep?: ReprocessStepName,
): boolean {
	if (!config.analysis.enabled) {
		return false;
	}
	if (requestedStep) {
		return false;
	}

	return sources.some((source) => {
		if (!hasReachedAnalyzePrerequisite(source)) {
			return false;
		}

		const sourceSteps: SourceStepRecord[] = source.steps.map((step) => ({
			stepName: step.stepName,
			status: step.status,
			configHash: step.configHash,
		}));
		return hasDirtyAnalyzeStep(sourceSteps, currentAnalyzeHash);
	});
}

async function executeStep(
	stepName: ReprocessStepName,
	sourceId: string,
	force: boolean,
	config: MulderConfig,
	services: Services,
	pool: pg.Pool,
	logger: Logger,
): Promise<{ status: 'success' | 'partial' | 'failed'; errors: StepError[] }> {
	switch (stepName) {
		case 'extract': {
			const result = await executeExtract({ sourceId, force }, config, services, pool, logger);
			return { status: result.status, errors: result.errors };
		}
		case 'segment': {
			const result = await executeSegment({ sourceId, force }, config, services, pool, logger);
			return { status: result.status, errors: result.errors };
		}
		case 'enrich': {
			const stories = await findStoriesBySourceId(pool, sourceId);
			if (stories.length === 0) {
				return { status: 'success', errors: [] };
			}
			if (force) {
				await forceCleanupEnrichSource(sourceId, pool, logger);
			}
			const stepErrors: StepError[] = [];
			let hasFailure = false;
			let hasSuccess = false;
			for (const story of stories) {
				try {
					const result = await executeEnrich({ storyId: story.id, force: false }, config, services, pool, logger);
					stepErrors.push(...result.errors);
					if (result.status === 'failed') {
						hasFailure = true;
					} else {
						hasSuccess = true;
					}
				} catch (error: unknown) {
					hasFailure = true;
					stepErrors.push({
						code: 'REPROCESS_STEP_FAILED',
						message: `${sourceId}:${story.id}: ${error instanceof Error ? error.message : String(error)}`,
					});
				}
			}
			return {
				status: hasFailure ? (hasSuccess ? 'partial' : 'failed') : stepErrors.length > 0 ? 'partial' : 'success',
				errors: stepErrors,
			};
		}
		case 'embed': {
			const stories = await findStoriesBySourceId(pool, sourceId);
			if (stories.length === 0) {
				return { status: 'success', errors: [] };
			}
			if (force) {
				await forceCleanupEmbedSource(sourceId, pool, logger);
			}
			const stepErrors: StepError[] = [];
			let hasFailure = false;
			let hasSuccess = false;
			for (const story of stories) {
				try {
					const result = await executeEmbed({ storyId: story.id, force: false }, config, services, pool, logger);
					stepErrors.push(...result.errors);
					if (result.status === 'failed') {
						hasFailure = true;
					} else {
						hasSuccess = true;
					}
				} catch (error: unknown) {
					hasFailure = true;
					stepErrors.push({
						code: 'REPROCESS_STEP_FAILED',
						message: `${sourceId}:${story.id}: ${error instanceof Error ? error.message : String(error)}`,
					});
				}
			}
			return {
				status: hasFailure ? (hasSuccess ? 'partial' : 'failed') : stepErrors.length > 0 ? 'partial' : 'success',
				errors: stepErrors,
			};
		}
		case 'graph': {
			const stories = await findStoriesBySourceId(pool, sourceId);
			if (stories.length === 0) {
				return { status: 'success', errors: [] };
			}
			if (force) {
				await forceCleanupGraphSource(sourceId, pool, logger);
			}
			const stepErrors: StepError[] = [];
			let hasFailure = false;
			let hasSuccess = false;
			for (const story of stories) {
				try {
					const result = await executeGraph({ storyId: story.id, force: false }, config, services, pool, logger);
					stepErrors.push(...result.errors);
					if (result.status === 'failed') {
						hasFailure = true;
					} else {
						hasSuccess = true;
					}
				} catch (error: unknown) {
					hasFailure = true;
					stepErrors.push({
						code: 'REPROCESS_STEP_FAILED',
						message: `${sourceId}:${story.id}: ${error instanceof Error ? error.message : String(error)}`,
					});
				}
			}
			return {
				status: hasFailure ? (hasSuccess ? 'partial' : 'failed') : stepErrors.length > 0 ? 'partial' : 'success',
				errors: stepErrors,
			};
		}
	}
}

async function runGlobalAnalyzeIfNeeded(
	shouldRun: boolean,
	config: MulderConfig,
	services: Services,
	pool: pg.Pool,
	logger: Logger,
): Promise<ReprocessRunSummary['globalAnalyzeStatus']> {
	if (!shouldRun) {
		return 'not-run';
	}

	const result = await executeAnalyze({ full: true }, config, services, pool, logger);
	if (result.status === 'failed') {
		return 'failed';
	}
	if (result.status === 'partial') {
		return 'partial';
	}
	return 'success';
}

async function persistAnalyzeStepState(
	pool: pg.Pool,
	config: MulderConfig,
	status: Exclude<ReprocessRunSummary['globalAnalyzeStatus'], 'not-run'>,
): Promise<void> {
	const sources = (await findSourcesWithSteps(pool)).filter(hasReachedAnalyzePrerequisite);
	if (sources.length === 0) {
		return;
	}

	const configHash = status === 'success' ? buildCurrentAnalyzeHash(config) : undefined;
	const errorMessage = status === 'success' ? undefined : 'Global analyze reprocess did not complete successfully';

	for (const source of sources) {
		await upsertSourceStep(pool, {
			sourceId: source.source.id,
			stepName: 'analyze',
			status: status === 'success' ? 'completed' : status,
			configHash,
			errorMessage,
		});
	}
}

/**
 * Plans selective reprocessing for all known sources.
 */
export async function planReprocess(
	input: ReprocessInput,
	config: MulderConfig,
	pool: pg.Pool,
): Promise<ReprocessPlan> {
	const currentHashes = buildCurrentHashes(config);
	const currentAnalyzeHash = buildCurrentAnalyzeHash(config);
	const sources = await findSourcesWithSteps(
		pool,
		input.step ? { minimumStatus: REQUESTED_STEP_MIN_STATUS[input.step] } : undefined,
	);
	const plans: ReprocessSourcePlan[] = [];
	let plannedSourceCount = 0;
	let skippedSourceCount = 0;
	let plannedStepCount = 0;

	for (const source of sources) {
		const planned = planSource(source, currentHashes, input.step);
		if (planned.plan.planned) {
			plannedSourceCount++;
			plannedStepCount += planned.plan.steps.length;
		} else {
			skippedSourceCount++;
		}
		plans.push(planned.plan);
	}

	return {
		requestedStep: input.step ?? null,
		mode: input.costEstimate ? 'cost-estimate' : input.dryRun ? 'dry-run' : 'live',
		sourcesConsidered: sources.length,
		plannedSourceCount,
		skippedSourceCount,
		plannedStepCount,
		globalAnalyzePlanned:
			(config.analysis.enabled && plannedSourceCount > 0) ||
			shouldPlanGlobalAnalyze(sources, config, currentAnalyzeHash, input.step),
		sources: plans,
	};
}

/**
 * Executes a selective reprocess batch.
 */
export async function executeReprocess(
	input: ReprocessInput,
	config: MulderConfig,
	services: Services,
	pool: pg.Pool,
	logger: Logger,
): Promise<ReprocessResult> {
	const startTime = performance.now();
	const plan = await planReprocess(input, config, pool);
	const errors: StepError[] = [];
	const runLog = createChildLogger(logger, { step: 'reprocess' });

	if (input.dryRun || input.costEstimate) {
		return {
			status: 'skipped',
			plan,
			summary: {
				runId: null,
				completedSources: 0,
				skippedSources: plan.skippedSourceCount,
				failedSources: 0,
				globalAnalyzeStatus: 'not-run',
			},
			errors,
			metadata: {
				duration_ms: Math.round(performance.now() - startTime),
				items_processed: 0,
				items_skipped: plan.plannedSourceCount,
				items_cached: 0,
			},
		};
	}

	if (plan.plannedSourceCount === 0 && !plan.globalAnalyzePlanned) {
		return {
			status: 'success',
			plan,
			summary: {
				runId: null,
				completedSources: 0,
				skippedSources: plan.skippedSourceCount,
				failedSources: 0,
				globalAnalyzeStatus: 'not-run',
			},
			errors,
			metadata: {
				duration_ms: Math.round(performance.now() - startTime),
				items_processed: 0,
				items_skipped: plan.skippedSourceCount,
				items_cached: 0,
			},
		};
	}

	const run = await createPipelineRun(pool, {
		tag: plan.requestedStep ? `reprocess:${plan.requestedStep}` : 'reprocess',
		options: {
			mode: 'reprocess',
			requestedStep: plan.requestedStep,
			plannedSources: plan.plannedSourceCount,
			plannedSteps: plan.plannedStepCount,
			globalAnalyzePlanned: plan.globalAnalyzePlanned,
		},
	});

	let completedSources = 0;
	let failedSources = 0;
	let partialSources = 0;

	for (const sourcePlan of plan.sources) {
		if (!sourcePlan.planned) {
			continue;
		}

		const sourceLog = createChildLogger(runLog, { sourceId: sourcePlan.sourceId });
		let failedStep: ReprocessStepName | null = null;
		let sourceHadPartial = false;
		let sourceErrors: StepError[] = [];

		for (const plannedStep of sourcePlan.steps) {
			try {
				const result = await executeStep(
					plannedStep.stepName,
					sourcePlan.sourceId,
					plannedStep.force,
					config,
					services,
					pool,
					sourceLog,
				);
				sourceErrors = [...sourceErrors, ...result.errors];
				if (result.status === 'partial') {
					sourceHadPartial = true;
				}
				if (result.status === 'failed') {
					failedStep = plannedStep.stepName;
					break;
				}
			} catch (error: unknown) {
				const message = error instanceof Error ? error.message : String(error);
				errors.push({
					code: 'REPROCESS_STEP_FAILED',
					message: `${sourcePlan.sourceId}:${plannedStep.stepName}: ${message}`,
				});
				failedStep = plannedStep.stepName;
				break;
			}
		}

		if (failedStep) {
			failedSources++;
			for (const stepError of sourceErrors) {
				errors.push(stepError);
			}
			await upsertPipelineRunSource(pool, {
				runId: run.id,
				sourceId: sourcePlan.sourceId,
				currentStep: failedStep,
				status: 'failed',
				errorMessage: `${failedStep} failed during reprocess`,
			});
			continue;
		}

		if (sourceHadPartial) {
			partialSources++;
		}

		completedSources++;
		const lastStep =
			sourcePlan.steps[sourcePlan.steps.length - 1]?.stepName ?? sourcePlan.steps[0]?.stepName ?? 'extract';
		await upsertPipelineRunSource(pool, {
			runId: run.id,
			sourceId: sourcePlan.sourceId,
			currentStep: lastStep,
			status: 'completed',
		});
	}

	const globalAnalyzeStatus = await runGlobalAnalyzeIfNeeded(plan.globalAnalyzePlanned, config, services, pool, runLog);
	if (globalAnalyzeStatus !== 'not-run') {
		await persistAnalyzeStepState(pool, config, globalAnalyzeStatus);
	}

	let status: 'success' | 'partial' | 'failed' = 'success';
	if (failedSources > 0 || partialSources > 0 || globalAnalyzeStatus === 'partial') {
		status = completedSources > 0 ? 'partial' : 'failed';
	}
	if (globalAnalyzeStatus === 'failed' && completedSources === 0) {
		status = 'failed';
	} else if (globalAnalyzeStatus === 'failed') {
		status = 'partial';
	}

	await finalizePipelineRun(
		pool,
		run.id,
		status === 'success' ? 'completed' : status === 'partial' ? 'partial' : 'failed',
	);

	return {
		status,
		plan,
		summary: {
			runId: run.id,
			completedSources,
			skippedSources: plan.skippedSourceCount,
			failedSources,
			globalAnalyzeStatus,
		},
		errors,
		metadata: {
			duration_ms: Math.round(performance.now() - startTime),
			items_processed: completedSources,
			items_skipped: plan.skippedSourceCount,
			items_cached: 0,
		},
	};
}
