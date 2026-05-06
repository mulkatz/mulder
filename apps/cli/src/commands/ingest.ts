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

import { readFile } from 'node:fs/promises';
import { closeAllPools, createLogger, createServiceRegistry, getWorkerPool, loadConfig } from '@mulder/core';
import type { IngestProvenanceInput } from '@mulder/pipeline';
import { executeIngest, isSupportedUrlInput, parseIngestProvenanceInput } from '@mulder/pipeline';
import type { Command } from 'commander';
import {
	collectIngestSourceProfiles,
	estimateForSteps,
	printCostEstimate,
	promptYesNo,
	requiresConfirmation,
	shouldShowEstimate,
} from '../lib/cost-estimate.js';
import { withErrorHandler } from '../lib/errors.js';
import { printError, printSuccess } from '../lib/output.js';

interface IngestOptions {
	dryRun?: boolean;
	tag?: string[];
	costEstimate?: boolean;
	provenance?: string;
}

async function loadProvenanceInput(path: string | undefined): Promise<IngestProvenanceInput | undefined> {
	if (!path) {
		return undefined;
	}
	const raw = await readFile(path, 'utf-8');
	return parseIngestProvenanceInput(JSON.parse(raw));
}

/**
 * Registers the `ingest` command on the given Commander program.
 *
 * Usage:
 * ```
 * mulder ingest <path>
 *   --dry-run         Validate without uploading
 *   --tag <tag>       Tag ingested sources (repeatable)
 *   --cost-estimate   Show an estimated downstream pipeline cost before executing
 * ```
 */
export function registerIngestCommands(program: Command): void {
	program
		.command('ingest')
		.description('Ingest PDFs, images, text, DOCX, spreadsheets, email messages, or one URL')
		.argument('<path>', 'path to a supported file/directory, or one http(s) URL')
		.option('--dry-run', 'validate without uploading or creating DB records')
		.option('--tag <tag>', 'tag ingested sources (repeatable)', collect, [])
		.option('--cost-estimate', 'show an estimated downstream pipeline cost before executing')
		.option('--provenance <path>', 'load ingest provenance metadata from a JSON file')
		.addHelpText(
			'after',
			`
Examples:
  $ mulder ingest ./incoming/                      # Ingest supported files in a directory
  $ mulder ingest paper.pdf --tag review --tag q1  # Tag a single ingest with two tags
  $ mulder ingest paper.pdf --dry-run              # Validate without writing to GCS or the DB
  $ mulder ingest paper.pdf --provenance prov.json  # Attach provenance metadata
  $ mulder ingest https://example.com/article      # Fetch and snapshot one HTML page`,
		)
		.action(
			withErrorHandler(async (inputPath: string, options: IngestOptions) => {
				const config = loadConfig();
				const sourceProfiles = await collectIngestSourceProfiles(inputPath);
				const estimate = estimateForSteps({
					mode: 'ingest',
					sourceProfiles,
					steps: ['extract', 'segment', 'enrich', 'embed'],
					groundingEnabled: false,
				});
				const showEstimate = shouldShowEstimate({
					explicit: options.costEstimate ?? false,
					estimate,
					maxPagesWithoutConfirm: config.safety.max_pages_without_confirm,
					maxCostWithoutConfirmUsd: config.safety.max_cost_without_confirm_usd,
				});

				if (showEstimate) {
					printCostEstimate('Cost estimate for ingest-triggered pipeline', estimate);
				}

				if (options.dryRun && showEstimate && !isSupportedUrlInput(inputPath)) {
					return;
				}

				if (
					requiresConfirmation({
						explicit: options.costEstimate ?? false,
						dryRun: options.dryRun ?? false,
						estimate,
						maxPagesWithoutConfirm: config.safety.max_pages_without_confirm,
						maxCostWithoutConfirmUsd: config.safety.max_cost_without_confirm_usd,
					})
				) {
					const confirmed = await promptYesNo('Proceed? [y/N]');
					if (!confirmed) {
						printError('Operation cancelled');
						process.exit(1);
						return;
					}
				}

				const logger = createLogger();
				const services = createServiceRegistry(config, logger);
				const provenance = await loadProvenanceInput(options.provenance);

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
							provenance,
						},
						config,
						services,
						pool,
						logger,
					);

					// Print results table
					if (result.data.length > 0) {
						const header = `${'Filename'.padEnd(40)}  ${'Type'.padEnd(6)}  ${'Source ID'.padEnd(36)}  ${'Pages'.padEnd(6)}  ${'Native Text'.padEnd(12)}  Status`;
						const separator = '-'.repeat(header.length);

						process.stdout.write(`${header}\n`);
						process.stdout.write(`${separator}\n`);

						for (const item of result.data) {
							const filename = item.filename.length > 38 ? `${item.filename.substring(0, 35)}...` : item.filename;
							const nativeText = item.hasNativeText ? `${(item.nativeTextRatio * 100).toFixed(0)}%` : 'no';
							const status = item.duplicate ? 'duplicate' : options.dryRun ? 'validated' : 'ingested';
							process.stdout.write(
								`${filename.padEnd(40)}  ${item.sourceType.padEnd(6)}  ${item.sourceId.padEnd(36)}  ${String(item.pageCount).padEnd(6)}  ${nativeText.padEnd(12)}  ${status}\n`,
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
