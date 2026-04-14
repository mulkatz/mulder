/**
 * CLI command: `mulder ingest <path>`.
 *
 * Thin wrapper that parses arguments, loads config, creates service
 * registry, calls the ingest pipeline step, and formats the output.
 * No business logic lives here.
 *
 * @see docs/specs/16_ingest_step.spec.md §4.3
 * @see docs/functional-spec.md §1 (ingest cmd), §2.1
 */

import { closeAllPools, createLogger, createServiceRegistry, getWorkerPool, loadConfig } from '@mulder/core';
import { executeIngest } from '@mulder/pipeline';
import type { Command } from 'commander';
import { withErrorHandler } from '../lib/errors.js';
import { printError, printSuccess } from '../lib/output.js';

interface IngestOptions {
	dryRun?: boolean;
	tag?: string[];
	costEstimate?: boolean;
}

/**
 * Registers the `ingest` command on the given Commander program.
 *
 * Usage:
 * ```
 * mulder ingest <path>
 *   --dry-run         Validate without uploading
 *   --tag <tag>       Tag ingested sources (repeatable)
 *   --cost-estimate   Planned for M8-I2; currently prints a placeholder message
 * ```
 */
export function registerIngestCommands(program: Command): void {
	program
		.command('ingest')
		.description('Ingest PDF(s) — file or directory')
		.argument('<path>', 'path to a PDF file or directory containing PDFs')
		.option('--dry-run', 'validate without uploading or creating DB records')
		.option('--tag <tag>', 'tag ingested sources (repeatable)', collect, [])
		.option('--cost-estimate', 'planned for M8-I2; currently prints a placeholder message')
		.addHelpText(
			'after',
			`
Examples:
  $ mulder ingest ./my-pdfs/                       # Ingest every PDF in a directory
  $ mulder ingest paper.pdf --tag review --tag q1  # Tag a single ingest with two tags
  $ mulder ingest paper.pdf --dry-run              # Validate without writing to GCS or the DB`,
		)
		.action(
			withErrorHandler(async (inputPath: string, options: IngestOptions) => {
				if (options.costEstimate) {
					process.stderr.write('Cost estimation is planned for M8-I2 and is not implemented yet.\n');
					return;
				}

				const config = loadConfig();
				const logger = createLogger();
				const services = createServiceRegistry(config, logger);

				if (!config.gcp && !config.dev_mode) {
					printError('GCP configuration is required for ingest (or enable dev_mode)');
					process.exit(1);
					return;
				}

				let pool: import('pg').Pool | undefined;

				if (!options.dryRun) {
					if (!config.gcp) {
						printError('GCP configuration with cloud_sql is required for non-dry-run ingest');
						process.exit(1);
						return;
					}
					pool = getWorkerPool(config.gcp.cloud_sql);
				}

				try {
					const result = await executeIngest(
						{
							path: inputPath,
							tags: options.tag,
							dryRun: options.dryRun,
						},
						config,
						services,
						pool,
						logger,
					);

					// Print results table
					if (result.data.length > 0) {
						const header = `${'Filename'.padEnd(40)}  ${'Source ID'.padEnd(36)}  ${'Pages'.padEnd(6)}  ${'Native Text'.padEnd(12)}  Status`;
						const separator = '-'.repeat(header.length);

						process.stdout.write(`${header}\n`);
						process.stdout.write(`${separator}\n`);

						for (const item of result.data) {
							const filename = item.filename.length > 38 ? `${item.filename.substring(0, 35)}...` : item.filename;
							const nativeText = item.hasNativeText ? `${(item.nativeTextRatio * 100).toFixed(0)}%` : 'no';
							const status = item.duplicate ? 'duplicate' : options.dryRun ? 'validated' : 'ingested';
							process.stdout.write(
								`${filename.padEnd(40)}  ${item.sourceId.padEnd(36)}  ${String(item.pageCount).padEnd(6)}  ${nativeText.padEnd(12)}  ${status}\n`,
							);
						}
					}

					// Print errors
					for (const error of result.errors) {
						printError(`${error.file ?? 'unknown'}: [${error.code}] ${error.message}`);
					}

					// Summary
					const summary = `${result.data.length} processed, ${result.errors.length} errors, ${result.metadata.items_skipped} duplicates (${result.metadata.duration_ms}ms)`;
					if (result.status === 'failed') {
						printError(`Ingest failed: ${summary}`);
						process.exit(1);
					} else if (result.status === 'partial') {
						process.stderr.write(`Ingest partial: ${summary}\n`);
					} else {
						printSuccess(`Ingest complete: ${summary}`);
					}
				} finally {
					if (pool) {
						await closeAllPools();
					}
				}
			}),
		);
}

/**
 * Commander.js option collector for repeatable flags.
 * Each `--tag` occurrence appends to the array.
 */
function collect(value: string, previous: string[]): string[] {
	return [...previous, value];
}
