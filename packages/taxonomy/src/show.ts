/**
 * Taxonomy show -- displays the current taxonomy tree, grouped by entity type.
 *
 * Supports text and JSON output formats, with optional type filtering.
 *
 * @see docs/specs/46_taxonomy_bootstrap.spec.md §4.1 (show.ts)
 * @see docs/functional-spec.md §6, §1 (taxonomy show cmd)
 */

import type { Logger, TaxonomyEntry, TaxonomyFilter } from '@mulder/core';
import { createChildLogger, findAllTaxonomyEntries } from '@mulder/core';
import type pg from 'pg';

// ────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────

export interface ShowOptions {
	pool: pg.Pool;
	typeFilter?: string;
	json?: boolean;
	logger: Logger;
}

interface TaxonomyTreeNode {
	entityType: string;
	entries: Array<{
		canonicalName: string;
		status: string;
		aliasCount: number;
		aliases: string[];
	}>;
}

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

/**
 * Loads all taxonomy entries, paginating internally to avoid the default 100 limit.
 */
async function loadAllTaxonomyEntries(pool: pg.Pool, filter?: TaxonomyFilter): Promise<TaxonomyEntry[]> {
	const allEntries: TaxonomyEntry[] = [];
	const pageSize = 1000;
	let offset = 0;

	let batch = await findAllTaxonomyEntries(pool, { ...filter, limit: pageSize, offset });
	while (batch.length > 0) {
		allEntries.push(...batch);
		offset += pageSize;
		batch = await findAllTaxonomyEntries(pool, { ...filter, limit: pageSize, offset });
	}

	return allEntries;
}

/**
 * Groups taxonomy entries by entityType.
 */
function groupByType(entries: TaxonomyEntry[]): Map<string, TaxonomyEntry[]> {
	const groups = new Map<string, TaxonomyEntry[]>();

	for (const entry of entries) {
		const existing = groups.get(entry.entityType);
		if (existing) {
			existing.push(entry);
		} else {
			groups.set(entry.entityType, [entry]);
		}
	}

	return groups;
}

/**
 * Status indicator for display.
 */
function statusIndicator(status: string): string {
	switch (status) {
		case 'confirmed':
			return '[confirmed]';
		case 'auto':
			return '[auto]';
		case 'rejected':
			return '[rejected]';
		default:
			return `[${status}]`;
	}
}

// ────────────────────────────────────────────────────────────
// Show
// ────────────────────────────────────────────────────────────

/**
 * Displays the current taxonomy tree.
 *
 * - Loads all taxonomy entries (optionally filtered by type)
 * - Groups by entity type
 * - Outputs as structured JSON or formatted text tree
 */
export async function showTaxonomy(options: ShowOptions): Promise<void> {
	const { pool, typeFilter, json, logger } = options;
	const showLogger = createChildLogger(logger, { module: 'taxonomy-show' });

	const filter: TaxonomyFilter = {};
	if (typeFilter) {
		filter.entityType = typeFilter;
	}

	const entries = await loadAllTaxonomyEntries(pool, filter);
	showLogger.debug({ entryCount: entries.length, typeFilter }, 'Loaded taxonomy entries for display');

	if (entries.length === 0) {
		if (json) {
			process.stdout.write('{}\n');
		} else {
			process.stdout.write('No taxonomy entries found.\n');
		}
		return;
	}

	const grouped = groupByType(entries);

	if (json) {
		// JSON output: grouped by type
		const output: Record<string, TaxonomyTreeNode> = {};

		for (const [entityType, typeEntries] of grouped) {
			output[entityType] = {
				entityType,
				entries: typeEntries.map((e) => ({
					canonicalName: e.canonicalName,
					status: e.status,
					aliasCount: e.aliases.length,
					aliases: e.aliases,
				})),
			};
		}

		process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
		return;
	}

	// Text tree output
	const sortedTypes = [...grouped.keys()].sort();

	for (const entityType of sortedTypes) {
		const typeEntries = grouped.get(entityType);
		if (!typeEntries) continue;

		process.stdout.write(`\n${entityType} (${typeEntries.length} entries)\n`);
		process.stdout.write(`${'─'.repeat(entityType.length + String(typeEntries.length).length + 11)}\n`);

		for (const entry of typeEntries) {
			const indicator = statusIndicator(entry.status);
			const aliasInfo =
				entry.aliases.length > 0
					? ` (${entry.aliases.length} aliases: ${entry.aliases.slice(0, 3).join(', ')}${entry.aliases.length > 3 ? ', ...' : ''})`
					: '';

			process.stdout.write(`  ${indicator} ${entry.canonicalName}${aliasInfo}\n`);
		}
	}

	process.stdout.write('\n');
}
