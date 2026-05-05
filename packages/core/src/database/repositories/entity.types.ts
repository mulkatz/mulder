/**
 * Type definitions for entity, alias, and story-entity repositories.
 *
 * Covers the `entities`, `entity_aliases`, and `story_entities` tables
 * with strict TypeScript types for all CRUD operations.
 *
 * @see docs/specs/24_entity_alias_repositories.spec.md §4.1
 * @see docs/functional-spec.md §4.3
 */

import type { ArtifactProvenance, ArtifactProvenanceInput } from './artifact-provenance.js';
import type { Story } from './story.types.js';

// ────────────────────────────────────────────────────────────
// Taxonomy status
// ────────────────────────────────────────────────────────────

/** Taxonomy lifecycle status for entities. */
export type TaxonomyStatus = 'auto' | 'curated' | 'merged';

// ────────────────────────────────────────────────────────────
// Entity types
// ────────────────────────────────────────────────────────────

/** An entity record from the database. */
export interface Entity {
	id: string;
	canonicalId: string | null;
	name: string;
	type: string;
	/** Raw PostGIS geometry value for the entity location, reserved for M6 spatial features. */
	geom: string | null;
	attributes: Record<string, unknown>;
	corroborationScore: number | null;
	sourceCount: number;
	taxonomyStatus: TaxonomyStatus;
	/**
	 * FK to the canonical taxonomy entry this entity normalizes to. Two
	 * entity rows that mention the same canonical entity (e.g. "Allan
	 * Hendry" in two stories) share the same `taxonomyId` after enrich
	 * runs taxonomy normalization, enabling cross-story grouping queries.
	 */
	taxonomyId: string | null;
	provenance: ArtifactProvenance;
	createdAt: Date;
	updatedAt: Date;
}

/** Input for creating a new entity. */
export interface CreateEntityInput {
	/** Optional pre-generated UUID. */
	id?: string;
	name: string;
	type: string;
	canonicalId?: string;
	attributes?: Record<string, unknown>;
	taxonomyStatus?: TaxonomyStatus;
	/** Optional FK to the canonical taxonomy entry. */
	taxonomyId?: string | null;
	provenance?: ArtifactProvenanceInput;
}

/** Input for updating an entity. Partial -- only provided fields are updated. */
export interface UpdateEntityInput {
	name?: string;
	type?: string;
	/** Set to `null` to clear canonical_id. */
	canonicalId?: string | null;
	attributes?: Record<string, unknown>;
	corroborationScore?: number | null;
	sourceCount?: number;
	taxonomyStatus?: TaxonomyStatus;
	/** Set to `null` to clear the taxonomy FK. */
	taxonomyId?: string | null;
	provenance?: ArtifactProvenanceInput;
}

/** Filters for querying entities. */
export interface EntityFilter {
	type?: string;
	canonicalId?: string;
	taxonomyStatus?: TaxonomyStatus;
	/** Case-insensitive substring match on entity name (ILIKE). */
	search?: string;
	limit?: number;
	offset?: number;
}

// ────────────────────────────────────────────────────────────
// Grounding cache types
// ────────────────────────────────────────────────────────────

/** Geographic coordinates resolved during grounding. */
export interface GroundingCoordinates {
	lat: number;
	lng: number;
}

/** A cached grounding record from `entity_grounding`. */
export interface EntityGrounding {
	id: string;
	entityId: string;
	groundingData: Record<string, unknown>;
	sourceUrls: string[];
	groundedAt: Date;
	expiresAt: Date;
}

/** Input for creating or replacing a grounding cache record. */
export interface UpsertEntityGroundingInput {
	entityId: string;
	groundingData: Record<string, unknown>;
	sourceUrls: string[];
	groundedAt?: Date;
	expiresAt: Date;
}

// ────────────────────────────────────────────────────────────
// Merge result type
// ────────────────────────────────────────────────────────────

/** Result of merging two entities. */
export interface MergeEntitiesResult {
	/** The surviving target entity (post-merge state). */
	target: Entity;
	/** The merged source entity (now has canonical_id set). */
	merged: Entity;
	/** Number of edges reassigned from source to target. */
	edgesReassigned: number;
	/** Number of story links reassigned from source to target. */
	storiesReassigned: number;
	/** Number of aliases copied from source to target. */
	aliasesCopied: number;
}

// ────────────────────────────────────────────────────────────
// Entity alias types
// ────────────────────────────────────────────────────────────

/** An entity_aliases record from the database. */
export interface EntityAlias {
	id: string;
	entityId: string;
	alias: string;
	source: string | null;
	provenance: ArtifactProvenance;
}

/** Input for creating a new entity alias. */
export interface CreateEntityAliasInput {
	entityId: string;
	alias: string;
	source?: string;
	provenance?: ArtifactProvenanceInput;
}

// ────────────────────────────────────────────────────────────
// Story-entity junction types
// ────────────────────────────────────────────────────────────

/** A story_entities junction record from the database. */
export interface StoryEntity {
	storyId: string;
	entityId: string;
	confidence: number | null;
	mentionCount: number;
	provenance: ArtifactProvenance;
}

/** Input for linking a story to an entity. */
export interface LinkStoryEntityInput {
	storyId: string;
	entityId: string;
	confidence?: number;
	mentionCount?: number;
	provenance?: ArtifactProvenanceInput;
}

// ────────────────────────────────────────────────────────────
// Enriched junction types (for JOIN queries)
// ────────────────────────────────────────────────────────────

/** Entity with junction metadata, returned by `findEntitiesByStoryId`. */
export interface StoryEntityWithEntity extends Entity {
	confidence: number | null;
	mentionCount: number;
}

/** Story with junction metadata, returned by `findStoriesByEntityId`. */
export interface StoryEntityWithStory extends Story {
	confidence: number | null;
	mentionCount: number;
	provenance: ArtifactProvenance;
}
