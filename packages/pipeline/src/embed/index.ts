/**
 * Embed module barrel export.
 *
 * Exports the semantic chunker and embedding wrapper — building blocks
 * for the Embed pipeline step (D4).
 *
 * @see docs/specs/32_embedding_wrapper_semantic_chunker_chunk_repository.spec.md §4.5
 */

export type {
	EmbedChunkInput,
	EmbedChunkResult,
	EmbeddingWrapperConfig,
	QuestionResult,
} from './embedding-wrapper.js';
export { embedChunks, generateQuestions } from './embedding-wrapper.js';
export type { ChunkerConfig, SemanticChunk } from './semantic-chunker.js';
export { chunkStory } from './semantic-chunker.js';
