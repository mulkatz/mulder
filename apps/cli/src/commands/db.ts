/**
 * CLI commands: `mulder db migrate` and `mulder db status`.
 *
 * Thin wrappers that parse arguments, call database functions from @mulder/core,
 * and format the output. No business logic lives here.
 *
 * @see docs/specs/07_database_client_migration_runner.spec.md §4.4
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeAllPools, getMigrationStatus, getWorkerPool, loadConfig, runMigrations } from '@mulder/core';
import type { Command } from 'commander';
import { withErrorHandler } from '../lib/errors.js';
import { printError, printSuccess } from '../lib/output.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Resolves the path to the core package's migrations directory.
 * In the built CLI, this traces back through the monorepo structure.
 */
function getMigrationsDir(): string {
	// apps/cli/dist/commands/db.js -> packages/core/src/database/migrations
	return resolve(__dirname, '..', '..', '..', '..', 'packages', 'core', 'src', 'database', 'migrations');
}

/**
 * Registers the `db` command group on the given Commander program.
 *
 * Subcommands:
 * - `db migrate` — runs pending database migrations
 * - `db status` — shows migration status table
 */
export function registerDbCommands(program: Command): void {
	const dbCmd = program.command('db').description('Database management');

	dbCmd
		.command('migrate')
		.description('Run pending database migrations')
		.argument('[config-path]', 'path to config file')
		.action(
			withErrorHandler(async (configPath?: string) => {
				const config = loadConfig(configPath);

				if (!config.gcp) {
					printError('GCP configuration is required for database operations');
					process.exit(1);
					return;
				}

				const pool = getWorkerPool(config.gcp.cloud_sql);
				const migrationsDir = getMigrationsDir();

				try {
					const result = await runMigrations(pool, migrationsDir);

					if (result.applied.length === 0) {
						printSuccess(`Database is up to date (${result.skipped.length} migrations already applied)`);
					} else {
						printSuccess(`Applied ${result.applied.length} migration(s), skipped ${result.skipped.length}`);
						for (const filename of result.applied) {
							process.stderr.write(`  + ${filename}\n`);
						}
					}
				} finally {
					await closeAllPools();
				}
			}),
		);

	dbCmd
		.command('status')
		.description('Show database migration status')
		.argument('[config-path]', 'path to config file')
		.action(
			withErrorHandler(async (configPath?: string) => {
				const config = loadConfig(configPath);

				if (!config.gcp) {
					printError('GCP configuration is required for database operations');
					process.exit(1);
					return;
				}

				const pool = getWorkerPool(config.gcp.cloud_sql);
				const migrationsDir = getMigrationsDir();

				try {
					const statuses = await getMigrationStatus(pool, migrationsDir);

					if (statuses.length === 0) {
						printSuccess('No migration files found');
						return;
					}

					// Print table header
					const filenameWidth = Math.max(10, ...statuses.map((s) => s.filename.length));
					const header = `${'Filename'.padEnd(filenameWidth)}  ${'Status'.padEnd(9)}  Applied At`;
					const separator = '-'.repeat(header.length);

					process.stdout.write(`${header}\n`);
					process.stdout.write(`${separator}\n`);

					for (const status of statuses) {
						const statusLabel = status.applied ? 'applied' : 'pending';
						const appliedAt = status.appliedAt ? status.appliedAt.toISOString() : '-';
						process.stdout.write(`${status.filename.padEnd(filenameWidth)}  ${statusLabel.padEnd(9)}  ${appliedAt}\n`);
					}
				} finally {
					await closeAllPools();
				}
			}),
		);
}
