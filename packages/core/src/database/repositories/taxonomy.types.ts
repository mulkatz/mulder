/**
 * Type definitions for the taxonomy repository.
 *
 * Covers the `taxonomy` table with strict TypeScript types
 * for all CRUD and similarity search operations.
 *
 * @see docs/specs/27_taxonomy_normalization.spec.md §4.1
 * @see docs/functional-spec.md §6.2
 */

// ────────────────────────────────────────────────────────────
// Taxonomy entry status
// ────────────────────────────────────────────────────────────

/** Taxonomy entry lifecycle status. */
export type TaxonomyEntryStatus = 'auto' | 'confirmed' | 'rejected';

// ────────────────────────────────────────────────────────────
// Taxonomy entry
// ────────────────────────────────────────────────────────────

/** A taxonomy record from the database. */
export interface TaxonomyEntry {
	id: string;
	canonicalName: string;
	entityType: string;
	category: string | null;
	status: TaxonomyEntryStatus;
	aliases: string[];
	createdAt: Date;
	updatedAt: Date;
}

/** Input for creating a taxonomy entry. */
export interface CreateTaxonomyEntryInput {
	canonicalName: string;
	entityType: string;
	category?: string;
	status?: TaxonomyEntryStatus;
	aliases?: string[];
}

/** Input for updating a taxonomy entry. Partial -- only provided fields are updated. */
export interface UpdateTaxonomyEntryInput {
	canonicalName?: string;
	entityType?: string;
	category?: string | null;
	status?: TaxonomyEntryStatus;
	aliases?: string[];
}

/** Filter for querying taxonomy entries. */
export interface TaxonomyFilter {
	entityType?: string;
	status?: TaxonomyEntryStatus;
	limit?: number;
	offset?: number;
}

// ────────────────────────────────────────────────────────────
// Similarity search
// ────────────────────────────────────────────────────────────

/** Result of a trigram similarity search. */
export interface TaxonomySimilarityMatch {
	entry: TaxonomyEntry;
	similarity: number;
}

// ────────────────────────────────────────────────────────────
// Normalization result
// ────────────────────────────────────────────────────────────

/** Result of taxonomy normalization for a single entity. */
export interface NormalizationResult {
	/** The matched or newly created taxonomy entry. */
	taxonomyEntry: TaxonomyEntry;
	/** Whether this was an existing match or a new entry. */
	action: 'matched' | 'created';
	/** Trigram similarity score (0-1) if matched, null if created. */
	similarity: number | null;
}
