/**
 * CLI command: `mulder extract <source-id>`.
 *
 * Thin wrapper that parses arguments, loads config, creates service
 * registry, calls the extract pipeline step, and formats the output.
 * No business logic lives here.
 *
 * @see docs/specs/19_extract_step.spec.md §4.9
 * @see docs/functional-spec.md §1 (extract cmd), §2.2
 */

import {
	closeAllPools,
	createLogger,
	createServiceRegistry,
	findAllSources,
	getWorkerPool,
	loadConfig,
} from '@mulder/core';
import type { ExtractResult } from '@mulder/pipeline';
import { executeExtract } from '@mulder/pipeline';
import type { Command } from 'commander';
import { withErrorHandler } from '../lib/errors.js';
import { printError, printSuccess } from '../lib/output.js';

interface ExtractOptions {
	all?: boolean;
	force?: boolean;
	fallbackOnly?: boolean;
}

/**
 * Registers the `extract` command on the given Commander program.
 *
 * Usage:
 * ```
 * mulder extract <source-id>
 *   --all               Extract all sources with status=ingested
 *   --force             Re-extract even if already extracted
 *   --fallback-only     Only run Gemini Vision fallback on low-confidence pages
 * ```
 */
export function registerExtractCommands(program: Command): void {
	program
		.command('extract')
		.description('Extract layout data and page images from ingested PDFs')
		.argument('[source-id]', 'UUID of the source to extract')
		.option('--all', 'extract all sources with status=ingested')
		.option('--force', 're-extract even if already extracted')
		.option('--fallback-only', 'only run Gemini Vision fallback on low-confidence pages')
		.action(
			withErrorHandler(async (sourceId: string | undefined, options: ExtractOptions) => {
				if (!sourceId && !options.all) {
					printError('Provide a <source-id> or use --all');
					process.exit(1);
					return;
				}

				if (sourceId && options.all) {
					printError('<source-id> and --all are mutually exclusive');
					process.exit(1);
					return;
				}

				const config = loadConfig();
				const logger = createLogger();
				const services = createServiceRegistry(config, logger);

				if (!config.gcp && !config.dev_mode) {
					printError('GCP configuration is required for extract (or enable dev_mode)');
					process.exit(1);
					return;
				}

				if (!config.gcp) {
					printError('GCP configuration with cloud_sql is required for extract');
					process.exit(1);
					return;
				}

				const pool = getWorkerPool(config.gcp.cloud_sql);

				try {
					const results: ExtractResult[] = [];

					if (options.all) {
						// Batch extraction: all ingested sources
						const sources = await findAllSources(pool, { status: 'ingested' });
						if (sources.length === 0) {
							printSuccess('No ingested sources found to extract');
							return;
						}

						logger.info({ sourceCount: sources.length }, 'Extracting all ingested sources');

						for (const source of sources) {
							try {
								const result = await executeExtract(
									{ sourceId: source.id, force: options.force, fallbackOnly: options.fallbackOnly },
									config,
									services,
									pool,
									logger,
								);
								results.push(result);
							} catch (error: unknown) {
								const message = error instanceof Error ? error.message : String(error);
								printError(`${source.id}: ${message}`);
								results.push({
									status: 'failed',
									data: null,
									errors: [{ code: 'EXTRACT_STEP_FAILED', message }],
									metadata: { duration_ms: 0, items_processed: 0, items_skipped: 0, items_cached: 0 },
								});
							}
						}
					} else if (sourceId) {
						// Single source extraction
						const result = await executeExtract(
							{ sourceId, force: options.force, fallbackOnly: options.fallbackOnly },
							config,
							services,
							pool,
							logger,
						);
						results.push(result);
					}

					// Print results table
					const successResults = results.filter((r) => r.data !== null);
					if (successResults.length > 0) {
						const header = `${'Source ID'.padEnd(36)}  ${'Pages'.padEnd(6)}  ${'Method'.padEnd(14)}  ${'Vision FB'.padEnd(10)}  Status`;
						const separator = '-'.repeat(header.length);

						process.stdout.write(`${header}\n`);
						process.stdout.write(`${separator}\n`);

						for (const result of successResults) {
							const data = result.data;
							if (!data) continue;
							const visionInfo = data.visionFallbackCapped
								? `${data.visionFallbackCount} (capped)`
								: String(data.visionFallbackCount);
							process.stdout.write(
								`${data.sourceId.padEnd(36)}  ${String(data.pageCount).padEnd(6)}  ${data.primaryMethod.padEnd(14)}  ${visionInfo.padEnd(10)}  ${result.status}\n`,
							);
						}
					}

					// Print errors
					for (const result of results) {
						for (const error of result.errors) {
							printError(`[${error.code}] ${error.message}`);
						}
					}

					// Summary
					const totalProcessed = results.reduce((sum, r) => sum + r.metadata.items_processed, 0);
					const totalErrors = results.filter((r) => r.status === 'failed').length;
					const totalDuration = results.reduce((sum, r) => sum + r.metadata.duration_ms, 0);

					const allFailed = results.length > 0 && results.every((r) => r.status === 'failed');
					const someFailed = results.some((r) => r.status === 'failed');

					const summary = `${totalProcessed} pages processed, ${totalErrors} sources failed (${totalDuration}ms)`;
					if (allFailed) {
						printError(`Extract failed: ${summary}`);
						process.exit(1);
					} else if (someFailed) {
						process.stderr.write(`Extract partial: ${summary}\n`);
					} else {
						printSuccess(`Extract complete: ${summary}`);
					}
				} finally {
					await closeAllPools();
				}
			}),
		);
}
