/**
 * CLI command: `mulder eval`.
 *
 * Thin wrapper around the public `@mulder/eval` package. It validates the CLI
 * selectors, delegates execution/comparison/baseline updates to the shared
 * helper, and prints either JSON or a human-readable report.
 */

import type { Command } from 'commander';
import { withErrorHandler } from '../lib/errors.js';
import { type EvalCommandOptions, renderEvalCommand, runEvalCommand } from '../lib/eval.js';
import { printJson } from '../lib/output.js';

export function registerEvalCommands(program: Command): void {
	program
		.command('eval')
		.description('Evaluate checked-in fixture suites against golden annotations')
		.option('--step <step>', 'Evaluate a specific step only')
		.option('--compare <mode>', 'Compare against a saved baseline')
		.option('--update-baseline', 'Rewrite the baseline with the current results')
		.option('--json', 'Emit machine-readable JSON')
		.action(
			withErrorHandler(async (options: EvalCommandOptions) => {
				const result = runEvalCommand(options);

				if (options.json) {
					printJson(result);
					return;
				}

				process.stdout.write(renderEvalCommand(result));
			}),
		);
}
