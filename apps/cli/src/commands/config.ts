/**
 * CLI commands: `mulder config validate`, `mulder config show`,
 * and `mulder config schema`.
 *
 * Thin wrappers that parse arguments, call loadConfig() from @mulder/core,
 * and format the output. No business logic lives here.
 *
 * @see docs/specs/06_cli_scaffold.spec.md §4.5
 * @see docs/specs/26_json_schema_generator.spec.md §4.3
 */

import { loadConfig } from '@mulder/core';
import { generateExtractionSchema } from '@mulder/pipeline';
import type { Command } from 'commander';
import { withErrorHandler } from '../lib/errors.js';
import { printJson, printSuccess, printYaml } from '../lib/output.js';

interface ConfigCommandOptions {
	config?: string;
	format?: string;
	json?: boolean;
}

/**
 * Registers the `config` command group on the given Commander program.
 *
 * Subcommands:
 * - `config validate [path]` — validates mulder.config.yaml against Zod schema
 * - `config show [path]` — prints resolved config with defaults applied
 * - `config schema [path]` — prints generated JSON Schema for entity extraction
 */
export function registerConfigCommands(program: Command): void {
	const configCmd = program.command('config').description('Manage mulder configuration');

	configCmd
		.command('validate')
		.description('Validate mulder.config.yaml against Zod schema')
		.argument('[path]', 'path to config file')
		.option('--config <path>', 'path to config file')
		.option('--json', 'output validation result in JSON format')
		.action(
			withErrorHandler(async (path?: string, options?: ConfigCommandOptions) => {
				const config = loadConfig(options?.config ?? path);

				if (options?.json) {
					printJson({ valid: true, project: config.project.name });
					return;
				}

				printSuccess(`Config valid. Project: ${config.project.name}`);
			}),
		);

	configCmd
		.command('show')
		.description('Print resolved config with defaults applied')
		.argument('[path]', 'path to config file')
		.option('--config <path>', 'path to config file')
		.option('--format <format>', 'output format: json or yaml', 'json')
		.action(
			withErrorHandler(async (path?: string, options?: ConfigCommandOptions) => {
				const config = loadConfig(options?.config ?? path);

				if (options?.format === 'yaml') {
					printYaml(config);
					return;
				}

				printJson(config);
			}),
		);

	configCmd
		.command('schema')
		.description('Print generated JSON Schema for entity extraction structured output')
		.argument('[path]', 'path to config file')
		.option('--config <path>', 'path to config file')
		.option('--json', 'output as formatted JSON (default behavior, explicit for scripting)')
		.action(
			withErrorHandler(async (path?: string, options?: ConfigCommandOptions) => {
				const config = loadConfig(options?.config ?? path);
				const schema = generateExtractionSchema(config.ontology, {
					assertionClassificationEnabled: config.enrichment.assertion_classification.enabled,
				});
				printJson(schema);
			}),
		);
}
