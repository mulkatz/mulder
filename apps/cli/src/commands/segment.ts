/**
 * CLI command: `mulder segment <source-id>`.
 *
 * Thin wrapper that parses arguments, loads config, creates service
 * registry, calls the segment pipeline step, and formats the output.
 * No business logic lives here.
 *
 * @see docs/specs/23_segment_step.spec.md §4.9
 * @see docs/functional-spec.md §1 (segment cmd), §2.3
 */

import {
	closeAllPools,
	createLogger,
	createServiceRegistry,
	findAllSources,
	getWorkerPool,
	loadConfig,
} from '@mulder/core';
import type { SegmentResult } from '@mulder/pipeline';
import { executeSegment } from '@mulder/pipeline';
import type { Command } from 'commander';
import { withErrorHandler } from '../lib/errors.js';
import { printError, printSuccess } from '../lib/output.js';

interface SegmentOptions {
	all?: boolean;
	force?: boolean;
}

/**
 * Registers the `segment` command on the given Commander program.
 *
 * Usage:
 * ```
 * mulder segment <source-id>
 *   --all               Segment all sources with status=extracted
 *   --force             Re-segment even if already segmented
 * ```
 */
export function registerSegmentCommands(program: Command): void {
	program
		.command('segment')
		.description('Segment extracted documents into individual stories')
		.argument('[source-id]', 'UUID of the source to segment')
		.option('--all', 'segment all sources with status=extracted')
		.option('--force', 're-segment even if already segmented')
		.action(
			withErrorHandler(async (sourceId: string | undefined, options: SegmentOptions) => {
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
					printError('GCP configuration is required for segment (or enable dev_mode)');
					process.exit(1);
					return;
				}

				if (!config.gcp) {
					printError('GCP configuration with cloud_sql is required for segment');
					process.exit(1);
					return;
				}

				const pool = getWorkerPool(config.gcp.cloud_sql);

				try {
					const results: SegmentResult[] = [];

					if (options.all) {
						// Batch segmentation: all extracted sources
						const sources = await findAllSources(pool, { status: 'extracted' });
						if (sources.length === 0) {
							printSuccess('No extracted sources found to segment');
							return;
						}

						logger.info({ sourceCount: sources.length }, 'Segmenting all extracted sources');

						for (const source of sources) {
							try {
								const result = await executeSegment(
									{ sourceId: source.id, force: options.force },
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
									errors: [{ code: 'SEGMENT_STEP_FAILED', message }],
									metadata: { duration_ms: 0, items_processed: 0, items_skipped: 0, items_cached: 0 },
								});
							}
						}
					} else if (sourceId) {
						// Single source segmentation
						const result = await executeSegment({ sourceId, force: options.force }, config, services, pool, logger);
						results.push(result);
					}

					// Print results table
					const successResults = results.filter((r) => r.data !== null);
					if (successResults.length > 0) {
						const header = `${'Source ID'.padEnd(36)}  ${'Stories'.padEnd(8)}  Status`;
						const separator = '-'.repeat(header.length);

						process.stdout.write(`${header}\n`);
						process.stdout.write(`${separator}\n`);

						for (const result of successResults) {
							const data = result.data;
							if (!data) continue;
							process.stdout.write(
								`${data.sourceId.padEnd(36)}  ${String(data.storyCount).padEnd(8)}  ${result.status}\n`,
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
					const totalStories = results.reduce((sum, r) => sum + r.metadata.items_processed, 0);
					const totalErrors = results.filter((r) => r.status === 'failed').length;
					const totalDuration = results.reduce((sum, r) => sum + r.metadata.duration_ms, 0);

					const allFailed = results.length > 0 && results.every((r) => r.status === 'failed');
					const someFailed = results.some((r) => r.status === 'failed');

					const summary = `${totalStories} stories created, ${totalErrors} sources failed (${totalDuration}ms)`;
					if (allFailed) {
						printError(`Segment failed: ${summary}`);
						process.exit(1);
					} else if (someFailed) {
						process.stderr.write(`Segment partial: ${summary}\n`);
					} else {
						printSuccess(`Segment complete: ${summary}`);
					}
				} finally {
					await closeAllPools();
				}
			}),
		);
}
