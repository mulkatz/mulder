/**
 * Taxonomy normalization -- matches entity names against the taxonomy table
 * using PostgreSQL trigram similarity (`pg_trgm`).
 *
 * For each extracted entity during enrichment:
 * 1. Search taxonomy by trigram similarity for the given name + type
 * 2. If match >= threshold and status is `confirmed`: assign but do NOT modify
 * 3. If match >= threshold and status is `auto`: assign and add alias
 * 4. If no match: create new `auto` entry
 *
 * @see docs/specs/27_taxonomy_normalization.spec.md §4.3
 * @see docs/functional-spec.md §6.2
 */

import type { NormalizationResult } from '@mulder/core';
import {
	createChildLogger,
	createLogger,
	createTaxonomyEntry,
	searchTaxonomyBySimilarity,
	updateTaxonomyEntry,
} from '@mulder/core';
import type pg from 'pg';

const logger = createLogger();
const normalizeLogger = createChildLogger(logger, { module: 'taxonomy-normalize' });

/**
 * Normalizes an entity name against the taxonomy table.
 *
 * Finds the best trigram-similarity match for the given name + entity type.
 * If a match is found above the threshold, it returns the matching taxonomy entry.
 * If no match exists, it creates a new `auto` taxonomy entry.
 *
 * Confirmed entries are never modified. Auto entries get the entity name
 * appended to their aliases array.
 *
 * @param pool - PostgreSQL connection pool
 * @param entityName - The raw entity name from extraction
 * @param entityType - The entity type (e.g., 'person', 'location')
 * @param threshold - Minimum trigram similarity score (0-1)
 * @returns The normalization result with taxonomy entry, action, and similarity
 */
export async function normalizeTaxonomy(
	pool: pg.Pool,
	entityName: string,
	entityType: string,
	threshold: number,
): Promise<NormalizationResult> {
	// Step 1: Search taxonomy by trigram similarity
	const matches = await searchTaxonomyBySimilarity(pool, entityName, entityType, threshold);

	if (matches.length > 0) {
		const bestMatch = matches[0];

		normalizeLogger.debug(
			{
				entityName,
				entityType,
				matchedName: bestMatch.entry.canonicalName,
				similarity: bestMatch.similarity,
				status: bestMatch.entry.status,
			},
			'Taxonomy match found',
		);

		// Step 2: If confirmed, assign but do NOT modify
		if (bestMatch.entry.status === 'confirmed') {
			return {
				taxonomyEntry: bestMatch.entry,
				action: 'matched',
				similarity: bestMatch.similarity,
			};
		}

		// Step 3: If auto, assign and add entity name as alias if not already present
		if (bestMatch.entry.status === 'auto') {
			const existingAliases = bestMatch.entry.aliases;
			if (!existingAliases.includes(entityName)) {
				const updatedEntry = await updateTaxonomyEntry(pool, bestMatch.entry.id, {
					aliases: [...existingAliases, entityName],
				});
				return {
					taxonomyEntry: updatedEntry,
					action: 'matched',
					similarity: bestMatch.similarity,
				};
			}
		}

		return {
			taxonomyEntry: bestMatch.entry,
			action: 'matched',
			similarity: bestMatch.similarity,
		};
	}

	// Step 4: No match -- create new auto entry
	normalizeLogger.debug({ entityName, entityType }, 'No taxonomy match, creating new auto entry');

	const newEntry = await createTaxonomyEntry(pool, {
		canonicalName: entityName,
		entityType,
		status: 'auto',
		aliases: [entityName],
	});

	return {
		taxonomyEntry: newEntry,
		action: 'created',
		similarity: null,
	};
}
