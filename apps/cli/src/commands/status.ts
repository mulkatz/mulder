/**
 * CLI command: `mulder status`.
 *
 * Single-screen overview of the entire Mulder instance. Shows aggregate
 * counts for sources, stories, entities, edges, chunks, and taxonomy
 * entries grouped by lifecycle status or type.
 *
 * Thin wrapper: parses arguments, loads config, creates pool,
 * calls repository functions, formats output. No business logic here.
 *
 * @see docs/specs/52_status_overview.spec.md
 * @see docs/functional-spec.md §1 (status cmd)
 */

import type { FailedSourceInfo, PipelineRun } from '@mulder/core';
import {
	closeAllPools,
	countChunks,
	countEdges,
	countEntities,
	countEntitiesByType,
	countSourcesByStatus,
	countStoriesByStatus,
	countTaxonomyEntries,
	findLatestPipelineRun,
	findSourcesWithFailedSteps,
	getWorkerPool,
	loadConfig,
} from '@mulder/core';
import chalk from 'chalk';
import type { Command } from 'commander';
import { withErrorHandler } from '../lib/errors.js';
import { printJson } from '../lib/output.js';

// ────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────

interface StatusCommandOptions {
	failed?: boolean;
	json?: boolean;
}

interface StatusOverviewJson {
	sources: {
		total: number;
		byStatus: Record<string, number>;
	};
	stories: {
		total: number;
		byStatus: Record<string, number>;
	};
	entities: {
		active: number;
		merged: number;
		byType: Record<string, number>;
	};
	edges: number;
	chunks: number;
	taxonomy: {
		confirmed: number;
		auto: number;
	};
	pipeline: {
		lastRun: {
			id: string;
			status: string;
			createdAt: string;
			finishedAt: string | null;
		} | null;
		failedSources: number;
	};
}

interface FailedSourcesJson {
	failedSources: FailedSourceInfo[];
	total: number;
}

// ────────────────────────────────────────────────────────────
// Output formatters
// ────────────────────────────────────────────────────────────

/** Truncates a UUID to its first 8 characters for display. */
function shortId(id: string): string {
	return id.slice(0, 8);
}

/** Sums all values in a Record<string, number>. */
function sumValues(record: Record<string, number>): number {
	let total = 0;
	for (const value of Object.values(record)) {
		total += value;
	}
	return total;
}

/** Formats grouped counts as inline pairs: "status count  status count  ..." */
function formatGroupedCounts(groups: Record<string, number>): string {
	const entries = Object.entries(groups);
	if (entries.length === 0) {
		return '';
	}

	const pairs = entries.map(([status, count]) => `${status.padEnd(12)} ${String(count).padStart(4)}`);

	// Lay out in rows of 3 pairs
	const lines: string[] = [];
	for (let i = 0; i < pairs.length; i += 3) {
		const row = pairs.slice(i, i + 3).join('    ');
		lines.push(`  ${row}`);
	}
	return lines.join('\n');
}

function printOverview(
	sourcesByStatus: Record<string, number>,
	storiesByStatus: Record<string, number>,
	entitiesByType: Record<string, number>,
	activeEntityCount: number,
	mergedEntityCount: number,
	edgeCount: number,
	chunkCount: number,
	taxonomyConfirmed: number,
	taxonomyAuto: number,
	lastRun: PipelineRun | null,
	failedSources: FailedSourceInfo[],
): void {
	const totalSources = sumValues(sourcesByStatus);
	const totalStories = sumValues(storiesByStatus);

	process.stdout.write(`\n${chalk.bold('Sources')}     ${totalSources} total\n`);
	const sourceGroups = formatGroupedCounts(sourcesByStatus);
	if (sourceGroups) {
		process.stdout.write(`${sourceGroups}\n`);
	}

	process.stdout.write(`\n${chalk.bold('Stories')}    ${totalStories} total\n`);
	const storyGroups = formatGroupedCounts(storiesByStatus);
	if (storyGroups) {
		process.stdout.write(`${storyGroups}\n`);
	}

	process.stdout.write(`\n${chalk.bold('Entities')}   ${activeEntityCount} active (${mergedEntityCount} merged)\n`);
	const entityGroups = formatGroupedCounts(entitiesByType);
	if (entityGroups) {
		process.stdout.write(`${entityGroups}\n`);
	}

	process.stdout.write(`\n${chalk.bold('Edges')}     ${edgeCount}\n`);
	process.stdout.write(`${chalk.bold('Chunks')}    ${chunkCount}\n`);
	process.stdout.write(`${chalk.bold('Taxonomy')}    ${taxonomyConfirmed} confirmed, ${taxonomyAuto} auto\n`);

	process.stdout.write(`\n${chalk.bold('Pipeline')}\n`);
	if (lastRun) {
		process.stdout.write(`  Last run   ${lastRun.createdAt.toISOString()}  ${lastRun.status}\n`);
	} else {
		process.stdout.write('  Last run   -\n');
	}
	process.stdout.write(`  Failed     ${failedSources.length} sources with failed steps\n`);

	process.stdout.write('\n');
}

function printFailedTable(failedSources: FailedSourceInfo[]): void {
	if (failedSources.length === 0) {
		process.stdout.write('No sources with failed steps\n');
		return;
	}

	process.stdout.write('Sources with failed steps:\n\n');

	const header = ['ID'.padEnd(10), 'Filename'.padEnd(24), 'Step'.padEnd(10), 'Error'].join('  ');

	process.stdout.write(`  ${chalk.bold(header)}\n`);
	process.stdout.write(`  ${'─'.repeat(10)}  ${'─'.repeat(24)}  ${'─'.repeat(10)}  ${'─'.repeat(22)}\n`);

	for (const info of failedSources) {
		const line = [
			shortId(info.sourceId).padEnd(10),
			(info.filename.length > 24 ? `${info.filename.slice(0, 21)}...` : info.filename).padEnd(24),
			info.stepName.padEnd(10),
			info.errorMessage ? info.errorMessage.slice(0, 40) : '-',
		].join('  ');
		process.stdout.write(`  ${line}\n`);
	}

	process.stdout.write(`\n${failedSources.length} sources with failed steps\n`);
}

// ────────────────────────────────────────────────────────────
// Command registration
// ────────────────────────────────────────────────────────────

/**
 * Registers the `status` command on the given Commander program.
 *
 * Usage:
 * ```
 * mulder status [--failed] [--json]
 * ```
 */
export function registerStatusCommand(program: Command): void {
	program
		.command('status')
		.description('Overview: sources, stories, entities, pipeline health')
		.option('--failed', 'Show only sources with failed pipeline steps')
		.option('--json', 'Machine-readable JSON output')
		.action(
			withErrorHandler(async (options: StatusCommandOptions) => {
				const config = loadConfig();

				if (!config.gcp) {
					process.stderr.write(
						`${chalk.red('\u2718')} GCP configuration with cloud_sql is required for status command\n`,
					);
					process.exit(1);
					return;
				}

				const pool = getWorkerPool(config.gcp.cloud_sql);

				try {
					// ── --failed path ──────────────────────────────────
					if (options.failed) {
						const failedSources = await findSourcesWithFailedSteps(pool);

						if (options.json) {
							const result: FailedSourcesJson = {
								failedSources,
								total: failedSources.length,
							};
							printJson(result);
							return;
						}

						printFailedTable(failedSources);
						return;
					}

					// ── Default overview path ──────────────────────────
					const [
						sourcesByStatus,
						storiesByStatus,
						entitiesByType,
						totalEntityCount,
						edgeCount,
						chunkCount,
						taxonomyConfirmed,
						taxonomyAuto,
						lastRun,
						failedSources,
					] = await Promise.all([
						countSourcesByStatus(pool),
						countStoriesByStatus(pool),
						countEntitiesByType(pool),
						countEntities(pool),
						countEdges(pool),
						countChunks(pool),
						countTaxonomyEntries(pool, { status: 'confirmed' }),
						countTaxonomyEntries(pool, { status: 'auto' }),
						findLatestPipelineRun(pool),
						findSourcesWithFailedSteps(pool),
					]);

					// Active entities = sum of entitiesByType (which excludes merged)
					const activeEntityCount = sumValues(entitiesByType);
					const mergedEntityCount = totalEntityCount - activeEntityCount;

					if (options.json) {
						const result: StatusOverviewJson = {
							sources: {
								total: sumValues(sourcesByStatus),
								byStatus: sourcesByStatus,
							},
							stories: {
								total: sumValues(storiesByStatus),
								byStatus: storiesByStatus,
							},
							entities: {
								active: activeEntityCount,
								merged: mergedEntityCount,
								byType: entitiesByType,
							},
							edges: edgeCount,
							chunks: chunkCount,
							taxonomy: {
								confirmed: taxonomyConfirmed,
								auto: taxonomyAuto,
							},
							pipeline: {
								lastRun: lastRun
									? {
											id: lastRun.id,
											status: lastRun.status,
											createdAt: lastRun.createdAt.toISOString(),
											finishedAt: lastRun.finishedAt ? lastRun.finishedAt.toISOString() : null,
										}
									: null,
								failedSources: failedSources.length,
							},
						};
						printJson(result);
						return;
					}

					printOverview(
						sourcesByStatus,
						storiesByStatus,
						entitiesByType,
						activeEntityCount,
						mergedEntityCount,
						edgeCount,
						chunkCount,
						taxonomyConfirmed,
						taxonomyAuto,
						lastRun,
						failedSources,
					);
				} finally {
					await closeAllPools();
				}
			}),
		);
}
