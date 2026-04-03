/**
 * Type definitions for the Enrich pipeline step.
 *
 * The Enrich step extracts entities and relationships from stories
 * using Gemini structured output, normalizes against taxonomy,
 * and resolves cross-document entity matches.
 *
 * @see docs/specs/29_enrich_step.spec.md §4.1
 * @see docs/functional-spec.md §2.4
 */

import type { StepError } from '@mulder/core';

// ────────────────────────────────────────────────────────────
// Step input / output
// ────────────────────────────────────────────────────────────

/** Input for the enrich pipeline step. */
export interface EnrichInput {
	storyId: string;
	force?: boolean;
}

/** Result from the enrich pipeline step. */
export interface EnrichResult {
	status: 'success' | 'partial' | 'failed';
	data: EnrichmentData | null;
	errors: StepError[];
	metadata: {
		duration_ms: number;
		items_processed: number;
		items_skipped: number;
		items_cached: number;
	};
}

/** Enrichment data produced by the step. */
export interface EnrichmentData {
	storyId: string;
	entitiesExtracted: number;
	entitiesResolved: number;
	relationshipsCreated: number;
	taxonomyEntriesAdded: number;
	/** 1 if no pre-chunking, N if pre-chunked. */
	chunksUsed: number;
}

// ────────────────────────────────────────────────────────────
// Extraction response types (from Gemini structured output)
// ────────────────────────────────────────────────────────────

/** An entity extracted from a story by Gemini. */
export interface ExtractedEntity {
	name: string;
	type: string;
	confidence: number;
	attributes: Record<string, unknown>;
	mentions: string[];
}

/** A relationship extracted from a story by Gemini. */
export interface ExtractedRelationship {
	source_entity: string;
	target_entity: string;
	relationship_type: string;
	confidence: number;
	attributes?: Record<string, unknown>;
}

/** The full extraction response from Gemini. */
export interface ExtractionResponse {
	entities: ExtractedEntity[];
	relationships: ExtractedRelationship[];
}
