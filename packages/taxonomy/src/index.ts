/**
 * Taxonomy package barrel export.
 *
 * Provides taxonomy bootstrap, show, normalization, export, and merge.
 * Re-exports taxonomy types from @mulder/core.
 *
 * @see docs/specs/46_taxonomy_bootstrap.spec.md §4.2
 * @see docs/specs/27_taxonomy_normalization.spec.md §4.5
 * @see docs/specs/50_taxonomy_export_curate_merge.spec.md §4.2
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
export type { CuratedEntry, CuratedTaxonomy } from './curated-schema.js';
export { CuratedTaxonomySchema } from './curated-schema.js';
export type { ExportOptions, ExportResult } from './export.js';
export { exportTaxonomy } from './export.js';
export type { MergeChange, MergeOptions, MergeResult } from './merge.js';
export { mergeTaxonomy } from './merge.js';
export { normalizeTaxonomy } from './normalize.js';
export type { ShowOptions } from './show.js';
export { showTaxonomy } from './show.js';
