/**
 * Type definitions for the edge repository (`entity_edges` table).
 *
 * Covers all edge types in the knowledge graph — relationships extracted
 * from stories, deduplication links, and contradiction edges.
 *
 * @see docs/specs/25_edge_repository.spec.md §4.1
 * @see docs/functional-spec.md §4.3
 */

import type { SensitivityLevel, SensitivityMetadata } from '../../shared/sensitivity.js';
import type { ArtifactProvenance, ArtifactProvenanceInput } from './artifact-provenance.js';

// ────────────────────────────────────────────────────────────
// Edge type enum
// ────────────────────────────────────────────────────────────

/** Edge types in the knowledge graph. */
export type EdgeType =
	| 'RELATIONSHIP'
	| 'DUPLICATE_OF'
	| 'POTENTIAL_CONTRADICTION'
	| 'CONFIRMED_CONTRADICTION'
	| 'DISMISSED_CONTRADICTION';

// ────────────────────────────────────────────────────────────
// Entity edge types
// ────────────────────────────────────────────────────────────

/** An entity_edges record from the database. */
export interface EntityEdge {
	id: string;
	sourceEntityId: string;
	targetEntityId: string;
	relationship: string;
	attributes: Record<string, unknown>;
	confidence: number | null;
	storyId: string | null;
	edgeType: EdgeType;
	analysis: Record<string, unknown> | null;
	provenance: ArtifactProvenance;
	sensitivityLevel: SensitivityLevel;
	sensitivityMetadata: SensitivityMetadata;
	createdAt: Date;
}

/** Input for creating a new edge. */
export interface CreateEdgeInput {
	/** Optional pre-generated UUID. */
	id?: string;
	sourceEntityId: string;
	targetEntityId: string;
	relationship: string;
	attributes?: Record<string, unknown>;
	confidence?: number;
	storyId?: string;
	/** Defaults to 'RELATIONSHIP'. */
	edgeType?: EdgeType;
	analysis?: Record<string, unknown>;
	provenance?: ArtifactProvenanceInput;
	sensitivityLevel?: SensitivityLevel;
	sensitivityMetadata?: unknown;
}

/** Input for updating an edge. Partial -- only provided fields are updated. */
export interface UpdateEdgeInput {
	attributes?: Record<string, unknown>;
	confidence?: number | null;
	edgeType?: EdgeType;
	analysis?: Record<string, unknown> | null;
	sensitivityLevel?: SensitivityLevel;
	sensitivityMetadata?: unknown;
}

/** Filters for querying edges. */
export interface EdgeFilter {
	sourceEntityId?: string;
	targetEntityId?: string;
	edgeType?: EdgeType;
	storyId?: string;
	relationship?: string;
	includeDeleted?: boolean;
	limit?: number;
	offset?: number;
}
