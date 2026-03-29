/**
 * CLI output formatting utilities.
 *
 * All user-facing output goes through these functions:
 * - Data (JSON, YAML) goes to stdout (pipeable)
 * - Status messages (success, error) go to stderr (visible to user, not piped)
 *
 * @see docs/specs/06_cli_scaffold.spec.md §4.6
 */

import chalk from 'chalk';
import { stringify as yamlStringify } from 'yaml';

/**
 * Print data to stdout in pretty-printed JSON format.
 * Uses 2-space indent for readability.
 */
export function printJson(data: unknown): void {
	process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

/**
 * Print data to stdout in YAML format.
 */
export function printYaml(data: unknown): void {
	process.stdout.write(yamlStringify(data));
}

/**
 * Print a success message to stderr with a green checkmark.
 */
export function printSuccess(message: string): void {
	process.stderr.write(`${chalk.green('\u2714')} ${message}\n`);
}

/**
 * Print an error message to stderr with a red cross.
 */
export function printError(message: string): void {
	process.stderr.write(`${chalk.red('\u2718')} ${message}\n`);
}
