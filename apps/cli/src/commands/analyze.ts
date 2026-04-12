/**
 * CLI command: `mulder analyze`.
 *
 * Thin wrapper that validates selectors, loads config and services, runs the
 * graph-wide Analyze step, and formats the result.
 *
 * @see docs/specs/61_contradiction_resolution.spec.md §4.5
 * @see docs/specs/63_evidence_chains.spec.md §4.5
 * @see docs/functional-spec.md §2.8
 */

import { closeAllPools, createLogger, createServiceRegistry, getWorkerPool, loadConfig } from '@mulder/core';
import type { AnalyzeResult } from '@mulder/pipeline';
import { executeAnalyze } from '@mulder/pipeline';
import type { Command } from 'commander';
import { withErrorHandler } from '../lib/errors.js';
import { printError, printSuccess } from '../lib/output.js';

interface AnalyzeOptions {
	contradictions?: boolean;
	reliability?: boolean;
	evidenceChains?: boolean;
	spatioTemporal?: boolean;
	full?: boolean;
	thesis?: string[];
}

function hasUnsupportedSelector(options: AnalyzeOptions): boolean {
	return Boolean(options.full);
}

function printUnsupportedSelectorMessage(options: AnalyzeOptions): void {
	if (options.full) {
		printError('--full is not implemented yet — it belongs to M6-G7');
	}
}

function countImplementedSelectors(options: AnalyzeOptions): number {
	return (
		Number(Boolean(options.contradictions)) +
		Number(Boolean(options.reliability)) +
		Number(Boolean(options.evidenceChains)) +
		Number(Boolean(options.spatioTemporal))
	);
}

function normalizeTheses(values?: string[]): string[] {
	if (!Array.isArray(values)) {
		return [];
	}

	return values.filter((value) => value.trim().length > 0);
}

function printEvidenceChainsTable(result: AnalyzeResult): void {
	if (result.data.mode !== 'evidence-chains' || result.data.outcomes.length === 0) {
		return;
	}

	const header = `${'Thesis'.padEnd(40)}  ${'Status'.padEnd(8)}  ${'Seeds'.padEnd(5)}  ${'Support'.padEnd(7)}  ${'Contradict'.padEnd(10)}  Written`;
	const separator = '-'.repeat(header.length);
	process.stdout.write(`${header}\n`);
	process.stdout.write(`${separator}\n`);

	for (const outcome of result.data.outcomes) {
		const thesis = outcome.thesis.length > 38 ? `${outcome.thesis.substring(0, 35)}...` : outcome.thesis;
		process.stdout.write(
			`${thesis.padEnd(40)}  ${outcome.status.padEnd(8)}  ${String(outcome.seedCount).padEnd(5)}  ${String(outcome.supportingCount).padEnd(7)}  ${String(outcome.contradictionCount).padEnd(10)}  ${outcome.writtenCount}\n`,
		);
	}
}

function printOutcomeTable(result: AnalyzeResult): void {
	if (result.data.mode !== 'contradictions') {
		return;
	}

	if (result.data.outcomes.length === 0) {
		return;
	}

	const header = `${'Edge ID'.padEnd(36)}  ${'Attribute'.padEnd(16)}  ${'Verdict'.padEnd(10)}  ${'Winner'.padEnd(7)}  Confidence`;
	const separator = '-'.repeat(header.length);
	process.stdout.write(`${header}\n`);
	process.stdout.write(`${separator}\n`);

	for (const outcome of result.data.outcomes) {
		process.stdout.write(
			`${outcome.edgeId.padEnd(36)}  ${outcome.attribute.padEnd(16)}  ${outcome.verdict.padEnd(10)}  ${outcome.winningClaim.padEnd(7)}  ${outcome.confidence.toFixed(2)}\n`,
		);
	}
}

function printReliabilityTable(result: AnalyzeResult): void {
	if (result.data.mode !== 'reliability') {
		return;
	}

	if (result.data.outcomes.length === 0) {
		return;
	}

	const header = `${'Source ID'.padEnd(36)}  ${'Filename'.padEnd(28)}  ${'Score'.padEnd(7)}  ${'Neighbors'.padEnd(9)}  Shared`;
	const separator = '-'.repeat(header.length);
	process.stdout.write(`${header}\n`);
	process.stdout.write(`${separator}\n`);

	for (const outcome of result.data.outcomes) {
		const filename = outcome.filename.length > 26 ? `${outcome.filename.substring(0, 23)}...` : outcome.filename;
		process.stdout.write(
			`${outcome.sourceId.padEnd(36)}  ${filename.padEnd(28)}  ${outcome.reliabilityScore.toFixed(2).padEnd(7)}  ${String(outcome.neighborCount).padEnd(9)}  ${outcome.sharedEntityCount}\n`,
		);
	}
}

function printSpatioTemporalTable(result: AnalyzeResult): void {
	if (result.data.mode !== 'spatio-temporal' || result.data.clusters.length === 0) {
		return;
	}

	const header = `${'Type'.padEnd(16)}  ${'Events'.padEnd(6)}  ${'Time Window'.padEnd(33)}  Center`;
	const separator = '-'.repeat(header.length);
	process.stdout.write(`${header}\n`);
	process.stdout.write(`${separator}\n`);

	for (const cluster of result.data.clusters) {
		const timeWindow =
			cluster.timeStart && cluster.timeEnd
				? `${cluster.timeStart.toISOString().slice(0, 10)} → ${cluster.timeEnd.toISOString().slice(0, 10)}`
				: 'n/a';
		const center =
			typeof cluster.centerLat === 'number' && typeof cluster.centerLng === 'number'
				? `${cluster.centerLat.toFixed(4)}, ${cluster.centerLng.toFixed(4)}`
				: 'n/a';
		process.stdout.write(
			`${cluster.clusterType.padEnd(16)}  ${String(cluster.eventCount).padEnd(6)}  ${timeWindow.padEnd(33)}  ${center}\n`,
		);
	}
}

export function registerAnalyzeCommands(program: Command): void {
	program
		.command('analyze')
		.description('Run graph-wide analysis passes')
		.option('--contradictions', 'resolve pending contradiction edges')
		.option('--reliability', 'score source reliability')
		.option('--evidence-chains', 'compute evidence chains')
		.option(
			'--thesis <text>',
			'repeatable thesis override for evidence-chain analysis',
			(value: string, previous: string[] = []) => {
				return [...previous, value];
			},
			[],
		)
		.option('--spatio-temporal', 'compute spatio-temporal clusters')
		.option('--full', 'run the full analyze orchestrator (not yet implemented)')
		.action(
			withErrorHandler(async (options: AnalyzeOptions) => {
				const rawTheses = normalizeTheses(options.thesis);

				if (options.thesis && options.thesis.length > 0 && rawTheses.length === 0) {
					printError('--thesis requires evidence-chain analysis and cannot be empty');
					process.exit(1);
					return;
				}

				if (rawTheses.length > 0 && !options.evidenceChains) {
					printError('--thesis can only be used with --evidence-chains');
					process.exit(1);
					return;
				}

				const implementedSelectorCount = countImplementedSelectors(options);

				if (implementedSelectorCount === 0 && !hasUnsupportedSelector(options)) {
					printError('Provide an analysis selector such as --contradictions');
					process.exit(1);
					return;
				}

				if (implementedSelectorCount > 1) {
					printError('Running multiple analyze selectors together is not implemented yet — use one selector at a time');
					process.exit(1);
					return;
				}

				if (hasUnsupportedSelector(options)) {
					printUnsupportedSelectorMessage(options);
					process.exit(1);
					return;
				}

				const config = loadConfig();
				const logger = createLogger();
				const services = createServiceRegistry(config, logger);

				if (!config.gcp && !config.dev_mode) {
					printError('GCP configuration is required for analyze (or enable dev_mode)');
					process.exit(1);
					return;
				}

				if (!config.gcp) {
					printError('GCP configuration with cloud_sql is required for analyze');
					process.exit(1);
					return;
				}

				const pool = getWorkerPool(config.gcp.cloud_sql);

				try {
					const result = await executeAnalyze(
						{
							contradictions: options.contradictions ?? false,
							reliability: options.reliability ?? false,
							evidenceChains: options.evidenceChains ?? false,
							spatioTemporal: options.spatioTemporal ?? false,
							theses: rawTheses,
						},
						config,
						services,
						pool,
						logger,
					);

					if (result.data.mode === 'contradictions') {
						printOutcomeTable(result);
					} else if (result.data.mode === 'reliability') {
						printReliabilityTable(result);
					} else if (result.data.mode === 'spatio-temporal') {
						printSpatioTemporalTable(result);
					} else {
						printEvidenceChainsTable(result);
					}

					for (const error of result.errors) {
						printError(`[${error.code}] ${error.message}`);
					}

					if (result.data.mode === 'contradictions') {
						if (result.data.pendingCount === 0) {
							printSuccess(`Analyze complete: no pending contradiction edges found (${result.metadata.duration_ms}ms)`);
							return;
						}

						const summary = `${result.data.processedCount} processed, ${result.data.confirmedCount} confirmed, ${result.data.dismissedCount} dismissed, ${result.data.failedCount} failed (${result.metadata.duration_ms}ms)`;

						if (result.status === 'failed') {
							printError(`Analyze failed: ${summary}`);
							process.exit(1);
						} else if (result.status === 'partial') {
							process.stderr.write(`Analyze partial: ${summary}\n`);
						} else {
							printSuccess(`Analyze complete: ${summary}`);
						}
					} else if (result.data.mode === 'reliability') {
						if (result.data.outcomes.length === 0) {
							printSuccess(`Analyze complete: no graph-connected sources found (${result.metadata.duration_ms}ms)`);
							return;
						}

						if (result.data.belowThreshold) {
							process.stderr.write(
								`Analyze warning: corpus below meaningful reliability threshold (${result.data.sourceCount}/${result.data.threshold} graph-connected sources)\n`,
							);
						}

						const summary = `${result.data.scoredCount} scored, ${result.data.sourceCount} graph-connected sources (${result.metadata.duration_ms}ms)`;

						if (result.status === 'failed') {
							printError(`Analyze failed: ${summary}`);
							process.exit(1);
						} else if (result.status === 'partial') {
							process.stderr.write(`Analyze partial: ${summary}\n`);
						} else {
							printSuccess(`Analyze complete: ${summary}`);
						}
					} else if (result.data.mode === 'spatio-temporal') {
						if (result.data.warning) {
							process.stderr.write(`Analyze warning: ${result.data.warning}\n`);
						}

						if (result.data.nothingToAnalyze) {
							printSuccess(`Analyze complete: no clusterable events found (${result.metadata.duration_ms}ms)`);
							return;
						}

						if (result.data.persistedCount === 0 && !result.data.belowThreshold) {
							printSuccess(`Analyze complete: no clusters found (${result.metadata.duration_ms}ms)`);
							return;
						}

						const summary = `${result.data.persistedCount} clusters persisted (${result.data.temporalClusterCount} temporal, ${result.data.spatialClusterCount} spatial, ${result.data.spatioTemporalClusterCount} spatio-temporal) (${result.metadata.duration_ms}ms)`;

						if (result.status === 'failed') {
							printError(`Analyze failed: ${summary}`);
							process.exit(1);
						} else if (result.status === 'partial') {
							process.stderr.write(`Analyze partial: ${summary}\n`);
						} else {
							printSuccess(`Analyze complete: ${summary}`);
						}
					} else {
						if (
							result.data.supportingCount === 0 &&
							result.data.contradictionCount === 0 &&
							result.data.failedCount === 0
						) {
							printSuccess(`Analyze complete: no evidence chains found (${result.metadata.duration_ms}ms)`);
							return;
						}

						const summary = `${result.data.successCount} successful theses, ${result.data.failedCount} failed, ${result.data.supportingCount} supporting, ${result.data.contradictionCount} contradiction-backed (${result.metadata.duration_ms}ms)`;

						if (result.status === 'failed') {
							printError(`Analyze failed: ${summary}`);
							process.exit(1);
						} else if (result.status === 'partial') {
							process.stderr.write(`Analyze partial: ${summary}\n`);
						} else {
							printSuccess(`Analyze complete: ${summary}`);
						}
					}
				} finally {
					await closeAllPools();
				}
			}),
		);
}
