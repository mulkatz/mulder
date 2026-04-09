/**
 * CLI command group: `mulder taxonomy`.
 *
 * Subcommands:
 * - `bootstrap` — Generate taxonomy from extracted entities via Gemini clustering
 * - `re-bootstrap` — Regenerate taxonomy (replaces auto entries, keeps confirmed)
 * - `show` — Display current taxonomy tree
 *
 * Thin wrapper: parses arguments, loads config, creates registry,
 * calls taxonomy functions, formats output. No business logic here.
 *
 * @see docs/specs/46_taxonomy_bootstrap.spec.md §4.1
 * @see docs/functional-spec.md §1 (taxonomy cmd), §6.1
 */

import { closeAllPools, createLogger, createServiceRegistry, getWorkerPool, loadConfig } from '@mulder/core';
import type { BootstrapResult } from '@mulder/taxonomy';
import { bootstrapTaxonomy, rebootstrapTaxonomy, showTaxonomy } from '@mulder/taxonomy';
import type { Command } from 'commander';
import { withErrorHandler } from '../lib/errors.js';
import { printError, printJson, printSuccess } from '../lib/output.js';

// ────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────

interface BootstrapCommandOptions {
	minDocs?: string;
	json?: boolean;
}

interface ShowCommandOptions {
	type?: string;
	json?: boolean;
}

// ────────────────────────────────────────────────────────────
// Output formatters
// ────────────────────────────────────────────────────────────

function printBootstrapResult(result: BootstrapResult, json?: boolean): void {
	if (json) {
		printJson(result);
		return;
	}

	const lines: string[] = [];
	lines.push(`Corpus size: ${result.corpusSize} documents`);
	lines.push(`Types processed: ${result.typesProcessed.join(', ') || 'none'}`);

	if (result.skippedTypes.length > 0) {
		lines.push(`Types skipped (all confirmed): ${result.skippedTypes.join(', ')}`);
	}

	lines.push(`Entries created: ${result.entriesCreated}`);
	lines.push(`Entries updated: ${result.entriesUpdated}`);

	for (const line of lines) {
		process.stdout.write(`${line}\n`);
	}
}

// ────────────────────────────────────────────────────────────
// Command registration
// ────────────────────────────────────────────────────────────

/**
 * Registers the `taxonomy` command group on the given Commander program.
 *
 * Usage:
 * ```
 * mulder taxonomy bootstrap [--min-docs <n>] [--json]
 * mulder taxonomy re-bootstrap [--json]
 * mulder taxonomy show [--type <type>] [--json]
 * ```
 */
export function registerTaxonomyCommands(program: Command): void {
	const taxonomy = program
		.command('taxonomy')
		.description('Taxonomy management — bootstrap, curate, and inspect the entity taxonomy');

	// ── bootstrap ────────────────────────────────────────────

	taxonomy
		.command('bootstrap')
		.description('Generate taxonomy from all extracted entities via Gemini clustering')
		.option('--min-docs <n>', 'minimum processed documents required (overrides config threshold)')
		.option('--json', 'JSON output format')
		.action(
			withErrorHandler(async (options: BootstrapCommandOptions) => {
				const config = loadConfig();
				const logger = createLogger();
				const services = createServiceRegistry(config, logger);

				if (!config.gcp && !config.dev_mode) {
					printError('GCP configuration is required for taxonomy bootstrap (or enable dev_mode)');
					process.exit(1);
					return;
				}

				if (!config.gcp) {
					printError('GCP configuration with cloud_sql is required for taxonomy bootstrap');
					process.exit(1);
					return;
				}

				const pool = getWorkerPool(config.gcp.cloud_sql);

				try {
					const minDocs = options.minDocs !== undefined ? Number.parseInt(options.minDocs, 10) : undefined;

					if (minDocs !== undefined && Number.isNaN(minDocs)) {
						printError('--min-docs must be a valid number');
						process.exit(1);
						return;
					}

					const result = await bootstrapTaxonomy({
						pool,
						llm: services.llm,
						config,
						logger,
						minDocs,
					});

					printBootstrapResult(result, options.json);
					printSuccess(
						`Taxonomy bootstrap complete: ${result.entriesCreated} created, ${result.entriesUpdated} updated`,
					);
				} finally {
					await closeAllPools();
				}
			}),
		);

	// ── re-bootstrap ─────────────────────────────────────────

	taxonomy
		.command('re-bootstrap')
		.description('Regenerate taxonomy (deletes auto entries, keeps confirmed, re-runs bootstrap)')
		.option('--json', 'JSON output format')
		.action(
			withErrorHandler(async (options: { json?: boolean }) => {
				const config = loadConfig();
				const logger = createLogger();
				const services = createServiceRegistry(config, logger);

				if (!config.gcp && !config.dev_mode) {
					printError('GCP configuration is required for taxonomy re-bootstrap (or enable dev_mode)');
					process.exit(1);
					return;
				}

				if (!config.gcp) {
					printError('GCP configuration with cloud_sql is required for taxonomy re-bootstrap');
					process.exit(1);
					return;
				}

				const pool = getWorkerPool(config.gcp.cloud_sql);

				try {
					const result = await rebootstrapTaxonomy({
						pool,
						llm: services.llm,
						config,
						logger,
					});

					printBootstrapResult(result, options.json);
					printSuccess(
						`Taxonomy re-bootstrap complete: ${result.entriesCreated} created, ${result.entriesUpdated} updated`,
					);
				} finally {
					await closeAllPools();
				}
			}),
		);

	// ── show ─────────────────────────────────────────────────

	taxonomy
		.command('show')
		.description('Display current taxonomy tree')
		.option('--type <type>', 'filter by entity type')
		.option('--json', 'JSON output format')
		.action(
			withErrorHandler(async (options: ShowCommandOptions) => {
				const config = loadConfig();
				const logger = createLogger();

				if (!config.gcp && !config.dev_mode) {
					printError('GCP configuration is required for taxonomy show (or enable dev_mode)');
					process.exit(1);
					return;
				}

				if (!config.gcp) {
					printError('GCP configuration with cloud_sql is required for taxonomy show');
					process.exit(1);
					return;
				}

				const pool = getWorkerPool(config.gcp.cloud_sql);

				try {
					await showTaxonomy({
						pool,
						typeFilter: options.type,
						json: options.json,
						logger,
					});
				} finally {
					await closeAllPools();
				}
			}),
		);
}
