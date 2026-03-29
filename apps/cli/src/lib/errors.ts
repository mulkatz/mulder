/**
 * CLI error handler — wraps every command action to provide
 * structured error output and correct exit codes.
 *
 * Exit codes:
 * - 0: success (handled by Commander.js on normal return)
 * - 1: known error (validation, config, pipeline)
 * - 2: unexpected error (bug)
 *
 * @see docs/specs/06_cli_scaffold.spec.md §4.7
 */

import { ConfigValidationError, isMulderError } from '@mulder/core';
import { printError } from './output.js';

/**
 * Wraps a command action function with structured error handling.
 *
 * - `ConfigValidationError` -> prints each issue to stderr, exit 1
 * - `MulderError` -> prints code + message to stderr, exit 1
 * - Unknown error -> prints "Unexpected error:" + message, exit 2
 */
export function withErrorHandler<TArgs extends unknown[]>(
	fn: (...args: TArgs) => Promise<void>,
): (...args: TArgs) => Promise<void> {
	return async (...args: TArgs) => {
		try {
			await fn(...args);
		} catch (error: unknown) {
			if (error instanceof ConfigValidationError) {
				for (const issue of error.issues) {
					printError(`${issue.path}: ${issue.message}`);
				}
				process.exit(1);
			}

			if (isMulderError(error)) {
				printError(`[${error.code}] ${error.message}`);
				process.exit(1);
			}

			const message = error instanceof Error ? error.message : String(error);
			printError(`Unexpected error: ${message}`);
			process.exit(2);
		}
	};
}
