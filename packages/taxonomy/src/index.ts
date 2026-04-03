/**
 * Taxonomy package barrel export.
 *
 * Provides taxonomy normalization (trigram similarity matching)
 * and re-exports taxonomy types from @mulder/core.
 *
 * @see docs/specs/27_taxonomy_normalization.spec.md §4.5
 * @see docs/functional-spec.md §6
 */

export type {
	CreateTaxonomyEntryInput,
	NormalizationResult,
	TaxonomyEntry,
	TaxonomyEntryStatus,
	TaxonomyFilter,
	TaxonomySimilarityMatch,
	UpdateTaxonomyEntryInput,
} from '@mulder/core';
export { normalizeTaxonomy } from './normalize.js';
