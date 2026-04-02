/**
 * Type definitions for entity, alias, and story-entity repositories.
 *
 * Covers the `entities`, `entity_aliases`, and `story_entities` tables
 * with strict TypeScript types for all CRUD operations.
 *
 * @see docs/specs/24_entity_alias_repositories.spec.md §4.1
 * @see docs/functional-spec.md §4.3
 */

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
	attributes: Record<string, unknown>;
	corroborationScore: number | null;
	sourceCount: number;
	taxonomyStatus: TaxonomyStatus;
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
}

/** Filters for querying entities. */
export interface EntityFilter {
	type?: string;
	canonicalId?: string;
	taxonomyStatus?: TaxonomyStatus;
	limit?: number;
	offset?: number;
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
}

/** Input for creating a new entity alias. */
export interface CreateEntityAliasInput {
	entityId: string;
	alias: string;
	source?: string;
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
}

/** Input for linking a story to an entity. */
export interface LinkStoryEntityInput {
	storyId: string;
	entityId: string;
	confidence?: number;
	mentionCount?: number;
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
}
