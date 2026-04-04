/**
 * Type definitions for the chunk repository.
 *
 * Covers the `chunks` table with strict TypeScript types
 * for all CRUD, vector search, and full-text search operations.
 *
 * @see docs/specs/32_embedding_wrapper_semantic_chunker_chunk_repository.spec.md §4.1
 * @see docs/functional-spec.md §4.3
 */

// ────────────────────────────────────────────────────────────
// Database row type (snake_case)
// ────────────────────────────────────────────────────────────

/** Raw row shape from the `chunks` table (snake_case column names). */
export type ChunkRow = {
	id: string;
	story_id: string;
	content: string;
	chunk_index: number;
	page_start: number | null;
	page_end: number | null;
	embedding: string | null; // pgvector returns as string '[0.1,0.2,...]'
	fts_vector: string | null; // tsvector serialized (read-only, generated column)
	is_question: boolean;
	parent_chunk_id: string | null;
	metadata: Record<string, unknown>;
	created_at: Date;
};

// ────────────────────────────────────────────────────────────
// Domain type (camelCase)
// ────────────────────────────────────────────────────────────

/** A chunk record from the database, mapped to camelCase. */
export type Chunk = {
	id: string;
	storyId: string;
	content: string;
	chunkIndex: number;
	pageStart: number | null;
	pageEnd: number | null;
	embedding: number[] | null;
	isQuestion: boolean;
	parentChunkId: string | null;
	metadata: Record<string, unknown>;
	createdAt: Date;
};

// ────────────────────────────────────────────────────────────
// Input / filter types
// ────────────────────────────────────────────────────────────

/** Input for creating a new chunk. */
export type CreateChunkInput = {
	storyId: string;
	content: string;
	chunkIndex: number;
	pageStart?: number | null;
	pageEnd?: number | null;
	embedding?: number[] | null;
	isQuestion?: boolean;
	parentChunkId?: string | null;
	metadata?: Record<string, unknown>;
};

/** Filters for querying chunks. */
export type ChunkFilter = {
	storyId?: string;
	isQuestion?: boolean;
};

// ────────────────────────────────────────────────────────────
// Search result types
// ────────────────────────────────────────────────────────────

/** Result from vector similarity search. */
export type VectorSearchResult = {
	chunk: Chunk;
	distance: number; // cosine distance (0 = identical, 2 = opposite)
	similarity: number; // 1 - distance
};

/** Result from full-text search. */
export type FtsSearchResult = {
	chunk: Chunk;
	rank: number; // ts_rank score
};
