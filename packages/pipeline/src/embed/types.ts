/**
 * Type definitions for the Embed pipeline step.
 *
 * The Embed step chunks stories, generates question embeddings,
 * and stores vector representations for semantic search.
 *
 * @see docs/specs/34_embed_step.spec.md §4.1
 * @see docs/functional-spec.md §2.6
 */

import type { StepError } from '@mulder/core';

// ────────────────────────────────────────────────────────────
// Step input / output
// ────────────────────────────────────────────────────────────

/** Input for the embed pipeline step. */
export interface EmbedInput {
	storyId: string;
	force?: boolean;
}

/** Result from the embed pipeline step. */
export interface EmbedResult {
	status: 'success' | 'partial' | 'failed';
	data: EmbeddingData | null;
	errors: StepError[];
	metadata: {
		duration_ms: number;
		items_processed: number;
		items_skipped: number;
		items_cached: number;
	};
}

/** Embedding data produced by the step. */
export interface EmbeddingData {
	storyId: string;
	chunksCreated: number;
	questionsGenerated: number;
	embeddingsCreated: number;
}
