/**
 * Taxonomy merge -- applies curated YAML changes back into the taxonomy table.
 *
 * Parses and validates the curated YAML, diffs against current database state,
 * and applies creates/updates/deletes in a single transaction.
 *
 * @see docs/specs/50_taxonomy_export_curate_merge.spec.md §4.1
 * @see docs/functional-spec.md §6.3
 */

import type {
	ApplyTaxonomyChangesInput,
	CreateTaxonomyEntryInput,
	Logger,
	TaxonomyEntry,
	UpdateTaxonomyEntryInput,
} from '@mulder/core';
import {
	applyTaxonomyChanges,
	createChildLogger,
	findAllTaxonomyEntriesUnpaginated,
	TAXONOMY_ERROR_CODES,
	TaxonomyError,
} from '@mulder/core';
import type pg from 'pg';
import { parse as yamlParse } from 'yaml';
import { ZodError } from 'zod';
import type { CuratedEntry } from './curated-schema.js';
import { CuratedTaxonomySchema } from './curated-schema.js';

// ────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────

export interface MergeOptions {
	pool: pg.Pool;
	/** Raw YAML string to merge. */
	yamlContent: string;
	dryRun?: boolean;
	logger: Logger;
}

export interface MergeChange {
	action: 'created' | 'updated' | 'deleted' | 'unchanged';
	entityType: string;
	canonicalName: string;
	id?: string;
	details?: string;
}

export interface MergeResult {
	created: number;
	updated: number;
	deleted: number;
	unchanged: number;
	changes: MergeChange[];
	errors: string[];
}

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

/**
 * Builds a composite key for duplicate detection within the YAML file.
 */
function entryKey(canonical: string, entityType: string): string {
	return `${entityType}::${canonical}`;
}

/**
 * Checks if two string arrays have the same elements (order-insensitive).
 */
function aliasesEqual(a: string[], b: string[]): boolean {
	if (a.length !== b.length) return false;
	const sorted1 = [...a].sort();
	const sorted2 = [...b].sort();
	return sorted1.every((val, idx) => val === sorted2[idx]);
}

/**
 * Computes the diff details between a curated YAML entry and a database entry.
 * Returns null if unchanged.
 */
function computeDiff(
	curatedEntry: CuratedEntry,
	dbEntry: TaxonomyEntry,
): { input: UpdateTaxonomyEntryInput; details: string } | null {
	const diffs: string[] = [];
	const input: UpdateTaxonomyEntryInput = {};

	// Canonical name change (rename)
	if (curatedEntry.canonical !== dbEntry.canonicalName) {
		input.canonicalName = curatedEntry.canonical;
		diffs.push(`canonical: "${dbEntry.canonicalName}" -> "${curatedEntry.canonical}"`);
	}

	// Status change
	if (curatedEntry.status !== dbEntry.status) {
		input.status = curatedEntry.status;
		diffs.push(`status: ${dbEntry.status} -> ${curatedEntry.status}`);
	}

	// Category change
	const curatedCategory = curatedEntry.category ?? null;
	if (curatedCategory !== dbEntry.category) {
		input.category = curatedCategory;
		diffs.push(`category: "${dbEntry.category ?? ''}" -> "${curatedCategory ?? ''}"`);
	}

	// Aliases change (full replacement, not additive)
	if (!aliasesEqual(curatedEntry.aliases, dbEntry.aliases)) {
		input.aliases = curatedEntry.aliases;
		diffs.push(`aliases: [${dbEntry.aliases.join(', ')}] -> [${curatedEntry.aliases.join(', ')}]`);
	}

	if (diffs.length === 0) {
		return null;
	}

	return { input, details: diffs.join('; ') };
}

// ────────────────────────────────────────────────────────────
// Merge
// ────────────────────────────────────────────────────────────

/**
 * Merges curated YAML changes into the taxonomy database.
 *
 * Flow:
 * 1. Parse YAML, validate against CuratedTaxonomySchema
 * 2. Check for duplicate (canonical, entityType) pairs in the YAML
 * 3. Load all current taxonomy entries from database
 * 4. Build lookup maps (byId, byNameType)
 * 5. Diff: for each YAML entry, determine create/update/unchanged
 * 6. Deletion detection: DB entries for types in YAML but missing from YAML
 * 7. If dryRun, return changes without applying
 * 8. Apply all writes in a single transaction
 */
export async function mergeTaxonomy(options: MergeOptions): Promise<MergeResult> {
	const { pool, yamlContent, dryRun, logger } = options;
	const mergeLogger = createChildLogger(logger, { module: 'taxonomy-merge' });

	// Step 1: Parse YAML
	let parsed: unknown;
	try {
		parsed = yamlParse(yamlContent);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		throw new TaxonomyError(
			`Invalid YAML in curated taxonomy file: ${message}`,
			TAXONOMY_ERROR_CODES.TAXONOMY_VALIDATION_FAILED,
			{ context: { parseError: message } },
		);
	}

	// Handle empty YAML (null/undefined)
	if (parsed === null || parsed === undefined) {
		parsed = {};
	}

	// Validate against schema
	let curated: Record<string, CuratedEntry[]>;
	try {
		curated = CuratedTaxonomySchema.parse(parsed);
	} catch (error: unknown) {
		if (error instanceof ZodError) {
			const issues = error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
			throw new TaxonomyError(
				`Curated taxonomy validation failed: ${issues}`,
				TAXONOMY_ERROR_CODES.TAXONOMY_VALIDATION_FAILED,
				{ context: { issues: error.issues } },
			);
		}
		throw error;
	}

	// Step 2: Check for duplicates within YAML
	const seen = new Set<string>();
	for (const [entityType, entries] of Object.entries(curated)) {
		for (const entry of entries) {
			const key = entryKey(entry.canonical, entityType);
			if (seen.has(key)) {
				throw new TaxonomyError(
					`Duplicate entry in curated taxonomy: "${entry.canonical}" of type "${entityType}"`,
					TAXONOMY_ERROR_CODES.TAXONOMY_DUPLICATE_ENTRY,
					{ context: { canonical: entry.canonical, entityType } },
				);
			}
			seen.add(key);
		}
	}

	// Step 3: Load all current entries from database
	const dbEntries = await findAllTaxonomyEntriesUnpaginated(pool);
	mergeLogger.debug({ dbEntryCount: dbEntries.length }, 'Loaded current taxonomy entries');

	// Step 4: Build lookup maps
	const byId = new Map<string, TaxonomyEntry>();
	const byNameType = new Map<string, TaxonomyEntry>();
	for (const entry of dbEntries) {
		byId.set(entry.id, entry);
		byNameType.set(entryKey(entry.canonicalName, entry.entityType), entry);
	}

	// Step 5: Process each YAML entry
	const changes: MergeChange[] = [];
	const errors: string[] = [];

	const creates: CreateTaxonomyEntryInput[] = [];
	const updates: Array<{ id: string; input: UpdateTaxonomyEntryInput }> = [];
	const processedDbIds = new Set<string>();

	// Track which entity types appear in the YAML (for deletion detection)
	const yamlEntityTypes = new Set(Object.keys(curated));

	for (const [entityType, entries] of Object.entries(curated)) {
		for (const curatedEntry of entries) {
			if (curatedEntry.id) {
				// Has ID: look up by ID
				const dbEntry = byId.get(curatedEntry.id);
				if (!dbEntry) {
					errors.push(
						`Entry with ID "${curatedEntry.id}" (${curatedEntry.canonical}) not found in database — skipping`,
					);
					changes.push({
						action: 'unchanged',
						entityType,
						canonicalName: curatedEntry.canonical,
						id: curatedEntry.id,
						details: 'ID not found in database (skipped)',
					});
					continue;
				}

				processedDbIds.add(dbEntry.id);

				const diff = computeDiff(curatedEntry, dbEntry);
				if (diff) {
					updates.push({ id: dbEntry.id, input: diff.input });
					changes.push({
						action: 'updated',
						entityType,
						canonicalName: curatedEntry.canonical,
						id: dbEntry.id,
						details: diff.details,
					});
				} else {
					changes.push({
						action: 'unchanged',
						entityType,
						canonicalName: curatedEntry.canonical,
						id: dbEntry.id,
					});
				}
			} else {
				// No ID: look up by (canonical, entityType)
				const key = entryKey(curatedEntry.canonical, entityType);
				const dbEntry = byNameType.get(key);

				if (dbEntry) {
					processedDbIds.add(dbEntry.id);

					const diff = computeDiff(curatedEntry, dbEntry);
					if (diff) {
						updates.push({ id: dbEntry.id, input: diff.input });
						changes.push({
							action: 'updated',
							entityType,
							canonicalName: curatedEntry.canonical,
							id: dbEntry.id,
							details: diff.details,
						});
					} else {
						changes.push({
							action: 'unchanged',
							entityType,
							canonicalName: curatedEntry.canonical,
							id: dbEntry.id,
						});
					}
				} else {
					// New entry
					creates.push({
						canonicalName: curatedEntry.canonical,
						entityType,
						status: curatedEntry.status,
						category: curatedEntry.category,
						aliases: curatedEntry.aliases,
					});
					changes.push({
						action: 'created',
						entityType,
						canonicalName: curatedEntry.canonical,
						details: `new entry (status: ${curatedEntry.status})`,
					});
				}
			}
		}
	}

	// Step 6: Deletion detection
	// Only delete entries whose entityType appears in the YAML
	const deletes: string[] = [];
	for (const dbEntry of dbEntries) {
		if (yamlEntityTypes.has(dbEntry.entityType) && !processedDbIds.has(dbEntry.id)) {
			deletes.push(dbEntry.id);
			changes.push({
				action: 'deleted',
				entityType: dbEntry.entityType,
				canonicalName: dbEntry.canonicalName,
				id: dbEntry.id,
				details: 'removed from curated YAML',
			});
		}
	}

	// Compute summary
	const result: MergeResult = {
		created: creates.length,
		updated: updates.length,
		deleted: deletes.length,
		unchanged: changes.filter((c) => c.action === 'unchanged').length,
		changes,
		errors,
	};

	mergeLogger.info(
		{
			created: result.created,
			updated: result.updated,
			deleted: result.deleted,
			unchanged: result.unchanged,
			errors: errors.length,
		},
		'Merge diff computed',
	);

	// Step 7: If dry-run, return without applying
	if (dryRun) {
		mergeLogger.info('Dry-run mode — no changes applied');
		return result;
	}

	// Step 8: Apply all writes in a single transaction
	if (creates.length > 0 || updates.length > 0 || deletes.length > 0) {
		const batchChanges: ApplyTaxonomyChangesInput = { creates, updates, deletes };

		try {
			await applyTaxonomyChanges(pool, batchChanges);
			mergeLogger.info('Taxonomy changes applied successfully');
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);
			throw new TaxonomyError(
				`Failed to apply taxonomy changes: ${message}`,
				TAXONOMY_ERROR_CODES.TAXONOMY_MERGE_FAILED,
				{ cause: error },
			);
		}
	}

	return result;
}
