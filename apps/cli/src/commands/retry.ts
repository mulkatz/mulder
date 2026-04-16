/**
 * CLI command: `mulder retry`.
 *
 * Resets dead-letter queue jobs back to pending so the normal worker loop can
 * pick them up again. The command is intentionally thin: it validates
 * selectors, loads the database pool, delegates to the repository helper, and
 * formats operator output.
 *
 * @see docs/specs/78_dead_letter_queue_retry.spec.md §4.3, §4.4
 * @see docs/functional-spec.md §1 (retry cmd), §10.5, §16
 */

import { closeAllPools, getWorkerPool, loadConfig, type PipelineStep, resetDeadLetterJobs } from '@mulder/core';
import chalk from 'chalk';
import type { Command } from 'commander';
import { withErrorHandler } from '../lib/errors.js';
import { printError, printJson, printSuccess } from '../lib/output.js';

const RETRYABLE_STEPS = ['extract', 'segment', 'enrich', 'embed', 'graph'] as const;

type RetryableStep = (typeof RETRYABLE_STEPS)[number];

interface RetryCommandOptions {
	document?: string;
	step?: string;
	json?: boolean;
}

interface RetryCommandJson {
	selectors: {
		documentId: string | null;
		step: RetryableStep | null;
	};
	resetCount: number;
	jobIds: string[];
}

function isRetryableStep(value: string): value is RetryableStep {
	return RETRYABLE_STEPS.includes(value as RetryableStep);
}

function loadRetryPool() {
	const config = loadConfig();

	if (!config.gcp?.cloud_sql) {
		process.stderr.write(`${chalk.red('\u2718')} GCP configuration with cloud_sql is required for retry command\n`);
		process.exit(1);
		return null;
	}

	return getWorkerPool(config.gcp.cloud_sql);
}

function describeSelectors(documentId: string | undefined, step: RetryableStep | undefined): string {
	const parts: string[] = [];
	if (documentId) {
		parts.push(`document=${documentId}`);
	}
	if (step) {
		parts.push(`step=${step}`);
	}
	return parts.join(', ');
}

function buildJsonSummary(
	result: { count: number; jobIds: string[] },
	options: RetryCommandOptions,
	step?: RetryableStep,
): RetryCommandJson {
	return {
		selectors: {
			documentId: options.document ?? null,
			step: step ?? null,
		},
		resetCount: result.count,
		jobIds: result.jobIds,
	};
}

export function registerRetryCommand(program: Command): void {
	program
		.command('retry')
		.description('Reset dead-letter jobs back to pending')
		.option('--document <id>', 'Reset dead-letter jobs for a document')
		.option('--step <step>', `Reset dead-letter jobs for a step (one of: ${RETRYABLE_STEPS.join('|')})`)
		.option('--json', 'Machine-readable JSON output')
		.addHelpText(
			'after',
			`
Examples:
  $ mulder retry --document 123e4567-e89b-12d3-a456-426614174000
  $ mulder retry --step enrich
  $ mulder retry --document 123e4567-e89b-12d3-a456-426614174000 --step graph --json`,
		)
		.action(
			withErrorHandler(async (options: RetryCommandOptions) => {
				if (!options.document && !options.step) {
					printError('At least one selector is required: --document and/or --step');
					process.exit(1);
					return;
				}

				let step: RetryableStep | undefined;
				if (options.step !== undefined) {
					if (!isRetryableStep(options.step)) {
						printError(`Unknown step "${options.step}". Valid steps: ${RETRYABLE_STEPS.join(', ')}`);
						process.exit(1);
						return;
					}
					step = options.step;
				}

				const pool = loadRetryPool();
				if (!pool) {
					return;
				}

				try {
					const result = await resetDeadLetterJobs(pool, {
						documentId: options.document,
						step: step as PipelineStep | undefined,
					});

					if (options.json) {
						printJson(buildJsonSummary(result, options, step));
						return;
					}

					const selectorText = describeSelectors(options.document, step);
					if (result.count === 0) {
						printSuccess(`No dead-letter jobs matched (${selectorText})`);
						process.stdout.write(`Selectors: ${selectorText}\n`);
						return;
					}

					printSuccess(`Reset ${result.count} dead-letter job(s)`);
					process.stdout.write(`Selectors: ${selectorText}\n`);
					for (const jobId of result.jobIds) {
						process.stdout.write(`  ${jobId}\n`);
					}
				} finally {
					await closeAllPools();
				}
			}),
		);
}
