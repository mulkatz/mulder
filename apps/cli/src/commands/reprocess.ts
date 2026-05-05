/**
 * CLI command: `mulder reprocess`.
 *
 * Thin wrapper that validates the step flag, loads config/services, delegates
 * selective planning/execution to the pipeline package, and formats the
 * result for terminal use.
 */

import {
	closeAllPools,
	createLogger,
	createServiceRegistry,
	findAllSources,
	getWorkerPool,
	loadConfig,
} from '@mulder/core';
import type { ReprocessResult, ReprocessStepName } from '@mulder/pipeline';
import { executeReprocess } from '@mulder/pipeline';
import type { Command } from 'commander';
import { collectDbSourceProfiles, estimateForReprocessPlan, printCostEstimate } from '../lib/cost-estimate.js';
import { withErrorHandler } from '../lib/errors.js';
import { printError, printJson, printSuccess } from '../lib/output.js';

interface ReprocessOptions {
	step?: string;
	dryRun?: boolean;
	costEstimate?: boolean;
}

const VALID_STEPS: readonly ReprocessStepName[] = [
	'quality',
	'extract',
	'segment',
	'enrich',
	'embed',
	'graph',
] as const;

function isReprocessStep(value: string): value is ReprocessStepName {
	for (const step of VALID_STEPS) {
		if (step === value) {
			return true;
		}
	}
	return false;
}

function summarizeResult(result: ReprocessResult): string {
	const runId = result.summary.runId ?? 'n/a';
	const globalAnalyze =
		result.summary.globalAnalyzeStatus === 'not-run'
			? 'analysis not run'
			: `analysis ${result.summary.globalAnalyzeStatus}`;
	return `${result.summary.completedSources} completed, ${result.summary.failedSources} failed, ${result.summary.skippedSources} skipped, ${globalAnalyze}, run ${runId} (${result.metadata.duration_ms}ms)`;
}

function printReprocessPlan(result: ReprocessResult): void {
	if (result.plan.plannedSourceCount === 0 && !result.plan.globalAnalyzePlanned) {
		process.stdout.write('No sources require reprocessing.\n');
		return;
	}

	process.stdout.write('Reprocess plan:\n');
	for (const source of result.plan.sources) {
		if (!source.planned) {
			continue;
		}
		process.stdout.write(`- ${source.filename}: ${source.steps.map((step) => step.stepName).join(' -> ')}\n`);
	}
	if (result.plan.globalAnalyzePlanned) {
		process.stdout.write('- [global]: analyze\n');
	}
}

export function registerReprocessCommands(program: Command): void {
	program
		.command('reprocess')
		.description('Detect and rerun sources affected by config changes')
		.option('--dry-run', 'show the selective reprocess plan without executing it')
		.option('--step <step>', `force a step for all eligible sources (one of: ${VALID_STEPS.join('|')})`)
		.option('--cost-estimate', 'planned for M8-I2; prints the plan without executing live work')
		.addHelpText(
			'after',
			`
Examples:
  $ mulder reprocess --dry-run
  $ mulder reprocess
  $ mulder reprocess --step enrich
  $ mulder reprocess --cost-estimate`,
		)
		.action(
			withErrorHandler(async (options: ReprocessOptions) => {
				let step: ReprocessStepName | undefined;
				if (options.step !== undefined) {
					if (!isReprocessStep(options.step)) {
						printError(`Unknown step "${options.step}". Valid steps: ${VALID_STEPS.join(', ')}`);
						process.exit(1);
						return;
					}
					step = options.step;
				}

				const config = loadConfig();
				const logger = createLogger();
				const services = createServiceRegistry(config, logger);

				if (!config.gcp && !config.dev_mode) {
					printError('GCP configuration is required for reprocess (or enable dev_mode)');
					process.exit(1);
					return;
				}
				if (!config.gcp) {
					printError('GCP configuration with cloud_sql is required for reprocess');
					process.exit(1);
					return;
				}

				const pool = getWorkerPool(config.gcp.cloud_sql);

				try {
					const result = await executeReprocess(
						{
							step,
							dryRun: options.dryRun,
							costEstimate: options.costEstimate,
						},
						config,
						services,
						pool,
						logger,
					);

					if (options.costEstimate) {
						const sources = await findAllSources(pool);
						const estimate = estimateForReprocessPlan({
							sourceProfiles: collectDbSourceProfiles(sources),
							plannedSources: result.plan.sources
								.filter((source) => source.planned)
								.map((source) => ({ sourceId: source.sourceId, steps: source.steps })),
							groundingEnabled: false,
						});
						printCostEstimate('Cost estimate for reprocess plan', estimate);
						printReprocessPlan(result);
						return;
					}

					if (options.dryRun) {
						printJson(result);
						printSuccess(
							`Dry run complete: ${result.plan.plannedSourceCount} sources, ${result.plan.plannedStepCount} steps${result.plan.globalAnalyzePlanned ? ', plus global analyze' : ''}`,
						);
						return;
					}

					for (const error of result.errors) {
						printError(`[${error.code}] ${error.message}`);
					}

					const summary = summarizeResult(result);
					if (result.status === 'failed') {
						printError(`Reprocess failed: ${summary}`);
						process.exit(1);
						return;
					}
					if (result.status === 'partial') {
						process.stderr.write(`Reprocess partial: ${summary}\n`);
						return;
					}
					printSuccess(`Reprocess complete: ${summary}`);
				} finally {
					await closeAllPools();
				}
			}),
		);
}
