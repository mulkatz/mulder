/**
 * Taxonomy export -- dumps the current taxonomy to a curated YAML format.
 *
 * Loads all taxonomy entries from the database, groups by entity type,
 * sorts within each group (confirmed first, then auto, then rejected;
 * alphabetical within each status), and renders as YAML.
 *
 * @see docs/specs/50_taxonomy_export_curate_merge.spec.md §4.1
 * @see docs/functional-spec.md §6.3
 */

import type { Logger, TaxonomyEntry } from '@mulder/core';
import { createChildLogger, findAllTaxonomyEntriesUnpaginated } from '@mulder/core';
import type pg from 'pg';
import { stringify as yamlStringify } from 'yaml';

// ────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────

export interface ExportOptions {
	pool: pg.Pool;
	typeFilter?: string;
	logger: Logger;
}

export interface ExportResult {
	/** The rendered YAML content. */
	yaml: string;
	totalEntries: number;
	typeBreakdown: Record<string, number>;
}

// ────────────────────────────────────────────────────────────
// Status sort order (confirmed first, auto, rejected last)
// ────────────────────────────────────────────────────────────

const STATUS_ORDER: Record<string, number> = {
	confirmed: 0,
	auto: 1,
	rejected: 2,
};

function statusSortKey(status: string): number {
	return STATUS_ORDER[status] ?? 3;
}

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

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
 * Sorts entries: confirmed first, then auto, then rejected.
 * Within each status, alphabetical by canonicalName.
 */
function sortEntries(entries: TaxonomyEntry[]): TaxonomyEntry[] {
	return [...entries].sort((a, b) => {
		const statusDiff = statusSortKey(a.status) - statusSortKey(b.status);
		if (statusDiff !== 0) return statusDiff;
		return a.canonicalName.localeCompare(b.canonicalName);
	});
}

/**
 * Converts a TaxonomyEntry to the curated YAML entry format.
 */
function toCuratedEntry(entry: TaxonomyEntry): Record<string, unknown> {
	const result: Record<string, unknown> = {
		id: entry.id,
		canonical: entry.canonicalName,
		status: entry.status,
	};

	// Only include category when non-null (keeps YAML clean)
	if (entry.category !== null) {
		result.category = entry.category;
	}

	result.aliases = entry.aliases;

	return result;
}

/**
 * Generates the YAML comment header with timestamp and instructions.
 */
function generateHeader(): string {
	const timestamp = new Date().toISOString();
	return [
		`# Mulder Taxonomy — exported ${timestamp}`,
		'# Edit entries: change status, rename canonicals, add/remove aliases.',
		'# Then run `mulder taxonomy merge` to apply changes.',
		'#',
		'# Status values: confirmed | auto | rejected',
		"# - confirmed: human-verified, bootstrap won't touch these",
		'# - auto: machine-generated, may be replaced by re-bootstrap',
		'# - rejected: hidden from normalization, preserved for reference',
		'',
	].join('\n');
}

// ────────────────────────────────────────────────────────────
// Export
// ────────────────────────────────────────────────────────────

/**
 * Exports taxonomy entries to the curated YAML format.
 *
 * 1. Loads all taxonomy entries via findAllTaxonomyEntriesUnpaginated()
 * 2. Optionally filters by entity type
 * 3. Groups entries by entityType
 * 4. Sorts within each group (confirmed > auto > rejected, then alphabetical)
 * 5. Renders as YAML with comment header
 * 6. Returns the YAML string and stats
 */
export async function exportTaxonomy(options: ExportOptions): Promise<ExportResult> {
	const { pool, typeFilter, logger } = options;
	const exportLogger = createChildLogger(logger, { module: 'taxonomy-export' });

	// Step 1: Load all entries
	let entries = await findAllTaxonomyEntriesUnpaginated(pool);
	exportLogger.debug({ entryCount: entries.length }, 'Loaded taxonomy entries for export');

	// Step 2: Filter by type if specified
	if (typeFilter) {
		entries = entries.filter((e) => e.entityType === typeFilter);
		exportLogger.debug({ typeFilter, filteredCount: entries.length }, 'Filtered by entity type');
	}

	// Step 3: Group by type
	const grouped = groupByType(entries);

	// Step 4: Build the YAML data structure (sorted types, sorted entries)
	const yamlData: Record<string, Array<Record<string, unknown>>> = {};
	const typeBreakdown: Record<string, number> = {};

	const sortedTypes = [...grouped.keys()].sort();

	for (const entityType of sortedTypes) {
		const typeEntries = grouped.get(entityType);
		if (!typeEntries) continue;

		const sorted = sortEntries(typeEntries);
		yamlData[entityType] = sorted.map(toCuratedEntry);
		typeBreakdown[entityType] = sorted.length;
	}

	// Step 5: Render YAML with header
	const header = generateHeader();
	const yamlBody = entries.length > 0 ? yamlStringify(yamlData, { lineWidth: 0 }) : '';
	const yaml = header + yamlBody;

	exportLogger.info({ totalEntries: entries.length, typeCount: sortedTypes.length }, 'Taxonomy export complete');

	return {
		yaml,
		totalEntries: entries.length,
		typeBreakdown,
	};
}
