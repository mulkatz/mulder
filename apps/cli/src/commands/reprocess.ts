/**
 * CLI command: `mulder reprocess`.
 *
 * Planning-only surface for selective reprocessing. This step computes the
 * config-hash diff and cost estimate but intentionally defers execution.
 */

import {
	closeAllPools,
	findAllSources,
	findSourceSteps,
	getWorkerPool,
	loadConfig,
	type ReprocessableStep,
	type Source,
	type SourceStep,
} from '@mulder/core';
import { buildReprocessPlan } from '@mulder/pipeline';
import type { Command } from 'commander';
import {
	collectDbSourceProfiles,
	estimateForSteps,
	mapReprocessStepsToEstimateSteps,
	printCostEstimate,
} from '../lib/cost-estimate.js';
import { withErrorHandler } from '../lib/errors.js';
import { printError, printSuccess } from '../lib/output.js';

interface ReprocessOptions {
	dryRun?: boolean;
	step?: string;
	costEstimate?: boolean;
}

const VALID_REPROCESS_STEPS: ReprocessableStep[] = ['extract', 'segment', 'enrich', 'embed', 'graph'];

function isReprocessableStep(value: string): value is ReprocessableStep {
	return VALID_REPROCESS_STEPS.includes(value as ReprocessableStep);
}

async function loadAllSources(pool: import('pg').Pool): Promise<Source[]> {
	const sources: Source[] = [];
	let offset = 0;
	const limit = 1000;

	while (true) {
		const batch = await findAllSources(pool, { limit, offset });
		sources.push(...batch);
		if (batch.length < limit) {
			break;
		}
		offset += limit;
	}

	return sources;
}

async function loadSourceStepsBySourceId(
	pool: import('pg').Pool,
	sources: Source[],
): Promise<Map<string, SourceStep[]>> {
	const sourceStepsBySourceId = new Map<string, SourceStep[]>();

	for (const source of sources) {
		sourceStepsBySourceId.set(source.id, await findSourceSteps(pool, source.id));
	}

	return sourceStepsBySourceId;
}

function printReprocessPlan(sources: Array<{ source: Source; steps: ReprocessableStep[] }>): void {
	if (sources.length === 0) {
		process.stdout.write('No sources require reprocessing.\n');
		return;
	}

	process.stdout.write(`Sources requiring reprocess: ${sources.length}\n`);
	for (const entry of sources) {
		process.stdout.write(`- ${entry.source.filename} (${entry.source.id}): ${entry.steps.join(' -> ')}\n`);
	}
}

function uniquePlannedSteps(sources: Array<{ steps: ReprocessableStep[] }>): ReprocessableStep[] {
	const planned = new Set<ReprocessableStep>();
	for (const entry of sources) {
		for (const step of entry.steps) {
			planned.add(step);
		}
	}
	return VALID_REPROCESS_STEPS.filter((step) => planned.has(step));
}

export function registerReprocessCommands(program: Command): void {
	program
		.command('reprocess')
		.description('Plan selective reprocessing after config changes')
		.option('--dry-run', 'show which sources would reprocess without executing')
		.option('--step <step>', `force a specific step (one of: ${VALID_REPROCESS_STEPS.join('|')})`)
		.option('--cost-estimate', 'show the estimated cost of the reprocess plan')
		.addHelpText(
			'after',
			`
Examples:
  $ mulder reprocess --dry-run
  $ mulder reprocess --dry-run --cost-estimate
  $ mulder reprocess --step enrich --dry-run --cost-estimate`,
		)
		.action(
			withErrorHandler(async (options: ReprocessOptions) => {
				let forcedStep: ReprocessableStep | undefined;
				if (options.step !== undefined) {
					if (!isReprocessableStep(options.step)) {
						printError(`Unknown reprocess step "${options.step}". Valid steps: ${VALID_REPROCESS_STEPS.join(', ')}`);
						process.exit(1);
						return;
					}
					forcedStep = options.step;
				}

				const config = loadConfig();
				if (!config.gcp) {
					printError('GCP configuration with cloud_sql is required for reprocess planning');
					process.exit(1);
					return;
				}

				const pool = getWorkerPool(config.gcp.cloud_sql);

				try {
					const sources = await loadAllSources(pool);
					const sourceStepsBySourceId = await loadSourceStepsBySourceId(pool, sources);
					const plan = buildReprocessPlan({
						config,
						sources,
						sourceStepsBySourceId,
						forcedStep,
					});

					if (options.costEstimate) {
						const estimate = estimateForSteps({
							mode: 'reprocess',
							sourceProfiles: collectDbSourceProfiles(plan.sources.map((entry) => entry.source)),
							steps: mapReprocessStepsToEstimateSteps(uniquePlannedSteps(plan.sources)),
							groundingEnabled: false,
						});
						printCostEstimate('Cost estimate for reprocess plan', estimate);
					}

					printReprocessPlan(plan.sources);

					if (plan.sources.length === 0) {
						printSuccess('No documents require reprocessing');
						return;
					}

					if (options.dryRun) {
						printSuccess('Dry run complete (no changes made)');
						return;
					}

					printError(
						'Reprocess execution lands in M8-I4; this command currently supports planning and estimation only',
					);
					process.exit(1);
				} finally {
					await closeAllPools();
				}
			}),
		);
}
