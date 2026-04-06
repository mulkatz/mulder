/**
 * Type definitions for the Graph pipeline step.
 *
 * The Graph step writes entity relationship edges, detects near-duplicate
 * stories via MinHash, calculates dedup-aware corroboration scores, and
 * flags potential contradictions via attribute diff (no LLM).
 *
 * @see docs/specs/35_graph_step.spec.md §4.1
 * @see docs/functional-spec.md §2.7
 */

import type { StepError } from '@mulder/core';

// ────────────────────────────────────────────────────────────
// Step input / output
// ────────────────────────────────────────────────────────────

/** Input for the graph pipeline step. */
export interface GraphInput {
	storyId: string;
	force?: boolean;
}

/** Result data from the graph step. */
export interface GraphData {
	storyId: string;
	edgesCreated: number;
	edgesUpdated: number;
	duplicatesFound: number;
	corroborationUpdates: number;
	contradictionsFlagged: number;
}

/** Full graph step result following StepResult pattern. */
export interface GraphResult {
	status: 'success' | 'partial' | 'failed';
	data: GraphData | null;
	errors: StepError[];
	metadata: {
		duration_ms: number;
		items_processed: number;
		items_skipped: number;
		items_cached: number;
	};
}

// ────────────────────────────────────────────────────────────
// Deduplication types
// ────────────────────────────────────────────────────────────

/** A duplicate pair detected by MinHash. */
export interface DuplicatePair {
	storyIdA: string;
	storyIdB: string;
	similarity: number;
	duplicateType: 'exact' | 'near' | 'reprint' | 'summary';
}

// ────────────────────────────────────────────────────────────
// Corroboration types
// ────────────────────────────────────────────────────────────

/** Corroboration result for a single entity. */
export interface CorroborationResult {
	entityId: string;
	independentSourceCount: number;
	corroborationScore: number;
}

// ────────────────────────────────────────────────────────────
// Contradiction types
// ────────────────────────────────────────────────────────────

/** A potential contradiction between two entity mentions. */
export interface ContradictionCandidate {
	entityId: string;
	storyIdA: string;
	storyIdB: string;
	attribute: string;
	valueA: string;
	valueB: string;
}
