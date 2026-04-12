/**
 * CLI command: `mulder ground <entity-id>`.
 *
 * Thin wrapper that parses arguments, loads config, creates service
 * registry, calls the Ground pipeline step, and formats the output.
 * No business logic lives here.
 *
 * @see docs/specs/60_ground_step.spec.md §4.5
 * @see docs/functional-spec.md §1 (ground cmd), §2.5
 */

import {
	closeAllPools,
	createLogger,
	createServiceRegistry,
	findAllEntities,
	getWorkerPool,
	loadConfig,
} from '@mulder/core';
import type { GroundResult } from '@mulder/pipeline';
import { executeGround } from '@mulder/pipeline';
import type { Command } from 'commander';
import { withErrorHandler } from '../lib/errors.js';
import { printError, printSuccess } from '../lib/output.js';

interface GroundOptions {
	all?: boolean;
	type?: string;
	batch?: number;
	refresh?: boolean;
}

const DEFAULT_BATCH_SIZE = 10;

function isPositiveInteger(value: unknown): value is number {
	return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

export function registerGroundCommands(program: Command): void {
	program
		.command('ground')
		.description('Web-enrich entities with grounded Gemini search')
		.argument('[entity-id]', 'UUID of the entity to ground')
		.option('--all', 'ground all eligible entities')
		.option('--type <type>', 'ground all eligible entities of a specific type')
		.option('--batch <n>', 'limit batch modes to n entities', (value: string) => Number.parseInt(value, 10))
		.option('--refresh', 're-ground even if cached')
		.action(
			withErrorHandler(async (entityId: string | undefined, options: GroundOptions) => {
				if (typeof options.type === 'string' && options.type.trim().length === 0) {
					printError('--type must be a non-empty string');
					process.exit(1);
					return;
				}

				if (!entityId && !options.all && !options.type) {
					printError('Provide an <entity-id>, use --all, or use --type <type>');
					process.exit(1);
					return;
				}

				if (entityId && (options.all || options.type)) {
					printError('<entity-id> and --all/--type are mutually exclusive');
					process.exit(1);
					return;
				}

				if (options.all && options.type) {
					printError('--all and --type are mutually exclusive');
					process.exit(1);
					return;
				}

				if (options.batch !== undefined && !isPositiveInteger(options.batch)) {
					printError('--batch must be a positive integer');
					process.exit(1);
					return;
				}

				if (entityId && options.batch !== undefined) {
					printError('--batch is only valid with --all or --type');
					process.exit(1);
					return;
				}

				const config = loadConfig();
				const logger = createLogger();
				const services = createServiceRegistry(config, logger);

				if (!config.gcp && !config.dev_mode) {
					printError('GCP configuration is required for ground (or enable dev_mode)');
					process.exit(1);
					return;
				}

				if (!config.gcp) {
					printError('GCP configuration with cloud_sql is required for ground');
					process.exit(1);
					return;
				}

				const pool = getWorkerPool(config.gcp.cloud_sql);
				const allowedTypes = new Set(config.grounding.enrich_types);

				try {
					const results: GroundResult[] = [];
					const batchSize = options.batch ?? DEFAULT_BATCH_SIZE;

					if (entityId) {
						const result = await executeGround({ entityId, refresh: options.refresh }, config, services, pool, logger);
						results.push(result);
					} else {
						const entityLimit = Math.max(batchSize * 20, 100);
						const candidates = await findAllEntities(pool, {
							type: options.type,
							limit: entityLimit,
						});
						const selected = candidates
							.filter((entity) => entity.canonicalId === null && allowedTypes.has(entity.type))
							.slice(0, batchSize);

						if (selected.length === 0) {
							printSuccess('No eligible entities found to ground');
							return;
						}

						logger.info(
							{
								entityCount: selected.length,
								type: options.type ?? null,
								refresh: options.refresh ?? false,
							},
							'Grounding selected entity batch',
						);

						for (const entity of selected) {
							try {
								const result = await executeGround(
									{ entityId: entity.id, refresh: options.refresh },
									config,
									services,
									pool,
									logger,
								);
								results.push(result);
							} catch (error: unknown) {
								const message = error instanceof Error ? error.message : String(error);
								printError(`${entity.id}: ${message}`);
								results.push({
									status: 'failed',
									data: null,
									errors: [{ code: 'GROUND_WRITE_FAILED', message }],
									metadata: { duration_ms: 0, items_processed: 0, items_skipped: 0, items_cached: 0 },
								});
							}
						}
					}

					const successResults = results.filter((result) => result.data !== null);
					if (successResults.length > 0) {
						const header = `${'Entity ID'.padEnd(36)}  ${'Type'.padEnd(14)}  ${'Outcome'.padEnd(10)}  ${'URLs'.padEnd(4)}  Geom`;
						const separator = '-'.repeat(header.length);

						process.stdout.write(`${header}\n`);
						process.stdout.write(`${separator}\n`);

						for (const result of successResults) {
							const data = result.data;
							if (!data) continue;
							process.stdout.write(
								`${data.entityId.padEnd(36)}  ${data.entityType.padEnd(14)}  ${data.outcome.padEnd(10)}  ${String(data.sourceUrlCount).padEnd(4)}  ${data.coordinatesApplied ? 'yes' : 'no'}\n`,
							);
						}
					}

					for (const result of results) {
						for (const error of result.errors) {
							printError(`[${error.code}] ${error.message}`);
						}
					}

					const groundedCount = results.filter((result) => result.data?.outcome === 'grounded').length;
					const cachedCount = results.filter((result) => result.data?.outcome === 'cached').length;
					const skippedCount = results.filter((result) => result.data?.outcome === 'skipped').length;
					const failedCount = results.filter((result) => result.status === 'failed').length;
					const totalDuration = results.reduce((sum, result) => sum + result.metadata.duration_ms, 0);

					const allFailed = results.length > 0 && results.every((result) => result.status === 'failed');
					const someFailed = results.some((result) => result.status === 'failed');
					const summary = `${groundedCount} grounded, ${cachedCount} cached, ${skippedCount} skipped, ${failedCount} failed (${totalDuration}ms)`;

					if (allFailed) {
						printError(`Ground failed: ${summary}`);
						process.exit(1);
					} else if (someFailed) {
						process.stderr.write(`Ground partial: ${summary}\n`);
					} else {
						printSuccess(`Ground complete: ${summary}`);
					}
				} finally {
					await closeAllPools();
				}
			}),
		);
}
