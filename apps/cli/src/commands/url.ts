/**
 * CLI command: `mulder url status | refetch`.
 *
 * Thin URL lifecycle surface over the pipeline URL lifecycle module.
 *
 * @see docs/specs/94_url_lifecycle_refetch.spec.md
 */

import { closeAllPools, createLogger, createServiceRegistry, getWorkerPool, loadConfig } from '@mulder/core';
import { getUrlLifecycleStatus, refetchUrlSource } from '@mulder/pipeline';
import type { Command } from 'commander';
import { withErrorHandler } from '../lib/errors.js';
import { printError, printJson, printSuccess } from '../lib/output.js';

interface UrlStatusOptions {
	json?: boolean;
}

interface UrlRefetchOptions {
	dryRun?: boolean;
	force?: boolean;
	json?: boolean;
}

function formatDate(value: Date | null | undefined): string {
	return value ? value.toISOString() : '-';
}

function writeStatus(result: Awaited<ReturnType<typeof getUrlLifecycleStatus>>): void {
	const { source, lifecycle, host } = result;
	const rows = [
		['Source ID', source.id],
		['Original URL', lifecycle.originalUrl],
		['Final URL', lifecycle.finalUrl],
		['Host', lifecycle.host],
		['HTTP status', lifecycle.lastHttpStatus?.toString() ?? '-'],
		['ETag', lifecycle.etag ?? '-'],
		['Last-Modified', lifecycle.lastModified ?? '-'],
		['Last fetched', formatDate(lifecycle.lastFetchedAt)],
		['Last checked', formatDate(lifecycle.lastCheckedAt)],
		['Next fetch after', formatDate(lifecycle.nextFetchAfter)],
		['Robots allowed', lifecycle.robotsAllowed ? 'yes' : 'no'],
		['Robots URL', lifecycle.robotsUrl ?? '-'],
		['Matched robots rule', lifecycle.robotsMatchedRule ?? '-'],
		['Fetch count', lifecycle.fetchCount.toString()],
		['Unchanged count', lifecycle.unchangedCount.toString()],
		['Changed count', lifecycle.changedCount.toString()],
		['Content hash', lifecycle.lastContentHash],
		['Storage path', lifecycle.lastSnapshotStoragePath],
		['Rendering', lifecycle.renderingMethod ?? '-'],
		['Host next allowed', formatDate(host?.nextAllowedAt)],
	];

	for (const [label, value] of rows) {
		process.stdout.write(`${label.padEnd(22)} ${value}\n`);
	}
}

function writeRefetch(result: Awaited<ReturnType<typeof refetchUrlSource>>): void {
	const mode = result.dryRun ? 'dry-run ' : '';
	process.stdout.write(`Source ID             ${result.sourceId}\n`);
	process.stdout.write(`Result                ${mode}${result.status}\n`);
	process.stdout.write(`HTTP status           ${result.httpStatus}\n`);
	process.stdout.write(`Original URL          ${result.originalUrl}\n`);
	process.stdout.write(`Final URL             ${result.finalUrl}\n`);
	process.stdout.write(`Not modified          ${result.notModified ? 'yes' : 'no'}\n`);
	process.stdout.write(`Previous hash         ${result.previousHash}\n`);
	process.stdout.write(`Current hash          ${result.currentHash}\n`);
	process.stdout.write(`Storage path          ${result.storagePath}\n`);
	process.stdout.write(`Rendering             ${result.renderingMethod ?? '-'}\n`);
	process.stdout.write(`Checked at            ${result.checkedAt}\n`);
}

function requireWorkerPoolContext(commandName: string): ReturnType<typeof getWorkerPool> {
	const config = loadConfig();
	if (!config.gcp && !config.dev_mode) {
		printError(`GCP configuration is required for ${commandName} (or enable dev_mode)`);
		process.exit(1);
	}
	if (!config.gcp) {
		printError(`GCP configuration with cloud_sql is required for ${commandName}`);
		process.exit(1);
	}
	return getWorkerPool(config.gcp.cloud_sql);
}

export function registerUrlCommands(program: Command): void {
	const url = program.command('url').description('Inspect and refresh URL source lifecycle state');

	url
		.command('status')
		.description('Show lifecycle state for one URL source')
		.argument('<source-id>', 'UUID of the URL source')
		.option('--json', 'print machine-readable JSON')
		.action(
			withErrorHandler(async (sourceId: string, options: UrlStatusOptions) => {
				const pool = requireWorkerPoolContext('url status');
				try {
					const result = await getUrlLifecycleStatus(pool, sourceId);
					if (options.json) {
						printJson(result);
						return;
					}
					writeStatus(result);
				} finally {
					await closeAllPools();
				}
			}),
		);

	url
		.command('refetch')
		.description('Re-fetch one existing URL source')
		.argument('<source-id>', 'UUID of the URL source')
		.option('--dry-run', 'check freshness without writing database or storage changes')
		.option('--force', 'skip conditional request headers while still respecting safety and robots')
		.option('--json', 'print machine-readable JSON')
		.action(
			withErrorHandler(async (sourceId: string, options: UrlRefetchOptions) => {
				const config = loadConfig();
				if (!config.gcp && !config.dev_mode) {
					printError('GCP configuration is required for url refetch (or enable dev_mode)');
					process.exit(1);
					return;
				}
				if (!config.gcp) {
					printError('GCP configuration with cloud_sql is required for url refetch');
					process.exit(1);
					return;
				}

				const logger = createLogger();
				const services = createServiceRegistry(config, logger);
				const pool = getWorkerPool(config.gcp.cloud_sql);
				try {
					const result = await refetchUrlSource(
						{
							sourceId,
							dryRun: options.dryRun ?? false,
							force: options.force ?? false,
						},
						config,
						services,
						pool,
						logger,
					);
					if (options.json) {
						printJson(result);
						return;
					}
					writeRefetch(result);
					printSuccess(`URL re-fetch ${result.status}${result.dryRun ? ' (dry-run)' : ''}`);
				} finally {
					await closeAllPools();
				}
			}),
		);
}
