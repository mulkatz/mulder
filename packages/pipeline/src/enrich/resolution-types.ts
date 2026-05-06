/**
 * Type definitions for the 3-tier cross-lingual entity resolution module.
 *
 * Tier 1: Attribute match (deterministic)
 * Tier 2: Embedding similarity (statistical)
 * Tier 3: LLM-assisted (semantic)
 *
 * @see docs/specs/28_cross_lingual_entity_resolution.spec.md §4.2
 * @see docs/functional-spec.md §2.4
 */

import type { ArtifactProvenanceInput, Entity, EntityResolutionConfig, Services } from '@mulder/core';
import type pg from 'pg';

/** Which resolution tier produced the match. */
export type ResolutionTier = 'attribute_match' | 'embedding_similarity' | 'llm_assisted';

/** A candidate entity match with its resolution metadata. */
export interface ResolutionCandidate {
	entity: Entity;
	tier: ResolutionTier;
	/** Similarity/confidence score (0-1). */
	score: number;
	/** What matched -- attribute name, embedding distance, or LLM reasoning. */
	evidence: string;
}

/** Result of resolving a single entity. */
export interface ResolutionResult {
	/** 'merged' if matched an existing entity, 'new' if no match found. */
	action: 'merged' | 'new';
	/** The canonical entity (existing match or the entity itself). */
	canonicalEntity: Entity;
	/** The resolution candidate if merged, null if new. */
	match: ResolutionCandidate | null;
	/** Tiers that were actually executed (disabled tiers are skipped). */
	tiersExecuted: ResolutionTier[];
}

/** Options passed to resolveEntity(). */
export interface ResolveEntityOptions {
	/** The entity to resolve. Must already exist in the DB. */
	entity: Entity;
	/** PostgreSQL connection pool. */
	pool: pg.Pool;
	/** Service registry for embedding + LLM calls. */
	services: Services;
	/** Entity resolution config. */
	config: EntityResolutionConfig;
	/** Provenance to merge onto aliases/canonical entities when resolution merges. */
	provenance?: ArtifactProvenanceInput;
}
