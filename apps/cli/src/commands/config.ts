/**
 * CLI commands: `mulder config validate` and `mulder config show`.
 *
 * Thin wrappers that parse arguments, call loadConfig() from @mulder/core,
 * and format the output. No business logic lives here.
 *
 * @see docs/specs/06_cli_scaffold.spec.md §4.5
 */

import { loadConfig } from '@mulder/core';
import type { Command } from 'commander';
import { withErrorHandler } from '../lib/errors.js';
import { printJson, printSuccess, printYaml } from '../lib/output.js';

/**
 * Registers the `config` command group on the given Commander program.
 *
 * Subcommands:
 * - `config validate [path]` — validates mulder.config.yaml against Zod schema
 * - `config show [path]` — prints resolved config with defaults applied
 */
export function registerConfigCommands(program: Command): void {
	const configCmd = program.command('config').description('Manage mulder configuration');

	configCmd
		.command('validate')
		.description('Validate mulder.config.yaml against Zod schema')
		.argument('[path]', 'path to config file')
		.option('--json', 'output validation result in JSON format')
		.action(
			withErrorHandler(async (path?: string, options?: { json?: boolean }) => {
				const config = loadConfig(path);

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
		.option('--format <format>', 'output format: json or yaml', 'json')
		.action(
			withErrorHandler(async (path?: string, options?: { format?: string }) => {
				const config = loadConfig(path);

				if (options?.format === 'yaml') {
					printYaml(config);
					return;
				}

				printJson(config);
			}),
		);
}
