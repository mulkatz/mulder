/**
 * CLI command group: `mulder worker start | status | reap`.
 *
 * Thin wrapper around the worker runtime. It parses CLI flags, loads config,
 * creates the shared service registry and worker pool, and delegates all
 * queue behavior to `@mulder/worker`.
 *
 * @see docs/specs/68_worker_loop.spec.md §4.1
 * @see docs/functional-spec.md §1 (worker cmd), §10.3, §10.4, §10.5
 */

import { closeAllPools, createLogger, createServiceRegistry, getWorkerPool, loadConfig } from '@mulder/core';
import {
	createWorkerId,
	getWorkerStatus,
	reapStaleJobs,
	startWorker,
	WORKER_ERROR_CODES,
	WorkerError,
	type WorkerRuntimeOptions,
	type WorkerStartCliOptions,
	type WorkerStatusSnapshot,
} from '@mulder/worker';
import chalk from 'chalk';
import type { Command } from 'commander';
import { withErrorHandler } from '../lib/errors.js';
import { printError, printSuccess } from '../lib/output.js';

const DEFAULT_CONCURRENCY = 1;
const DEFAULT_POLL_INTERVAL_MS = 5_000;

function parsePositiveInteger(value: string | undefined, optionName: string, fallback: number): number {
	if (value === undefined) {
		return fallback;
	}

	const parsed = Number.parseInt(value, 10);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		throw new WorkerError(`--${optionName} must be a positive integer`, WORKER_ERROR_CODES.WORKER_INVALID_OPTION, {
			context: { option: optionName, value },
		});
	}

	return parsed;
}

function shortId(id: string): string {
	return id.slice(0, 8);
}

function formatTimestamp(value: Date | null): string {
	return value ? value.toISOString() : '-';
}

function printQueueStatus(snapshot: WorkerStatusSnapshot): void {
	process.stdout.write(`\n${chalk.bold('Queue')}\n`);
	process.stdout.write(`  Pending      ${snapshot.queue.pending}\n`);
	process.stdout.write(`  Running      ${snapshot.queue.running}\n`);
	process.stdout.write(`  Completed    ${snapshot.queue.completed}\n`);
	process.stdout.write(`  Failed       ${snapshot.queue.failed}\n`);
	process.stdout.write(`  Dead letter  ${snapshot.queue.deadLetter}\n`);
	process.stdout.write(`  Total        ${snapshot.queue.total}\n`);

	process.stdout.write(`\n${chalk.bold('Active workers')}\n`);
	if (snapshot.activeWorkers.length === 0) {
		process.stdout.write('  none\n');
	} else {
		for (const worker of snapshot.activeWorkers) {
			process.stdout.write(`  ${worker.workerId} (${worker.jobCount})\n`);
			for (const job of worker.jobs) {
				process.stdout.write(
					`    ${shortId(job.id)}  ${job.type.padEnd(20)}  attempts=${String(job.attempts)}  started=${formatTimestamp(job.startedAt)}\n`,
				);
			}
		}
	}

	process.stdout.write(`\n${chalk.bold('Running jobs')}\n`);
	if (snapshot.runningJobs.length === 0) {
		process.stdout.write('  none\n');
		return;
	}

	const header = `${'Job ID'.padEnd(12)}  ${'Type'.padEnd(22)}  ${'Worker'.padEnd(28)}  ${'Attempts'.padEnd(8)}  Started`;
	const separator = '-'.repeat(header.length);
	process.stdout.write(`  ${header}\n`);
	process.stdout.write(`  ${separator}\n`);
	for (const job of snapshot.runningJobs) {
		process.stdout.write(
			`  ${shortId(job.id).padEnd(12)}  ${job.type.padEnd(22)}  ${(job.workerId ?? '-').padEnd(28)}  ${String(job.attempts).padEnd(8)}  ${formatTimestamp(job.startedAt)}\n`,
		);
	}
}

function printReapSummary(result: { count: number; jobIds: string[]; staleBefore: Date }): void {
	if (result.count === 0) {
		printSuccess('No stale running jobs found');
		return;
	}

	printSuccess(`Reaped ${result.count} stale running job(s)`);
	process.stdout.write(`Stale before: ${result.staleBefore.toISOString()}\n`);
	for (const jobId of result.jobIds) {
		process.stdout.write(`  ${jobId}\n`);
	}
}

function createAbortController(): { controller: AbortController; cleanup: () => void } {
	const controller = new AbortController();
	const stop = (): void => {
		controller.abort();
	};
	process.once('SIGINT', stop);
	process.once('SIGTERM', stop);
	return {
		controller,
		cleanup: () => {
			process.off('SIGINT', stop);
			process.off('SIGTERM', stop);
		},
	};
}

async function loadWorkerContext(configPath?: string) {
	const config = loadConfig(configPath);

	if (!config.gcp) {
		printError('GCP configuration with cloud_sql is required for worker commands');
		process.exit(1);
		return null;
	}

	const logger = createLogger();
	const services = createServiceRegistry(config, logger);
	const pool = getWorkerPool(config.gcp.cloud_sql);

	return {
		config,
		logger,
		services,
		pool,
	};
}

// ────────────────────────────────────────────────────────────
// Command registration
// ────────────────────────────────────────────────────────────

export function registerWorkerCommands(program: Command): void {
	const worker = program.command('worker').description('Background job worker — start, inspect, and reap jobs');

	worker
		.command('start')
		.description('Start the background worker loop')
		.option('--concurrency <n>', 'maximum parallel jobs (default: 1)')
		.option('--poll-interval <ms>', 'polling interval in milliseconds (default: 5000)')
		.action(
			withErrorHandler(async (options: WorkerStartCliOptions) => {
				const ctx = await loadWorkerContext();
				if (!ctx) return;

				const concurrency = parsePositiveInteger(options.concurrency, 'concurrency', DEFAULT_CONCURRENCY);
				const pollIntervalMs = parsePositiveInteger(options.pollInterval, 'poll-interval', DEFAULT_POLL_INTERVAL_MS);
				const workerId = createWorkerId();
				const { controller, cleanup } = createAbortController();

				try {
					const runtimeOptions: WorkerRuntimeOptions = {
						concurrency,
						pollIntervalMs,
						workerId,
						abortSignal: controller.signal,
					};
					const result = await startWorker(
						{
							config: ctx.config,
							services: ctx.services,
							pool: ctx.pool,
							logger: ctx.logger,
						},
						runtimeOptions,
					);
					printSuccess(
						`Worker stopped cleanly (${result.processedCount} processed, ${result.failedCount} failed, ${result.idlePollCount} idle polls)`,
					);
				} finally {
					cleanup();
					await closeAllPools();
				}
			}),
		);

	worker
		.command('status')
		.description('Show pending and running queue state')
		.action(
			withErrorHandler(async () => {
				const ctx = await loadWorkerContext();
				if (!ctx) return;

				try {
					const snapshot = await getWorkerStatus(ctx.pool);
					printQueueStatus(snapshot);
				} finally {
					await closeAllPools();
				}
			}),
		);

	worker
		.command('reap')
		.description('Reset stale running jobs back to pending')
		.action(
			withErrorHandler(async () => {
				const ctx = await loadWorkerContext();
				if (!ctx) return;

				try {
					const result = await reapStaleJobs(ctx.pool);
					printReapSummary(result);
				} finally {
					await closeAllPools();
				}
			}),
		);
}
