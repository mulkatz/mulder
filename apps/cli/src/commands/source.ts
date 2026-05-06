import {
	closeAllPools,
	getWorkerPool,
	loadConfig,
	planSourcePurge,
	purgeSource,
	restoreSource,
	softDeleteSource,
} from '@mulder/core';
import type { Command } from 'commander';
import { withErrorHandler } from '../lib/errors.js';
import { printError, printJson, printSuccess } from '../lib/output.js';

interface SourceRollbackOptions {
	reason?: string;
	actor?: string;
	json?: boolean;
}

interface SourceRestoreOptions {
	actor?: string;
	json?: boolean;
}

interface SourcePurgeOptions {
	dryRun?: boolean;
	confirm?: boolean;
	reason?: string;
	actor?: string;
	json?: boolean;
}

function requirePool() {
	const config = loadConfig();
	if (!config.gcp?.cloud_sql) {
		printError('GCP configuration with cloud_sql is required for source rollback commands');
		process.exit(1);
		return null;
	}
	return { config, pool: getWorkerPool(config.gcp.cloud_sql) };
}

function optionReason(reason: string | undefined, required: boolean, commandName: string): string | null {
	const trimmed = reason?.trim() ?? '';
	if (trimmed.length > 0) {
		return trimmed;
	}
	if (required) {
		printError(`${commandName} requires --reason`);
		process.exit(1);
		return null;
	}
	return 'unspecified';
}

function optionActor(actor: string | undefined): string {
	const trimmed = actor?.trim() ?? '';
	return trimmed.length > 0 ? trimmed : 'cli';
}

function printPlan(plan: Awaited<ReturnType<typeof planSourcePurge>>): void {
	process.stdout.write(`Purge plan for source ${plan.sourceId}\n`);
	for (const count of plan.counts) {
		if (count.total === 0) {
			continue;
		}
		process.stdout.write(
			`  ${count.subsystem.padEnd(30)} ${String(count.exclusive).padStart(5)} exclusive  ${String(
				count.shared,
			).padStart(5)} shared\n`,
		);
	}
	process.stdout.write(`Total: ${plan.totalExclusive} exclusive, ${plan.totalShared} shared\n`);
}

export function registerSourceCommands(program: Command): void {
	const source = program.command('source').description('Source rollback, restore, and purge operations');

	source
		.command('rollback')
		.description('Soft-delete a source and start the undo window')
		.argument('<source-id>', 'UUID of the source to soft-delete')
		.option('--reason <reason>', 'Reason for source rollback')
		.option('--actor <id>', 'Actor/user ID recorded in audit log')
		.option('--json', 'Machine-readable JSON output')
		.action(
			withErrorHandler(async (sourceId: string, options: SourceRollbackOptions) => {
				const loaded = requirePool();
				if (!loaded) {
					return;
				}
				const { config, pool } = loaded;
				const reason = optionReason(options.reason, config.source_rollback.require_reason, 'source rollback');
				if (!reason) {
					return;
				}

				try {
					const deletion = await softDeleteSource(pool, {
						sourceId,
						actor: optionActor(options.actor),
						reason,
						undoWindowHours: config.source_rollback.undo_window_hours,
					});
					if (options.json) {
						printJson(deletion);
						return;
					}
					printSuccess(`Source soft-deleted until ${deletion.undoDeadline.toISOString()}`);
				} finally {
					await closeAllPools();
				}
			}),
		);

	source
		.command('restore')
		.description('Restore a soft-deleted source inside the undo window')
		.argument('<source-id>', 'UUID of the source to restore')
		.option('--actor <id>', 'Actor/user ID recorded in audit log')
		.option('--json', 'Machine-readable JSON output')
		.action(
			withErrorHandler(async (sourceId: string, options: SourceRestoreOptions) => {
				const loaded = requirePool();
				if (!loaded) {
					return;
				}
				const { pool } = loaded;
				try {
					const deletion = await restoreSource(pool, {
						sourceId,
						actor: optionActor(options.actor),
					});
					if (options.json) {
						printJson(deletion);
						return;
					}
					printSuccess(`Source restored from deletion ${deletion.id}`);
				} finally {
					await closeAllPools();
				}
			}),
		);

	source
		.command('purge')
		.description('Plan or execute deterministic cascading purge for a soft-deleted source')
		.argument('<source-id>', 'UUID of the source to purge')
		.option('--dry-run', 'Show the purge plan without deleting rows')
		.option('--confirm', 'Confirm irreversible purge execution')
		.option('--reason <reason>', 'Reason for confirmed purge')
		.option('--actor <id>', 'Actor/user ID recorded in audit log')
		.option('--json', 'Machine-readable JSON output')
		.action(
			withErrorHandler(async (sourceId: string, options: SourcePurgeOptions) => {
				const loaded = requirePool();
				if (!loaded) {
					return;
				}
				const { config, pool } = loaded;

				try {
					if (options.dryRun) {
						const plan = await planSourcePurge(pool, sourceId);
						if (options.json) {
							printJson(plan);
							return;
						}
						printPlan(plan);
						return;
					}

					if (config.source_rollback.require_confirmation && !options.confirm) {
						printError('source purge requires --confirm');
						process.exit(1);
						return;
					}
					const reason = optionReason(options.reason, config.source_rollback.require_reason, 'source purge');
					if (!reason) {
						return;
					}

					const report = await purgeSource(pool, {
						sourceId,
						actor: optionActor(options.actor),
						reason,
						confirmed: options.confirm || !config.source_rollback.require_confirmation,
						orphanHandling: config.source_rollback.orphan_handling,
					});
					if (options.json) {
						printJson(report);
						return;
					}
					printSuccess(`Source purged: ${report.effects.storiesDeleted} stories deleted`);
				} finally {
					await closeAllPools();
				}
			}),
		);
}
