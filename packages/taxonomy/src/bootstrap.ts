/**
 * Taxonomy bootstrap -- generates an initial taxonomy from all extracted
 * entities using Gemini clustering.
 *
 * Two functions:
 * - `bootstrapTaxonomy()` — clusters entities by type, creates auto taxonomy entries
 * - `rebootstrapTaxonomy()` — deletes auto entries, then re-runs bootstrap
 *
 * @see docs/specs/46_taxonomy_bootstrap.spec.md §4.1
 * @see docs/functional-spec.md §6.1
 */

import type { Entity, LlmService, Logger, MulderConfig, TaxonomyEntry } from '@mulder/core';
import {
	countProcessedSources,
	createChildLogger,
	createTaxonomyEntry,
	deleteAutoTaxonomyEntries,
	findAllEntities,
	findAllTaxonomyEntries,
	renderPrompt,
	TAXONOMY_ERROR_CODES,
	TaxonomyError,
} from '@mulder/core';
import type pg from 'pg';
import { z as z3 } from 'zod/v3';
import { zodToJsonSchema } from 'zod-to-json-schema';

// ─────────────────────────────────────��──────────────────────
// Types
// ────────────────────────────────────────────────────────────

export interface BootstrapOptions {
	pool: pg.Pool;
	llm: LlmService;
	config: MulderConfig;
	logger: Logger;
	/** Override thresholds.taxonomy_bootstrap */
	minDocs?: number;
}

export interface BootstrapResult {
	entriesCreated: number;
	entriesUpdated: number;
	typesProcessed: string[];
	skippedTypes: string[];
	corpusSize: number;
}

// ────────────────────────────────────────────────────────────
// Gemini response schema (Zod v3 for zod-to-json-schema)
// ────────────────────────────────────────────────────────────

const bootstrapClusterSchemaV3 = z3.object({
	canonical: z3.string().describe('The canonical/preferred name for this entity'),
	aliases: z3.array(z3.string()).describe('Alternative names, abbreviations, misspellings'),
});

const bootstrapResponseSchemaV3 = z3.object({
	clusters: z3.array(bootstrapClusterSchemaV3).describe('Grouped entity clusters for this type'),
});

type BootstrapResponse = {
	clusters: Array<{
		canonical: string;
		aliases: string[];
	}>;
};

function getBootstrapJsonSchema(): Record<string, unknown> {
	return zodToJsonSchema(bootstrapResponseSchemaV3, {
		$refStrategy: 'none',
	});
}

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

/**
 * Groups entities by type, deduplicating names within each type.
 */
function groupEntitiesByType(entities: Entity[]): Map<string, string[]> {
	const groups = new Map<string, Set<string>>();

	for (const entity of entities) {
		const existing = groups.get(entity.type);
		if (existing) {
			existing.add(entity.name);
		} else {
			groups.set(entity.type, new Set([entity.name]));
		}
	}

	const result = new Map<string, string[]>();
	for (const [type, nameSet] of groups) {
		result.set(type, [...nameSet].sort());
	}

	return result;
}

/**
 * Formats confirmed taxonomy entries as context for the prompt.
 */
function formatConfirmedEntries(entries: TaxonomyEntry[]): string {
	if (entries.length === 0) {
		return '';
	}

	const lines = entries.map(
		(e) => `- ${e.canonicalName} (aliases: ${e.aliases.length > 0 ? e.aliases.join(', ') : 'none'})`,
	);

	return `### Already confirmed entries (DO NOT duplicate or modify these):\n${lines.join('\n')}`;
}

/**
 * Loads all entities from the database without the default 100 limit.
 * Paginates internally to avoid loading unbounded result sets.
 */
async function loadAllEntities(pool: pg.Pool): Promise<Entity[]> {
	const allEntities: Entity[] = [];
	const pageSize = 1000;
	let offset = 0;

	let batch = await findAllEntities(pool, { limit: pageSize, offset });
	while (batch.length > 0) {
		allEntities.push(...batch);
		offset += pageSize;
		batch = await findAllEntities(pool, { limit: pageSize, offset });
	}

	return allEntities;
}

// ────────────────────────────────────────────────────────────
// Bootstrap
// ────────────────────────────────────────────────────────────

/**
 * Generates an initial taxonomy from all extracted entities.
 *
 * 1. Checks corpus size against threshold
 * 2. Loads all entities and groups by type
 * 3. For each type: calls Gemini to cluster entity names
 * 4. Upserts taxonomy entries with status 'auto'
 */
export async function bootstrapTaxonomy(options: BootstrapOptions): Promise<BootstrapResult> {
	const { pool, llm, config, logger, minDocs } = options;
	const bootstrapLogger = createChildLogger(logger, { module: 'taxonomy-bootstrap' });

	const threshold = minDocs ?? config.thresholds.taxonomy_bootstrap;

	// Step 1: Check corpus size
	const corpusSize = await countProcessedSources(pool);
	bootstrapLogger.info({ corpusSize, threshold }, 'Checking corpus size for taxonomy bootstrap');

	if (corpusSize < threshold) {
		throw new TaxonomyError(
			`Corpus has ${corpusSize} processed documents, but taxonomy bootstrap requires at least ${threshold}. Use --min-docs to override.`,
			TAXONOMY_ERROR_CODES.TAXONOMY_BELOW_THRESHOLD,
			{ context: { corpusSize, threshold } },
		);
	}

	// Step 2: Load all entities
	const entities = await loadAllEntities(pool);
	bootstrapLogger.info({ entityCount: entities.length }, 'Loaded entities for bootstrap');

	if (entities.length === 0) {
		return {
			entriesCreated: 0,
			entriesUpdated: 0,
			typesProcessed: [],
			skippedTypes: [],
			corpusSize,
		};
	}

	// Step 3: Group by type
	const entityGroups = groupEntitiesByType(entities);
	const jsonSchema = getBootstrapJsonSchema();

	let totalCreated = 0;
	let totalUpdated = 0;
	const typesProcessed: string[] = [];
	const skippedTypes: string[] = [];

	// Resolve locale from config (default to 'en')
	const locale = config.project.supported_locales[0] ?? 'en';

	// Step 4: Process each type
	for (const [entityType, entityNames] of entityGroups) {
		bootstrapLogger.info({ entityType, uniqueNames: entityNames.length }, 'Processing entity type for bootstrap');

		// Load existing confirmed entries for this type
		const confirmedEntries = await findAllTaxonomyEntries(pool, {
			entityType,
			status: 'confirmed',
			limit: 10000,
		});

		// If ALL entity names already have confirmed taxonomy entries, skip this type
		const confirmedNames = new Set<string>();
		for (const entry of confirmedEntries) {
			confirmedNames.add(entry.canonicalName.toLowerCase());
			for (const alias of entry.aliases) {
				confirmedNames.add(alias.toLowerCase());
			}
		}

		const unconfirmedNames = entityNames.filter((name) => !confirmedNames.has(name.toLowerCase()));

		if (unconfirmedNames.length === 0) {
			bootstrapLogger.info({ entityType }, 'All entities confirmed, skipping type');
			skippedTypes.push(entityType);
			continue;
		}

		// Render prompt
		const confirmedEntriesSection = formatConfirmedEntries(confirmedEntries);
		const prompt = renderPrompt('bootstrap-taxonomy', {
			locale,
			entity_type: entityType,
			entity_count: String(unconfirmedNames.length),
			entity_names: unconfirmedNames.join('\n'),
			confirmed_entries_section: confirmedEntriesSection,
		});

		// Call Gemini with response validation (matches segment/enrich pattern)
		const response = await llm.generateStructured<BootstrapResponse>({
			prompt,
			schema: jsonSchema,
			systemInstruction: `You are a taxonomy specialist. Group entity names of type "${entityType}" into canonical clusters.`,
			responseValidator: (data) => bootstrapResponseSchemaV3.parse(data),
		});

		// Safety: validate clusters is iterable before processing
		const clusters = Array.isArray(response.clusters) ? response.clusters : [];

		// Process clusters
		for (const cluster of clusters) {
			const entry = await createTaxonomyEntry(pool, {
				canonicalName: cluster.canonical,
				entityType,
				status: 'auto',
				aliases: cluster.aliases,
			});

			// createTaxonomyEntry uses ON CONFLICT — if it already existed, it's an update (aliases merged)
			// We count based on whether the entry was just created or already existed
			const isNew = entry.createdAt.getTime() === entry.updatedAt.getTime();
			if (isNew) {
				totalCreated++;
			} else {
				totalUpdated++;
			}
		}

		typesProcessed.push(entityType);
		bootstrapLogger.info({ entityType, clusters: clusters.length }, 'Type bootstrap complete');
	}

	bootstrapLogger.info(
		{ totalCreated, totalUpdated, typesProcessed: typesProcessed.length, skippedTypes: skippedTypes.length },
		'Taxonomy bootstrap complete',
	);

	return {
		entriesCreated: totalCreated,
		entriesUpdated: totalUpdated,
		typesProcessed,
		skippedTypes,
		corpusSize,
	};
}

// ────────────────────────────────────────────────────────────
// Re-bootstrap
// ────────────────────────────────────────────────────────────

/**
 * Regenerates taxonomy by deleting all auto entries and re-running bootstrap.
 * Confirmed and rejected entries are preserved.
 */
export async function rebootstrapTaxonomy(options: BootstrapOptions): Promise<BootstrapResult> {
	const { pool, logger } = options;
	const bootstrapLogger = createChildLogger(logger, { module: 'taxonomy-rebootstrap' });

	// Delete all auto entries
	const deletedCount = await deleteAutoTaxonomyEntries(pool);
	bootstrapLogger.info({ deletedCount }, 'Deleted auto taxonomy entries for re-bootstrap');

	// Re-run bootstrap
	return bootstrapTaxonomy(options);
}
