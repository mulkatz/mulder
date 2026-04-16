/**
 * CLI command: `mulder pipeline run | status | retry`.
 *
 * Thin wrapper that parses arguments, loads config, creates the service
 * registry, calls the orchestrator (or queries the pipeline-run
 * repository for `status`), and formats output. No business logic.
 *
 * @see docs/specs/36_pipeline_orchestrator.spec.md §4.6
 * @see docs/functional-spec.md §1 (pipeline cmd), §3.1, §3.2, §3.3
 */

import {
	closeAllPools,
	createLogger,
	createServiceRegistry,
	findLatestPipelineRun,
	findLatestPipelineRunSourceForSource,
	findPipelineRunById,
	findPipelineRunSourcesByRunId,
	findSourceById,
	getWorkerPool,
	loadConfig,
	type PipelineRun,
	type PipelineRunSource,
	type PipelineRunSourceStatus,
} from '@mulder/core';
import type { PipelineRunOptions, PipelineStepName } from '@mulder/pipeline';
import { executePipelineRun, STEP_ORDER } from '@mulder/pipeline';
import type { Command } from 'commander';
import {
	collectPdfSourceProfiles,
	estimateForSteps,
	mapPipelineStepsToEstimateSteps,
	printCostEstimate,
	promptYesNo,
	requiresConfirmation,
	shouldShowEstimate,
} from '../lib/cost-estimate.js';
import { withErrorHandler } from '../lib/errors.js';
import { printError, printJson, printSuccess } from '../lib/output.js';

interface PipelineRunCliOptions {
	upTo?: string;
	from?: string;
	dryRun?: boolean;
	tag?: string;
	costEstimate?: boolean;
}

interface PipelineStatusCliOptions {
	source?: string;
	tag?: string;
	run?: string;
	json?: boolean;
}

interface PipelineRetryCliOptions {
	step?: string;
}

const VALID_STEPS = STEP_ORDER.slice(); // copy for error messages
const RUN_FLAG_STEPS = STEP_ORDER.filter((s) => s !== 'ingest'); // --up-to / --from acceptable values

function isPipelineStep(value: string): value is PipelineStepName {
	for (const step of STEP_ORDER) {
		if (step === value) return true;
	}
	return false;
}

function shortId(id: string): string {
	return id.length > 8 ? `${id.slice(0, 8)}` : id;
}

function computePlannedStepsForEstimate(
	fromStep: PipelineStepName | undefined,
	upToStep: PipelineStepName | undefined,
): PipelineStepName[] {
	const startIndex = fromStep ? STEP_ORDER.indexOf(fromStep) : 0;
	const endIndex = upToStep ? STEP_ORDER.indexOf(upToStep) : STEP_ORDER.length - 1;
	return STEP_ORDER.slice(startIndex, endIndex + 1);
}

// ────────────────────────────────────────────────────────────
// `pipeline run`
// ────────────────────────────────────────────────────────────

function registerRunSubcommand(parent: Command): void {
	parent
		.command('run')
		.description('Run the full pipeline (ingest → extract → segment → enrich → embed → graph → [analyze])')
		.argument('[path]', 'Path to a PDF file or directory')
		.option('--up-to <step>', `Stop after this step (one of: ${RUN_FLAG_STEPS.join('|')})`)
		.option('--from <step>', `Resume from this step (one of: ${RUN_FLAG_STEPS.join('|')})`)
		.option('--dry-run', 'Print the planned steps and source count without executing')
		.option('--cost-estimate', 'show an estimated pipeline cost before executing')
		.option('--tag <tag>', 'Tag this run for later lookup')
		.addHelpText(
			'after',
			`
Examples:
  $ mulder pipeline run ./pdfs/                          # Full pipeline on every PDF in a directory
  $ mulder pipeline run paper.pdf --up-to enrich         # Stop after entity extraction
  $ mulder pipeline run paper.pdf --up-to graph          # Stop before global analyze
  $ mulder pipeline run paper.pdf --from embed           # Resume after enrich on an existing source`,
		)
		.action(
			withErrorHandler(async (path: string | undefined, options: PipelineRunCliOptions) => {
				// Path is required (we keep UX simple in v1).
				if (!path) {
					printError('<path> is required');
					process.exit(1);
					return;
				}

				// Step name validation. Capture into local consts to keep narrowing.
				let upToStep: PipelineStepName | undefined;
				if (options.upTo !== undefined) {
					if (!isPipelineStep(options.upTo)) {
						printError(`Unknown step "${options.upTo}". Valid steps: ${VALID_STEPS.join(', ')}`);
						process.exit(1);
						return;
					}
					upToStep = options.upTo;
				}
				let fromStep: PipelineStepName | undefined;
				if (options.from !== undefined) {
					if (!isPipelineStep(options.from)) {
						printError(`Unknown step "${options.from}". Valid steps: ${VALID_STEPS.join(', ')}`);
						process.exit(1);
						return;
					}
					fromStep = options.from;
				}

				// Ordering check (--from before --up-to).
				if (fromStep && upToStep) {
					const fromIdx = STEP_ORDER.indexOf(fromStep);
					const upToIdx = STEP_ORDER.indexOf(upToStep);
					if (fromIdx > upToIdx) {
						printError(
							`--from ${fromStep} comes after --up-to ${upToStep} in step order. Use a --from value that precedes --up-to.`,
						);
						process.exit(1);
						return;
					}
				}

				const config = loadConfig();
				const estimatedSourceProfiles = await collectPdfSourceProfiles(path);
				const estimate = estimateForSteps({
					mode: 'pipeline',
					sourceProfiles: estimatedSourceProfiles,
					steps: mapPipelineStepsToEstimateSteps(computePlannedStepsForEstimate(fromStep, upToStep)),
					groundingEnabled: false,
				});
				const showEstimate = shouldShowEstimate({
					explicit: options.costEstimate ?? false,
					estimate,
					maxPagesWithoutConfirm: config.safety.max_pages_without_confirm,
					maxCostWithoutConfirmUsd: config.safety.max_cost_without_confirm_usd,
				});

				if (showEstimate) {
					printCostEstimate('Cost estimate for pipeline run', estimate);
				}

				if (
					requiresConfirmation({
						explicit: options.costEstimate ?? false,
						dryRun: options.dryRun ?? false,
						estimate,
						maxPagesWithoutConfirm: config.safety.max_pages_without_confirm,
						maxCostWithoutConfirmUsd: config.safety.max_cost_without_confirm_usd,
					})
				) {
					const confirmed = await promptYesNo('Proceed? [y/N]');
					if (!confirmed) {
						printError('Operation cancelled');
						process.exit(1);
						return;
					}
				}

				const logger = createLogger();
				const services = createServiceRegistry(config, logger);

				if (!config.gcp && !config.dev_mode) {
					printError('GCP configuration is required for pipeline run (or enable dev_mode)');
					process.exit(1);
					return;
				}
				if (!config.gcp) {
					printError('GCP configuration with cloud_sql is required for pipeline run');
					process.exit(1);
					return;
				}

				const pool = getWorkerPool(config.gcp.cloud_sql);

				try {
					const runOptions: PipelineRunOptions = {};
					if (upToStep) runOptions.upTo = upToStep;
					if (fromStep) runOptions.from = fromStep;
					if (options.tag) runOptions.tag = options.tag;
					if (options.dryRun) runOptions.dryRun = true;

					const result = await executePipelineRun({ path, options: runOptions }, config, services, pool, logger);

					// Dry-run summary.
					if (options.dryRun) {
						process.stdout.write(`Planned steps: ${result.data.plannedSteps.join(' → ')}\n`);
						process.stdout.write(`Sources to process: ${result.data.totalSources}\n`);
						process.stdout.write(`Global analyze: ${result.data.analysis.summary}\n`);
						printSuccess('Dry run complete (no changes made)');
						return;
					}

					// Print per-source table (truncate at 50 rows).
					const rowLimit = 50;
					const rowsShown = Math.min(result.data.sources.length, rowLimit);
					if (rowsShown > 0) {
						const header = `${'Source ID'.padEnd(36)}  ${'Status'.padEnd(11)}  ${'Current Step'.padEnd(12)}  Error`;
						const separator = '-'.repeat(header.length);
						process.stdout.write(`${header}\n`);
						process.stdout.write(`${separator}\n`);

						for (const row of result.data.sources.slice(0, rowLimit)) {
							const errMsg = row.errorMessage ? row.errorMessage.slice(0, 80) : '';
							const stepLabel = row.finalStep ?? '-';
							process.stdout.write(
								`${row.sourceId.padEnd(36)}  ${row.status.padEnd(11)}  ${stepLabel.padEnd(12)}  ${errMsg}\n`,
							);
						}
						if (result.data.sources.length > rowLimit) {
							process.stdout.write(`... ${result.data.sources.length - rowLimit} more rows truncated\n`);
						}
					}

					process.stdout.write(`Global analyze: ${result.data.analysis.status} — ${result.data.analysis.summary}\n`);

					const summary = `${result.data.totalSources} sources, ${result.data.completedSources} completed, ${result.data.failedSources} failed (${result.metadata.duration_ms}ms)`;

					if (result.status === 'failed') {
						printError(`Pipeline failed: ${summary}`);
						process.exit(1);
						return;
					}
					if (result.status === 'partial') {
						process.stderr.write(`Pipeline partial: ${summary}\n`);
						return;
					}
					printSuccess(`Pipeline complete: ${summary}`);
				} finally {
					await closeAllPools();
				}
			}),
		);
}

// ────────────────────────────────────────────────────────────
// `pipeline status`
// ────────────────────────────────────────────────────────────

interface PipelineStatusJson {
	runId: string;
	tag: string | null;
	status: PipelineRun['status'];
	createdAt: string;
	finishedAt: string | null;
	totals: Record<PipelineRunSourceStatus, number>;
	sources: Array<{
		sourceId: string;
		currentStep: string;
		status: PipelineRunSourceStatus;
		errorMessage: string | null;
		updatedAt: string;
	}>;
}

function buildStatusJson(run: PipelineRun, sources: PipelineRunSource[]): PipelineStatusJson {
	const totals: Record<PipelineRunSourceStatus, number> = {
		pending: 0,
		processing: 0,
		completed: 0,
		failed: 0,
	};
	for (const src of sources) {
		totals[src.status]++;
	}
	return {
		runId: run.id,
		tag: run.tag,
		status: run.status,
		createdAt: run.createdAt.toISOString(),
		finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null,
		totals,
		sources: sources.map((s) => ({
			sourceId: s.sourceId,
			currentStep: s.currentStep,
			status: s.status,
			errorMessage: s.errorMessage,
			updatedAt: s.updatedAt.toISOString(),
		})),
	};
}

function printStatusTable(run: PipelineRun, sources: PipelineRunSource[]): void {
	const totals: Record<PipelineRunSourceStatus, number> = {
		pending: 0,
		processing: 0,
		completed: 0,
		failed: 0,
	};
	for (const src of sources) {
		totals[src.status]++;
	}

	process.stdout.write(`Run:        ${run.id}\n`);
	process.stdout.write(`Tag:        ${run.tag ?? '-'}\n`);
	process.stdout.write(`Status:     ${run.status}\n`);
	process.stdout.write(`Created:    ${run.createdAt.toISOString()}\n`);
	process.stdout.write(`Finished:   ${run.finishedAt ? run.finishedAt.toISOString() : '-'}\n`);
	process.stdout.write(
		`Totals:     pending=${totals.pending} processing=${totals.processing} completed=${totals.completed} failed=${totals.failed}\n`,
	);

	if (sources.length === 0) {
		return;
	}

	const failing = sources.filter((s) => s.status === 'failed');
	if (failing.length > 0) {
		process.stdout.write(`\nFailed sources:\n`);
		for (const src of failing.slice(0, 20)) {
			const errMsg = src.errorMessage ? src.errorMessage.slice(0, 80) : '';
			process.stdout.write(`  ${shortId(src.sourceId)}  step=${src.currentStep}  ${errMsg}\n`);
		}
	}
}

function registerStatusSubcommand(parent: Command): void {
	parent
		.command('status')
		.description('Show pipeline run status')
		.option('--source <id>', 'Per-source status across runs (latest row wins)')
		.option('--tag <tag>', 'Latest run with this tag')
		.option('--run <id>', 'Status of a specific run')
		.option('--json', 'Machine-readable output')
		.action(
			withErrorHandler(async (options: PipelineStatusCliOptions) => {
				const config = loadConfig();
				const logger = createLogger();

				if (!config.gcp && !config.dev_mode) {
					printError('GCP configuration is required for pipeline status (or enable dev_mode)');
					process.exit(1);
					return;
				}
				if (!config.gcp) {
					printError('GCP configuration with cloud_sql is required for pipeline status');
					process.exit(1);
					return;
				}

				const pool = getWorkerPool(config.gcp.cloud_sql);

				try {
					// Per-source status across runs.
					if (options.source) {
						const sourceRow = await findLatestPipelineRunSourceForSource(pool, options.source);
						if (!sourceRow) {
							printError(`No pipeline run history for source ${options.source}`);
							process.exit(1);
							return;
						}
						if (options.json) {
							printJson({
								sourceId: sourceRow.sourceId,
								runId: sourceRow.runId,
								currentStep: sourceRow.currentStep,
								status: sourceRow.status,
								errorMessage: sourceRow.errorMessage,
								updatedAt: sourceRow.updatedAt.toISOString(),
							});
						} else {
							process.stdout.write(`Source:       ${sourceRow.sourceId}\n`);
							process.stdout.write(`Run:          ${sourceRow.runId}\n`);
							process.stdout.write(`Current step: ${sourceRow.currentStep}\n`);
							process.stdout.write(`Status:       ${sourceRow.status}\n`);
							process.stdout.write(`Updated:      ${sourceRow.updatedAt.toISOString()}\n`);
							if (sourceRow.errorMessage) {
								process.stdout.write(`Error:        ${sourceRow.errorMessage}\n`);
							}
						}
						logger.debug({ sourceId: options.source }, 'pipeline.status.source');
						return;
					}

					// Specific run.
					let run: PipelineRun | null;
					if (options.run) {
						run = await findPipelineRunById(pool, options.run);
						if (!run) {
							printError(`Pipeline run not found: ${options.run}`);
							process.exit(1);
							return;
						}
					} else {
						run = await findLatestPipelineRun(pool, options.tag);
						if (!run) {
							const noun = options.tag ? `run with tag "${options.tag}"` : 'pipeline run';
							printError(`No ${noun} found`);
							process.exit(1);
							return;
						}
					}

					const sources = await findPipelineRunSourcesByRunId(pool, run.id);

					if (options.json) {
						printJson(buildStatusJson(run, sources));
					} else {
						printStatusTable(run, sources);
					}
				} finally {
					await closeAllPools();
				}
			}),
		);
}

// ────────────────────────────────────────────────────────────
// `pipeline retry`
// ────────────────────────────────────────────────────────────

function registerRetrySubcommand(parent: Command): void {
	parent
		.command('retry')
		.description('Retry the failed step for a source in a new run')
		.argument('[source-id]', 'Source UUID to retry')
		.option('--step <step>', `Retry a specific step (one of: ${RUN_FLAG_STEPS.join('|')})`)
		.action(
			withErrorHandler(async (sourceId: string | undefined, options: PipelineRetryCliOptions) => {
				if (!sourceId) {
					printError('<source-id> is required');
					process.exit(1);
					return;
				}

				let stepFlag: PipelineStepName | undefined;
				if (options.step !== undefined) {
					if (!isPipelineStep(options.step)) {
						printError(`Unknown step "${options.step}". Valid steps: ${VALID_STEPS.join(', ')}`);
						process.exit(1);
						return;
					}
					stepFlag = options.step;
				}

				const config = loadConfig();
				const logger = createLogger();
				const services = createServiceRegistry(config, logger);

				if (!config.gcp && !config.dev_mode) {
					printError('GCP configuration is required for pipeline retry (or enable dev_mode)');
					process.exit(1);
					return;
				}
				if (!config.gcp) {
					printError('GCP configuration with cloud_sql is required for pipeline retry');
					process.exit(1);
					return;
				}

				const pool = getWorkerPool(config.gcp.cloud_sql);

				try {
					// Verify source exists.
					const source = await findSourceById(pool, sourceId);
					if (!source) {
						printError(`Source not found: ${sourceId}`);
						process.exit(1);
						return;
					}

					// Determine the step to retry.
					let stepToRetry: PipelineStepName | null = null;
					if (stepFlag) {
						stepToRetry = stepFlag;
					} else {
						const latest = await findLatestPipelineRunSourceForSource(pool, sourceId);
						if (!latest) {
							printError(
								`No prior pipeline run found for source ${sourceId}. Use --step to specify which step to retry.`,
							);
							process.exit(1);
							return;
						}
						if (latest.status !== 'failed') {
							printError(
								`Source ${sourceId} is not in a failed state (last status: ${latest.status}). Use --step to force retry.`,
							);
							process.exit(1);
							return;
						}
						const candidate = latest.currentStep;
						if (!isPipelineStep(candidate)) {
							printError(
								`Latest run for source ${sourceId} has unknown current_step "${candidate}". Use --step explicitly.`,
							);
							process.exit(1);
							return;
						}
						stepToRetry = candidate;
					}

					if (stepToRetry === 'ingest') {
						printError('Cannot retry ingest via `pipeline retry`. Re-ingest via `mulder pipeline run <path>`.');
						process.exit(1);
						return;
					}

					const runOptions: PipelineRunOptions = {
						sourceIds: [sourceId],
						from: stepToRetry,
						upTo: stepToRetry,
						force: true,
						tag: `retry:${shortId(sourceId)}`,
					};

					const result = await executePipelineRun({ options: runOptions }, config, services, pool, logger);

					const summary = `step=${stepToRetry} status=${result.status} runId=${result.runId}`;
					if (result.status === 'failed') {
						printError(`Retry failed: ${summary}`);
						if (result.data.sources[0]?.errorMessage) {
							printError(result.data.sources[0].errorMessage);
						}
						process.exit(1);
						return;
					}
					printSuccess(`Retry complete: ${summary}`);
				} finally {
					await closeAllPools();
				}
			}),
		);
}

// ────────────────────────────────────────────────────────────
// Top-level command registration
// ────────────────────────────────────────────────────────────

/**
 * Registers the `pipeline` command group on the given Commander program.
 *
 * Subcommands:
 * - `mulder pipeline run <path>` — full pipeline with cursor-based progress
 * - `mulder pipeline status` — view run status
 * - `mulder pipeline retry <source-id>` — re-run the failed step for one source
 */
export function registerPipelineCommands(program: Command): void {
	const pipeline = program.command('pipeline').description('Run, monitor, or retry the full document pipeline');

	registerRunSubcommand(pipeline);
	registerStatusSubcommand(pipeline);
	registerRetrySubcommand(pipeline);
}
