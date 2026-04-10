/**
 * Zod schema for the curated taxonomy YAML format.
 *
 * Validates the structure that `mulder taxonomy export` produces and
 * that `mulder taxonomy merge` consumes. The format is a mapping of
 * entity type names to arrays of taxonomy entries.
 *
 * @see docs/specs/50_taxonomy_export_curate_merge.spec.md §4.1
 * @see docs/functional-spec.md §6.3
 */

import { z } from 'zod';

// ────────────────────────────────────────────────────────────
// Entry schema
// ────────────────────────────────────────────────────────────

const CuratedEntrySchema = z.object({
	id: z.string().uuid().optional(),
	canonical: z.string().min(1),
	status: z.enum(['confirmed', 'auto', 'rejected']).default('confirmed'),
	category: z.string().optional(),
	aliases: z.array(z.string()).default([]),
});

// ────────────────────────────────────────────────────────────
// Top-level schema (entity type -> entries)
// ────────────────────────────────────────────────────────────

export const CuratedTaxonomySchema = z.record(z.string(), z.array(CuratedEntrySchema));

// ────────────────────────────────────────────────────────────
// Inferred types
// ────────────────────────────────────────────────────────────

export type CuratedEntry = z.infer<typeof CuratedEntrySchema>;
export type CuratedTaxonomy = z.infer<typeof CuratedTaxonomySchema>;
