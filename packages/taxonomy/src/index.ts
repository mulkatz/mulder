/**
 * Taxonomy package barrel export.
 *
 * Provides taxonomy bootstrap, show, and normalization (trigram similarity matching).
 * Re-exports taxonomy types from @mulder/core.
 *
 * @see docs/specs/46_taxonomy_bootstrap.spec.md §4.2
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
export type { BootstrapOptions, BootstrapResult } from './bootstrap.js';
export { bootstrapTaxonomy, rebootstrapTaxonomy } from './bootstrap.js';
export { normalizeTaxonomy } from './normalize.js';
export type { ShowOptions } from './show.js';
export { showTaxonomy } from './show.js';
