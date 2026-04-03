/**
 * CLI command: `mulder enrich <story-id>`.
 *
 * Thin wrapper that parses arguments, loads config, creates service
 * registry, calls the enrich pipeline step, and formats the output.
 * No business logic lives here.
 *
 * @see docs/specs/29_enrich_step.spec.md §4.1
 * @see docs/functional-spec.md §1 (enrich cmd), §2.4
 */

import {
	closeAllPools,
	createLogger,
	createServiceRegistry,
	findAllStories,
	findStoriesBySourceId,
	getWorkerPool,
	loadConfig,
} from '@mulder/core';
import type { EnrichResult } from '@mulder/pipeline';
import { executeEnrich, forceCleanupEnrichSource } from '@mulder/pipeline';
import type { Command } from 'commander';
import { withErrorHandler } from '../lib/errors.js';
import { printError, printSuccess } from '../lib/output.js';

interface EnrichOptions {
	all?: boolean;
	source?: string;
	force?: boolean;
}

/**
 * Registers the `enrich` command on the given Commander program.
 *
 * Usage:
 * ```
 * mulder enrich <story-id>
 *   --all                Enrich all stories with status=segmented
 *   --source <id>        Enrich all stories from a specific source
 *   --force              Re-enrich even if already enriched
 * ```
 */
export function registerEnrichCommands(program: Command): void {
	program
		.command('enrich')
		.description('Extract entities and relationships from stories')
		.argument('[story-id]', 'UUID of the story to enrich')
		.option('--all', 'enrich all stories with status=segmented')
		.option('--source <id>', 'enrich all stories from a specific source')
		.option('--force', 're-enrich even if already enriched')
		.action(
			withErrorHandler(async (storyId: string | undefined, options: EnrichOptions) => {
				// Validation: need at least one target
				if (!storyId && !options.all && !options.source) {
					printError('Provide a <story-id>, use --all, or use --source <id>');
					process.exit(1);
					return;
				}

				// Validation: mutually exclusive arguments
				if (storyId && (options.all || options.source)) {
					printError('<story-id> and --all/--source are mutually exclusive');
					process.exit(1);
					return;
				}

				if (options.all && options.source) {
					printError('--all and --source are mutually exclusive');
					process.exit(1);
					return;
				}

				// --all --force is too dangerous
				if (options.all && options.force) {
					printError('--all --force is not supported — use --source <id> --force to scope the reset');
					process.exit(1);
					return;
				}

				const config = loadConfig();
				const logger = createLogger();
				const services = createServiceRegistry(config, logger);

				if (!config.gcp && !config.dev_mode) {
					printError('GCP configuration is required for enrich (or enable dev_mode)');
					process.exit(1);
					return;
				}

				if (!config.gcp) {
					printError('GCP configuration with cloud_sql is required for enrich');
					process.exit(1);
					return;
				}

				const pool = getWorkerPool(config.gcp.cloud_sql);

				try {
					const results: EnrichResult[] = [];

					if (options.all) {
						// Batch enrichment: all segmented stories
						const stories = await findAllStories(pool, { status: 'segmented' });
						if (stories.length === 0) {
							printSuccess('No segmented stories found to enrich');
							return;
						}

						logger.info({ storyCount: stories.length }, 'Enriching all segmented stories');

						for (const story of stories) {
							try {
								const result = await executeEnrich(
									{ storyId: story.id, force: options.force },
									config,
									services,
									pool,
									logger,
								);
								results.push(result);
							} catch (error: unknown) {
								const message = error instanceof Error ? error.message : String(error);
								printError(`${story.id}: ${message}`);
								results.push({
									status: 'failed',
									data: null,
									errors: [{ code: 'ENRICH_STEP_FAILED', message }],
									metadata: { duration_ms: 0, items_processed: 0, items_skipped: 0, items_cached: 0 },
								});
							}
						}
					} else if (options.source) {
						// Source-scoped enrichment
						const stories = await findStoriesBySourceId(pool, options.source);
						if (stories.length === 0) {
							printSuccess('No stories found for this source');
							return;
						}

						// If --force, do source-level cleanup first
						if (options.force) {
							await forceCleanupEnrichSource(options.source, pool, logger);
						}

						logger.info({ sourceId: options.source, storyCount: stories.length }, 'Enriching stories from source');

						for (const story of stories) {
							// After source-level cleanup, all stories are back to segmented
							// so no need for per-story force
							try {
								const result = await executeEnrich({ storyId: story.id, force: false }, config, services, pool, logger);
								results.push(result);
							} catch (error: unknown) {
								const message = error instanceof Error ? error.message : String(error);
								printError(`${story.id}: ${message}`);
								results.push({
									status: 'failed',
									data: null,
									errors: [{ code: 'ENRICH_STEP_FAILED', message }],
									metadata: { duration_ms: 0, items_processed: 0, items_skipped: 0, items_cached: 0 },
								});
							}
						}
					} else if (storyId) {
						// Single story enrichment
						const result = await executeEnrich({ storyId, force: options.force }, config, services, pool, logger);
						results.push(result);
					}

					// Print results table
					const successResults = results.filter((r) => r.data !== null);
					if (successResults.length > 0) {
						const header = `${'Story ID'.padEnd(36)}  ${'Entities'.padEnd(10)}  ${'Relations'.padEnd(10)}  Status`;
						const separator = '-'.repeat(header.length);

						process.stdout.write(`${header}\n`);
						process.stdout.write(`${separator}\n`);

						for (const result of successResults) {
							const data = result.data;
							if (!data) continue;
							process.stdout.write(
								`${data.storyId.padEnd(36)}  ${String(data.entitiesExtracted).padEnd(10)}  ${String(data.relationshipsCreated).padEnd(10)}  ${result.status}\n`,
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
					const totalEntities = results.reduce((sum, r) => sum + r.metadata.items_processed, 0);
					const totalErrors = results.filter((r) => r.status === 'failed').length;
					const totalDuration = results.reduce((sum, r) => sum + r.metadata.duration_ms, 0);
					const totalSkipped = results.reduce((sum, r) => sum + r.metadata.items_skipped, 0);

					const allFailed = results.length > 0 && results.every((r) => r.status === 'failed');
					const someFailed = results.some((r) => r.status === 'failed');

					const summary = `${totalEntities} entities extracted, ${totalSkipped} skipped, ${totalErrors} failed (${totalDuration}ms)`;
					if (allFailed) {
						printError(`Enrich failed: ${summary}`);
						process.exit(1);
					} else if (someFailed) {
						process.stderr.write(`Enrich partial: ${summary}\n`);
					} else {
						printSuccess(`Enrich complete: ${summary}`);
					}
				} finally {
					await closeAllPools();
				}
			}),
		);
}
