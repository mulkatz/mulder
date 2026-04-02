/**
 * Type definitions for the story repository.
 *
 * Covers the `stories` table with strict TypeScript types
 * for all CRUD operations.
 *
 * @see docs/specs/22_story_repository.spec.md §4.1
 * @see docs/functional-spec.md §4.3
 */

// ────────────────────────────────────────────────────────────
// Status enum
// ────────────────────────────────────────────────────────────

/** Story status lifecycle. */
export type StoryStatus = 'segmented' | 'enriched' | 'embedded' | 'graphed' | 'analyzed';

// ────────────────────────────────────────────────────────────
// Story types
// ────────────────────────────────────────────────────────────

/** A story record from the database. */
export interface Story {
	id: string;
	sourceId: string;
	title: string;
	subtitle: string | null;
	language: string | null;
	category: string | null;
	pageStart: number | null;
	pageEnd: number | null;
	gcsMarkdownUri: string;
	gcsMetadataUri: string;
	chunkCount: number;
	extractionConfidence: number | null;
	status: StoryStatus;
	metadata: Record<string, unknown>;
	createdAt: Date;
	updatedAt: Date;
}

/** Input for creating a new story. */
export interface CreateStoryInput {
	/** Optional pre-generated UUID. When provided, the database uses this ID instead of gen_random_uuid(). */
	id?: string;
	sourceId: string;
	title: string;
	subtitle?: string;
	language?: string;
	category?: string;
	pageStart?: number;
	pageEnd?: number;
	gcsMarkdownUri: string;
	gcsMetadataUri: string;
	extractionConfidence?: number;
	metadata?: Record<string, unknown>;
}

/** Input for updating a story. Partial — only provided fields are updated. */
export interface UpdateStoryInput {
	title?: string;
	subtitle?: string;
	language?: string;
	category?: string;
	pageStart?: number;
	pageEnd?: number;
	gcsMarkdownUri?: string;
	gcsMetadataUri?: string;
	chunkCount?: number;
	extractionConfidence?: number;
	status?: StoryStatus;
	metadata?: Record<string, unknown>;
}

/** Filters for querying stories. */
export interface StoryFilter {
	sourceId?: string;
	status?: StoryStatus;
	category?: string;
	language?: string;
	limit?: number;
	offset?: number;
}
