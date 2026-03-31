/**
 * CLI commands: `mulder cache clear` and `mulder cache stats`.
 *
 * Manages the dev-mode LLM response cache (.mulder-cache.db).
 * The cache stores request-hash to response mappings to eliminate
 * redundant Vertex AI calls during prompt iteration.
 *
 * @see docs/specs/17_vertex_ai_wrapper_dev_cache.spec.md §4.2
 * @see docs/functional-spec.md §4.8
 */

import { createLlmCache, createLogger } from '@mulder/core';
import type { Command } from 'commander';
import { withErrorHandler } from '../lib/errors.js';
import { printSuccess } from '../lib/output.js';

/** Default path for the LLM cache database. */
const DEFAULT_CACHE_DB_PATH = '.mulder-cache.db';

/**
 * Formats byte size into a human-readable string (KB, MB, etc.).
 */
function formatBytes(bytes: number): string {
	if (bytes === 0) return '0 B';
	const units = ['B', 'KB', 'MB', 'GB'];
	const k = 1024;
	const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), units.length - 1);
	const value = bytes / k ** i;
	return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * Registers the `cache` command group on the given Commander program.
 *
 * Usage:
 * ```
 * mulder cache clear    Remove all cached LLM responses
 * mulder cache stats    Show cache statistics
 * ```
 */
export function registerCacheCommands(program: Command): void {
	const cacheCmd = program.command('cache').description('Manage the dev-mode LLM response cache');

	cacheCmd
		.command('clear')
		.description('Remove all cached LLM responses')
		.action(
			withErrorHandler(async () => {
				const logger = createLogger();
				const cache = createLlmCache(DEFAULT_CACHE_DB_PATH, logger);

				try {
					const count = cache.clear();
					printSuccess(`Cleared ${count} cache entries`);
				} finally {
					cache.close();
				}
			}),
		);

	cacheCmd
		.command('stats')
		.description('Show cache statistics (entries, tokens saved, size)')
		.action(
			withErrorHandler(async () => {
				const logger = createLogger();
				const cache = createLlmCache(DEFAULT_CACHE_DB_PATH, logger);

				try {
					const stats = cache.stats();
					process.stdout.write(`Entries:       ${stats.entries}\n`);
					process.stdout.write(`Tokens saved:  ${stats.totalTokensSaved.toLocaleString()}\n`);
					process.stdout.write(`Database size: ${formatBytes(stats.dbSizeBytes)}\n`);
				} finally {
					cache.close();
				}
			}),
		);
}
