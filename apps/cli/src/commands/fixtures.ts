/**
 * CLI commands: `mulder fixtures generate` and `mulder fixtures status`.
 *
 * Manages test fixture generation from real GCP API responses.
 * The `generate` subcommand runs real GCP services against test PDFs
 * and captures outputs as committed fixtures. The `status` subcommand
 * shows what fixtures exist and their staleness.
 *
 * @see docs/specs/20_fixture_generator.spec.md §4.2
 * @see docs/functional-spec.md §11, §9.1
 */

import { join } from 'node:path';
import { createGcpServices, createLogger, loadConfig } from '@mulder/core';
import { generateFixtures, getFixtureStatus } from '@mulder/pipeline';
import chalk from 'chalk';
import type { Command } from 'commander';
import { withErrorHandler } from '../lib/errors.js';
import { printError, printSuccess } from '../lib/output.js';

interface GenerateOptions {
	input?: string;
	output?: string;
	force?: boolean;
	step?: string;
	verbose?: boolean;
}

/**
 * Registers the `fixtures` command group on the given Commander program.
 *
 * Usage:
 * ```
 * mulder fixtures generate [options]    Generate fixtures from real GCP API responses
 * mulder fixtures status                Show fixture status for all source PDFs
 * ```
 */
export function registerFixtureCommands(program: Command): void {
	const fixturesCmd = program.command('fixtures').description('Manage test fixtures (real GCP API responses)');

	fixturesCmd
		.command('generate')
		.description('Generate fixtures from real GCP API responses against test PDFs')
		.option('--input <dir>', 'source PDF directory', 'fixtures/raw')
		.option('--output <dir>', 'output fixtures directory', 'fixtures')
		.option('--force', 'regenerate all fixtures (ignore existing)')
		.option('--step <name>', 'only run specific step (extract)')
		.option('--verbose', 'show detailed progress per file')
		.action(
			withErrorHandler(async (options: GenerateOptions) => {
				const config = loadConfig();
				const logger = createLogger();

				if (!config.gcp) {
					printError('GCP configuration is required for fixture generation');
					printError(
						'Fixture generation always uses real GCP services — configure the gcp section in mulder.config.yaml',
					);
					process.exit(1);
					return;
				}

				// Force GCP service mode — bypass the registry
				const services = createGcpServices(config, logger);

				const inputDir = join(process.cwd(), options.input ?? 'fixtures/raw');
				const outputDir = join(process.cwd(), options.output ?? 'fixtures');

				const result = await generateFixtures(
					{
						inputDir,
						outputDir,
						force: options.force ?? false,
						step: options.step,
					},
					services,
					config,
					logger,
				);

				// Print summary
				if (result.generated.length > 0) {
					process.stdout.write('\nGenerated:\n');
					for (const artifact of result.generated) {
						process.stdout.write(`  ${artifact.sourceSlug} (${artifact.step}): ${artifact.paths.length} files\n`);
						if (options.verbose) {
							for (const path of artifact.paths) {
								process.stdout.write(`    ${path}\n`);
							}
						}
					}
				}

				if (result.skipped.length > 0) {
					process.stdout.write('\nSkipped (already exist):\n');
					for (const slug of result.skipped) {
						process.stdout.write(`  ${slug}\n`);
					}
				}

				if (result.errors.length > 0) {
					process.stdout.write('\nErrors:\n');
					for (const error of result.errors) {
						printError(`${error.sourceSlug} (${error.step}): ${error.message}`);
					}
				}

				// Final status
				const totalArtifacts = result.generated.reduce((sum, a) => sum + a.paths.length, 0);
				const summary = `${result.generated.length} sources processed, ${totalArtifacts} files written, ${result.skipped.length} skipped, ${result.errors.length} errors`;

				if (result.status === 'success') {
					printSuccess(`Fixture generation complete: ${summary}`);
				} else if (result.status === 'partial') {
					process.stderr.write(`${chalk.yellow('!')} Fixture generation partial: ${summary}\n`);
					process.exit(1);
				} else {
					printError(`Fixture generation failed: ${summary}`);
					process.exit(1);
				}
			}),
		);

	fixturesCmd
		.command('status')
		.description('Show fixture status for all source PDFs')
		.action(
			withErrorHandler(async () => {
				const fixturesDir = join(process.cwd(), 'fixtures');
				const statuses = getFixtureStatus(fixturesDir);

				if (statuses.length === 0) {
					process.stdout.write('No PDF files found in fixtures/raw/\n');
					return;
				}

				// Print table header
				const header = `${'Source'.padEnd(30)}  ${'Extract'.padEnd(9)}  ${'Segment'.padEnd(9)}  ${'Entity'.padEnd(9)}  ${'Embed'.padEnd(9)}  ${'Ground'.padEnd(9)}  ${'Stale'.padEnd(5)}`;
				const separator = '-'.repeat(header.length);

				process.stdout.write(`${header}\n`);
				process.stdout.write(`${separator}\n`);

				for (const status of statuses) {
					const indicator = (has: boolean): string => (has ? chalk.green('yes') : chalk.dim('no'));
					const staleIndicator = status.isStale ? chalk.yellow('yes') : chalk.dim('no');

					process.stdout.write(
						`${status.slug.padEnd(30)}  ${indicator(status.hasExtracted).padEnd(9)}  ${indicator(status.hasSegments).padEnd(9)}  ${indicator(status.hasEntities).padEnd(9)}  ${indicator(status.hasEmbeddings).padEnd(9)}  ${indicator(status.hasGrounding).padEnd(9)}  ${staleIndicator.padEnd(5)}\n`,
					);
				}

				// Summary
				const total = statuses.length;
				const withExtracted = statuses.filter((s) => s.hasExtracted).length;
				const stale = statuses.filter((s) => s.isStale).length;

				process.stdout.write(`\n${total} sources, ${withExtracted} with extracted fixtures`);
				if (stale > 0) {
					process.stdout.write(`, ${chalk.yellow(`${stale} stale`)}`);
				}
				process.stdout.write('\n');
			}),
		);
}
