/**
 * CLI command: `mulder graph <story-id>`.
 *
 * Thin wrapper that parses arguments, loads config, creates service
 * registry, calls the graph pipeline step, and formats the output.
 * No business logic lives here.
 *
 * @see docs/specs/35_graph_step.spec.md §4.7
 * @see docs/functional-spec.md §1 (graph cmd), §2.7
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
import type { GraphResult } from '@mulder/pipeline';
import { executeGraph, forceCleanupGraphSource } from '@mulder/pipeline';
import type { Command } from 'commander';
import { withErrorHandler } from '../lib/errors.js';
import { printError, printSuccess } from '../lib/output.js';

interface GraphOptions {
	all?: boolean;
	source?: string;
	force?: boolean;
}

/**
 * Registers the `graph` command on the given Commander program.
 *
 * Usage:
 * ```
 * mulder graph <story-id>
 *   --all                Graph all stories with status=embedded
 *   --source <id>        Graph all stories from a specific source
 *   --force              Re-graph even if already graphed
 * ```
 */
export function registerGraphCommands(program: Command): void {
	program
		.command('graph')
		.description('Build knowledge graph edges, detect duplicates, score corroboration')
		.argument('[story-id]', 'UUID of the story to graph')
		.option('--all', 'graph all stories with status=embedded')
		.option('--source <id>', 'graph all stories from a specific source')
		.option('--force', 're-graph even if already graphed')
		.action(
			withErrorHandler(async (storyId: string | undefined, options: GraphOptions) => {
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
					printError('GCP configuration is required for graph (or enable dev_mode)');
					process.exit(1);
					return;
				}

				if (!config.gcp) {
					printError('GCP configuration with cloud_sql is required for graph');
					process.exit(1);
					return;
				}

				const pool = getWorkerPool(config.gcp.cloud_sql);

				try {
					const results: GraphResult[] = [];

					if (options.all) {
						// Batch graphing: all embedded stories
						const stories = await findAllStories(pool, { status: 'embedded' });
						if (stories.length === 0) {
							printSuccess('No embedded stories found to graph');
							return;
						}

						logger.info({ storyCount: stories.length }, 'Graphing all embedded stories');

						for (const story of stories) {
							try {
								const result = await executeGraph(
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
									errors: [{ code: 'GRAPH_STEP_FAILED', message }],
									metadata: { duration_ms: 0, items_processed: 0, items_skipped: 0, items_cached: 0 },
								});
							}
						}
					} else if (options.source) {
						// Source-scoped graphing
						const stories = await findStoriesBySourceId(pool, options.source);
						if (stories.length === 0) {
							printSuccess('No stories found for this source');
							return;
						}

						// If --force, do source-level cleanup first
						if (options.force) {
							await forceCleanupGraphSource(options.source, pool, logger);
						}

						logger.info({ sourceId: options.source, storyCount: stories.length }, 'Graphing stories from source');

						for (const story of stories) {
							// After source-level cleanup, all stories are back to embedded
							// so no need for per-story force
							try {
								const result = await executeGraph({ storyId: story.id, force: false }, config, services, pool, logger);
								results.push(result);
							} catch (error: unknown) {
								const message = error instanceof Error ? error.message : String(error);
								printError(`${story.id}: ${message}`);
								results.push({
									status: 'failed',
									data: null,
									errors: [{ code: 'GRAPH_STEP_FAILED', message }],
									metadata: { duration_ms: 0, items_processed: 0, items_skipped: 0, items_cached: 0 },
								});
							}
						}
					} else if (storyId) {
						// Single story graphing
						const result = await executeGraph({ storyId, force: options.force }, config, services, pool, logger);
						results.push(result);
					}

					// Print results table
					const successResults = results.filter((r) => r.data !== null);
					if (successResults.length > 0) {
						const header = `${'Story ID'.padEnd(36)}  ${'Edges'.padEnd(8)}  ${'Duplicates'.padEnd(12)}  ${'Contradictions'.padEnd(16)}  Status`;
						const separator = '-'.repeat(header.length);

						process.stdout.write(`${header}\n`);
						process.stdout.write(`${separator}\n`);

						for (const result of successResults) {
							const data = result.data;
							if (!data) continue;
							const totalEdges = data.edgesCreated + data.edgesUpdated;
							process.stdout.write(
								`${data.storyId.padEnd(36)}  ${String(totalEdges).padEnd(8)}  ${String(data.duplicatesFound).padEnd(12)}  ${String(data.contradictionsFlagged).padEnd(16)}  ${result.status}\n`,
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
					const totalEdges = results.reduce(
						(sum, r) => sum + (r.data?.edgesCreated ?? 0) + (r.data?.edgesUpdated ?? 0),
						0,
					);
					const totalDuplicates = results.reduce((sum, r) => sum + (r.data?.duplicatesFound ?? 0), 0);
					const totalContradictions = results.reduce((sum, r) => sum + (r.data?.contradictionsFlagged ?? 0), 0);
					const totalCorroboration = results.reduce((sum, r) => sum + (r.data?.corroborationUpdates ?? 0), 0);
					const totalSkipped = results.reduce((sum, r) => sum + r.metadata.items_skipped, 0);
					const totalFailed = results.filter((r) => r.status === 'failed').length;
					const totalDuration = results.reduce((sum, r) => sum + r.metadata.duration_ms, 0);

					const allFailed = results.length > 0 && results.every((r) => r.status === 'failed');
					const someFailed = results.some((r) => r.status === 'failed');

					const summary = `${totalEdges} edges, ${totalDuplicates} duplicates, ${totalContradictions} contradictions, ${totalCorroboration} corroboration updates, ${totalSkipped} skipped, ${totalFailed} failed (${totalDuration}ms)`;
					if (allFailed) {
						printError(`Graph failed: ${summary}`);
						process.exit(1);
					} else if (someFailed) {
						process.stderr.write(`Graph partial: ${summary}\n`);
					} else {
						printSuccess(`Graph complete: ${summary}`);
					}
				} finally {
					await closeAllPools();
				}
			}),
		);
}
