/**
 * Embedding wrapper — higher-level module orchestrating question generation
 * and batch embedding via the service interfaces.
 *
 * Splits chunk texts into configurable batches and delegates to the
 * `EmbeddingService` for vector generation and `LlmService` for
 * question generation.
 *
 * @see docs/specs/32_embedding_wrapper_semantic_chunker_chunk_repository.spec.md §4.4
 * @see docs/functional-spec.md §2.6
 */

import type { EmbeddingService, LlmService } from '@mulder/core';
import { createChildLogger, createLogger, EMBED_ERROR_CODES, EmbedError, renderPrompt } from '@mulder/core';

const logger = createLogger();
const wrapperLogger = createChildLogger(logger, { module: 'embedding-wrapper' });

// ────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────

/** Input for embedding a chunk. */
export type EmbedChunkInput = {
	chunkId: string;
	content: string;
	chunkIndex: number;
};

/** Result from embedding a chunk. */
export type EmbedChunkResult = {
	chunkId: string;
	embedding: number[];
};

/** Result from question generation for a chunk. */
export type QuestionResult = {
	parentChunkId: string;
	questions: string[];
};

/** Configuration for the embedding wrapper. */
export type EmbeddingWrapperConfig = {
	questionsPerChunk: number; // From config: embedding.questions_per_chunk
	batchSize: number; // From config: pipeline.batch_size.embed (default: 50)
};

// ────────────────────────────────────────────────────────────
// Question generation JSON schema
// ────────────────────────────────────────────────────────────

/** JSON Schema sent to Gemini for structured question generation output. */
const QUESTION_GENERATION_SCHEMA: Record<string, unknown> = {
	type: 'object',
	properties: {
		questions: {
			type: 'array',
			items: { type: 'string' },
			description: 'Array of search questions this text chunk could answer',
		},
	},
	required: ['questions'],
};

/** Parsed question generation response. */
interface QuestionGenerationResponse {
	questions: string[];
}

// ────────────────────────────────────────────────────────────
// Batch embedding
// ────────────────────────────────────────────────────────────

/**
 * Embeds chunk texts in batches via the EmbeddingService.
 *
 * 1. Split chunks into batches of `batchSize`.
 * 2. For each batch, call `embeddingService.embed(texts)`.
 * 3. Map results back to chunk IDs.
 * 4. Return all results (no partial — the `EmbeddingService` already handles retry).
 *
 * @param embeddingService - The embedding service interface
 * @param chunks - Chunks to embed
 * @param batchSize - Maximum number of texts per embedding API call
 * @returns Array of embedding results mapped to chunk IDs
 */
export async function embedChunks(
	embeddingService: EmbeddingService,
	chunks: EmbedChunkInput[],
	batchSize: number,
): Promise<EmbedChunkResult[]> {
	if (chunks.length === 0) {
		return [];
	}

	const results: EmbedChunkResult[] = [];
	const totalBatches = Math.ceil(chunks.length / batchSize);

	wrapperLogger.debug({ totalChunks: chunks.length, batchSize, totalBatches }, 'Starting batch embedding');

	for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
		const start = batchIndex * batchSize;
		const end = Math.min(start + batchSize, chunks.length);
		const batch = chunks.slice(start, end);

		const texts = batch.map((c) => c.content);

		try {
			const embedResults = await embeddingService.embed(texts);

			for (let i = 0; i < batch.length; i++) {
				results.push({
					chunkId: batch[i].chunkId,
					embedding: embedResults[i].vector,
				});
			}

			wrapperLogger.debug(
				{ batch: batchIndex + 1, totalBatches, chunksInBatch: batch.length },
				'Batch embedded successfully',
			);
		} catch (cause: unknown) {
			throw new EmbedError(
				`Embedding failed for batch ${batchIndex + 1}/${totalBatches}`,
				EMBED_ERROR_CODES.EMBED_EMBEDDING_FAILED,
				{
					cause,
					context: {
						batchIndex,
						totalBatches,
						chunksInBatch: batch.length,
					},
				},
			);
		}
	}

	wrapperLogger.debug({ totalResults: results.length }, 'Batch embedding complete');
	return results;
}

// ────────────────────────────────────────────────────────────
// Question generation
// ────────────────────────────────────────────────────────────

/**
 * Generates search questions for each chunk via LlmService.
 *
 * For each chunk, calls `llmService.generateStructured()` with a prompt
 * asking for `questionsPerChunk` questions that the chunk could answer.
 *
 * @param llmService - The LLM service interface
 * @param chunks - Chunks to generate questions for
 * @param questionsPerChunk - Number of questions to generate per chunk
 * @returns Array of question results mapped to parent chunk IDs
 */
export async function generateQuestions(
	llmService: LlmService,
	chunks: EmbedChunkInput[],
	questionsPerChunk: number,
): Promise<QuestionResult[]> {
	if (chunks.length === 0 || questionsPerChunk === 0) {
		return [];
	}

	const results: QuestionResult[] = [];

	wrapperLogger.debug({ totalChunks: chunks.length, questionsPerChunk }, 'Starting question generation');

	for (const chunk of chunks) {
		try {
			const prompt = renderPrompt('generate-questions', {
				chunk_text: chunk.content,
				questions_per_chunk: questionsPerChunk,
			});

			const response = await llmService.generateStructured<QuestionGenerationResponse>({
				prompt,
				schema: QUESTION_GENERATION_SCHEMA,
			});

			// Validate and trim to requested count
			const questions = Array.isArray(response.questions)
				? response.questions.filter((q): q is string => typeof q === 'string').slice(0, questionsPerChunk)
				: [];

			results.push({
				parentChunkId: chunk.chunkId,
				questions,
			});

			wrapperLogger.debug(
				{ chunkId: chunk.chunkId, questionsGenerated: questions.length },
				'Questions generated for chunk',
			);
		} catch (cause: unknown) {
			wrapperLogger.warn(
				{ chunkId: chunk.chunkId, err: cause },
				'Question generation failed for chunk — continuing with empty questions',
			);

			// Non-fatal: continue with empty questions for this chunk
			results.push({
				parentChunkId: chunk.chunkId,
				questions: [],
			});
		}
	}

	wrapperLogger.debug(
		{
			totalResults: results.length,
			totalQuestions: results.reduce((sum, r) => sum + r.questions.length, 0),
		},
		'Question generation complete',
	);

	return results;
}
