/**
 * CLI command: `mulder embed <story-id>`.
 *
 * Thin wrapper that parses arguments, loads config, creates service
 * registry, calls the embed pipeline step, and formats the output.
 * No business logic lives here.
 *
 * @see docs/specs/34_embed_step.spec.md §4.3
 * @see docs/functional-spec.md §1 (embed cmd), §2.6
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
import type { EmbedResult } from '@mulder/pipeline';
import { executeEmbed, forceCleanupEmbedSource } from '@mulder/pipeline';
import type { Command } from 'commander';
import { withErrorHandler } from '../lib/errors.js';
import { printError, printSuccess } from '../lib/output.js';

interface EmbedOptions {
	all?: boolean;
	source?: string;
	force?: boolean;
}

/**
 * Registers the `embed` command on the given Commander program.
 *
 * Usage:
 * ```
 * mulder embed <story-id>
 *   --all                Embed all stories with status=enriched
 *   --source <id>        Embed all stories from a specific source
 *   --force              Re-embed even if already embedded
 * ```
 */
export function registerEmbedCommands(program: Command): void {
	program
		.command('embed')
		.description('Generate embeddings for stories')
		.argument('[story-id]', 'UUID of the story to embed')
		.option('--all', 'embed all stories with status=enriched')
		.option('--source <id>', 'embed all stories from a specific source')
		.option('--force', 're-embed even if already embedded')
		.action(
			withErrorHandler(async (storyId: string | undefined, options: EmbedOptions) => {
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
					printError('GCP configuration is required for embed (or enable dev_mode)');
					process.exit(1);
					return;
				}

				if (!config.gcp) {
					printError('GCP configuration with cloud_sql is required for embed');
					process.exit(1);
					return;
				}

				const pool = getWorkerPool(config.gcp.cloud_sql);

				try {
					const results: EmbedResult[] = [];

					if (options.all) {
						// Batch embedding: all enriched stories
						const stories = await findAllStories(pool, { status: 'enriched' });
						if (stories.length === 0) {
							printSuccess('No enriched stories found to embed');
							return;
						}

						logger.info({ storyCount: stories.length }, 'Embedding all enriched stories');

						for (const story of stories) {
							try {
								const result = await executeEmbed(
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
									errors: [{ code: 'EMBED_STEP_FAILED', message }],
									metadata: { duration_ms: 0, items_processed: 0, items_skipped: 0, items_cached: 0 },
								});
							}
						}
					} else if (options.source) {
						// Source-scoped embedding
						const stories = await findStoriesBySourceId(pool, options.source);
						if (stories.length === 0) {
							printSuccess('No stories found for this source');
							return;
						}

						// If --force, do source-level cleanup first
						if (options.force) {
							await forceCleanupEmbedSource(options.source, pool, logger);
						}

						logger.info({ sourceId: options.source, storyCount: stories.length }, 'Embedding stories from source');

						for (const story of stories) {
							// After source-level cleanup, all stories are back to enriched
							// so no need for per-story force
							try {
								const result = await executeEmbed({ storyId: story.id, force: false }, config, services, pool, logger);
								results.push(result);
							} catch (error: unknown) {
								const message = error instanceof Error ? error.message : String(error);
								printError(`${story.id}: ${message}`);
								results.push({
									status: 'failed',
									data: null,
									errors: [{ code: 'EMBED_STEP_FAILED', message }],
									metadata: { duration_ms: 0, items_processed: 0, items_skipped: 0, items_cached: 0 },
								});
							}
						}
					} else if (storyId) {
						// Single story embedding
						const result = await executeEmbed({ storyId, force: options.force }, config, services, pool, logger);
						results.push(result);
					}

					// Print results table
					const successResults = results.filter((r) => r.data !== null);
					if (successResults.length > 0) {
						const header = `${'Story ID'.padEnd(36)}  ${'Chunks'.padEnd(10)}  ${'Questions'.padEnd(10)}  ${'Embeddings'.padEnd(10)}  Status`;
						const separator = '-'.repeat(header.length);

						process.stdout.write(`${header}\n`);
						process.stdout.write(`${separator}\n`);

						for (const result of successResults) {
							const data = result.data;
							if (!data) continue;
							process.stdout.write(
								`${data.storyId.padEnd(36)}  ${String(data.chunksCreated).padEnd(10)}  ${String(data.questionsGenerated).padEnd(10)}  ${String(data.embeddingsCreated).padEnd(10)}  ${result.status}\n`,
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
					const totalChunks = results.reduce((sum, r) => sum + (r.data?.chunksCreated ?? 0), 0);
					const totalQuestions = results.reduce((sum, r) => sum + (r.data?.questionsGenerated ?? 0), 0);
					const totalEmbeddings = results.reduce((sum, r) => sum + (r.data?.embeddingsCreated ?? 0), 0);
					const totalSkipped = results.reduce((sum, r) => sum + r.metadata.items_skipped, 0);
					const totalFailed = results.filter((r) => r.status === 'failed').length;
					const totalDuration = results.reduce((sum, r) => sum + r.metadata.duration_ms, 0);

					const allFailed = results.length > 0 && results.every((r) => r.status === 'failed');
					const someFailed = results.some((r) => r.status === 'failed');

					const summary = `${totalChunks} chunks created, ${totalQuestions} questions generated, ${totalEmbeddings} embeddings stored, ${totalSkipped} skipped, ${totalFailed} failed (${totalDuration}ms)`;
					if (allFailed) {
						printError(`Embed failed: ${summary}`);
						process.exit(1);
					} else if (someFailed) {
						process.stderr.write(`Embed partial: ${summary}\n`);
					} else {
						printSuccess(`Embed complete: ${summary}`);
					}
				} finally {
					await closeAllPools();
				}
			}),
		);
}
