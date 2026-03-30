#!/usr/bin/env node

/**
 * Mulder CLI — entry point.
 *
 * Creates the Commander program and registers command groups.
 * Each command group lives in its own file under ./commands/.
 *
 * @see docs/specs/06_cli_scaffold.spec.md §4.4
 */

import { Command } from 'commander';
import { registerConfigCommands } from './commands/config.js';
import { registerDbCommands } from './commands/db.js';

const program = new Command()
	.name('mulder')
	.description('Config-driven Document Intelligence Platform')
	.version('0.0.0');

registerConfigCommands(program);
registerDbCommands(program);

program.parse();
