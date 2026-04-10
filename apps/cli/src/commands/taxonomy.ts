/**
 * CLI command group: `mulder taxonomy`.
 *
 * Subcommands:
 * - `bootstrap` — Generate taxonomy from extracted entities via Gemini clustering
 * - `re-bootstrap` — Regenerate taxonomy (replaces auto entries, keeps confirmed)
 * - `show` — Display current taxonomy tree
 * - `export` — Export taxonomy to curated YAML
 * - `curate` — Open curated YAML in $EDITOR
 * - `merge` — Merge curated YAML into active taxonomy
 *
 * Thin wrapper: parses arguments, loads config, creates registry,
 * calls taxonomy functions, formats output. No business logic here.
 *
 * @see docs/specs/46_taxonomy_bootstrap.spec.md §4.1
 * @see docs/specs/50_taxonomy_export_curate_merge.spec.md §4.2
 * @see docs/functional-spec.md §1 (taxonomy cmd), §6.1, §6.3
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { closeAllPools, createLogger, createServiceRegistry, getWorkerPool, loadConfig } from '@mulder/core';
import type { BootstrapResult, MergeChange, MergeResult } from '@mulder/taxonomy';
import { bootstrapTaxonomy, exportTaxonomy, mergeTaxonomy, rebootstrapTaxonomy, showTaxonomy } from '@mulder/taxonomy';
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

interface ExportCommandOptions {
	output?: string;
	type?: string;
}

interface MergeCommandOptions {
	input?: string;
	dryRun?: boolean;
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

function printMergeResult(result: MergeResult): void {
	// Summary table
	process.stderr.write('\nSummary:\n');
	process.stderr.write(`  Created:   ${result.created}\n`);
	process.stderr.write(`  Updated:   ${result.updated}\n`);
	process.stderr.write(`  Deleted:   ${result.deleted}\n`);
	process.stderr.write(`  Unchanged: ${result.unchanged}\n`);

	// Detailed change log (non-unchanged entries)
	const nonTrivial = result.changes.filter((c: MergeChange) => c.action !== 'unchanged');
	if (nonTrivial.length > 0) {
		process.stderr.write('\nChanges:\n');
		for (const change of nonTrivial) {
			const action = change.action.toUpperCase().padEnd(7);
			const details = change.details ? ` — ${change.details}` : '';
			process.stderr.write(`  [${action}] ${change.entityType}/${change.canonicalName}${details}\n`);
		}
	}

	// Errors/warnings
	if (result.errors.length > 0) {
		process.stderr.write('\nWarnings:\n');
		for (const err of result.errors) {
			process.stderr.write(`  ! ${err}\n`);
		}
	}

	process.stderr.write('\n');
}

/**
 * Resolves the curated YAML file path relative to the config file location.
 * Default filename: taxonomy.curated.yaml
 */
function resolveCuratedPath(): string {
	const configPath = resolve(process.env.MULDER_CONFIG ?? 'mulder.config.yaml');
	return resolve(dirname(configPath), 'taxonomy.curated.yaml');
}

/**
 * Prompts the user with a yes/no question. Returns true if the user answers 'y' or 'yes'.
 */
function promptYesNo(question: string): Promise<boolean> {
	return new Promise((resolve) => {
		const rl = createInterface({ input: process.stdin, output: process.stderr });
		rl.question(`${question} `, (answer) => {
			rl.close();
			resolve(answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes');
		});
	});
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

	// ── export ────────────────────────────────────────────────

	taxonomy
		.command('export')
		.description('Export taxonomy to curated YAML')
		.option('--output <path>', 'write to file instead of stdout')
		.option('--type <type>', 'filter to a single entity type')
		.action(
			withErrorHandler(async (options: ExportCommandOptions) => {
				const config = loadConfig();
				const logger = createLogger();

				if (!config.gcp) {
					printError('GCP configuration with cloud_sql is required for taxonomy export');
					process.exit(1);
					return;
				}

				const pool = getWorkerPool(config.gcp.cloud_sql);

				try {
					const result = await exportTaxonomy({
						pool,
						typeFilter: options.type,
						logger,
					});

					if (options.output) {
						const outputPath = resolve(options.output);
						writeFileSync(outputPath, result.yaml, 'utf-8');
						printSuccess(`Exported ${result.totalEntries} taxonomy entries to ${outputPath}`);
					} else {
						process.stdout.write(result.yaml);
					}
				} finally {
					await closeAllPools();
				}
			}),
		);

	// ── curate ────────────────────────────────────────────────

	taxonomy
		.command('curate')
		.description('Open taxonomy.curated.yaml in $EDITOR for curation')
		.action(
			withErrorHandler(async () => {
				const config = loadConfig();
				const logger = createLogger();

				if (!config.gcp) {
					printError('GCP configuration with cloud_sql is required for taxonomy curate');
					process.exit(1);
					return;
				}

				const curatedPath = resolveCuratedPath();

				// If the curated file doesn't exist, create it via export
				if (!existsSync(curatedPath)) {
					const pool = getWorkerPool(config.gcp.cloud_sql);

					try {
						const result = await exportTaxonomy({ pool, logger });
						writeFileSync(curatedPath, result.yaml, 'utf-8');
						printSuccess(`Created ${curatedPath} with ${result.totalEntries} entries`);
					} finally {
						await closeAllPools();
					}
				}

				// Open in editor
				const editor = process.env.EDITOR ?? 'vi';
				try {
					execFileSync(editor, [curatedPath], { stdio: 'inherit' });
				} catch {
					printError(`Editor "${editor}" exited with an error`);
					process.exit(1);
					return;
				}

				// Prompt to run merge
				const shouldMerge = await promptYesNo('Run merge now? [y/N]');
				if (shouldMerge) {
					const pool = getWorkerPool(config.gcp.cloud_sql);

					try {
						const yamlContent = readFileSync(curatedPath, 'utf-8');

						// Dry-run preview first
						const preview = await mergeTaxonomy({ pool, yamlContent, dryRun: true, logger });
						printMergeResult(preview);

						if (preview.created === 0 && preview.updated === 0 && preview.deleted === 0) {
							printSuccess('No changes to apply');
						} else {
							const confirm = await promptYesNo('Apply these changes? [y/N]');
							if (confirm) {
								const result = await mergeTaxonomy({ pool, yamlContent, logger });
								printMergeResult(result);
								printSuccess(
									`Merge complete: ${result.created} created, ${result.updated} updated, ${result.deleted} deleted`,
								);
							} else {
								printSuccess('Merge cancelled');
							}
						}
					} finally {
						await closeAllPools();
					}
				}
			}),
		);

	// ── merge ─────────────────────────────────────────────────

	taxonomy
		.command('merge')
		.description('Merge curated taxonomy YAML into the active taxonomy')
		.option('--input <path>', 'read from specified path (default: taxonomy.curated.yaml)')
		.option('--dry-run', 'preview changes without applying')
		.action(
			withErrorHandler(async (options: MergeCommandOptions) => {
				const config = loadConfig();
				const logger = createLogger();

				if (!config.gcp) {
					printError('GCP configuration with cloud_sql is required for taxonomy merge');
					process.exit(1);
					return;
				}

				const inputPath = options.input ? resolve(options.input) : resolveCuratedPath();

				if (!existsSync(inputPath)) {
					printError(`Curated taxonomy file not found: ${inputPath}`);
					printError('Run `mulder taxonomy export --output taxonomy.curated.yaml` first');
					process.exit(1);
					return;
				}

				const yamlContent = readFileSync(inputPath, 'utf-8');
				const pool = getWorkerPool(config.gcp.cloud_sql);

				try {
					const result = await mergeTaxonomy({
						pool,
						yamlContent,
						dryRun: options.dryRun,
						logger,
					});

					printMergeResult(result);

					if (options.dryRun) {
						printSuccess('Dry-run complete — no changes applied');
					} else {
						printSuccess(
							`Merge complete: ${result.created} created, ${result.updated} updated, ${result.deleted} deleted`,
						);
					}
				} finally {
					await closeAllPools();
				}
			}),
		);
}
