/**
 * Embed pipeline step — the sixth pipeline step that chunks stories,
 * generates question embeddings, and stores vector representations
 * for semantic search.
 *
 * Orchestrates existing building blocks: semantic chunker (spec 32),
 * embedding wrapper (spec 32), chunk repository (spec 32).
 *
 * @see docs/specs/34_embed_step.spec.md
 * @see docs/functional-spec.md §2.6
 */

import { performance } from 'node:perf_hooks';
import type { Chunk, CreateChunkInput, Logger, MulderConfig, Services, StepError } from '@mulder/core';
import {
	createChildLogger,
	createChunks,
	deleteChunksByStoryId,
	EMBED_ERROR_CODES,
	EmbedError,
	findStoryById,
	getStepConfigHash,
	resetPipelineStep,
	updateChunkEmbedding,
	updateStoryStatus,
	upsertSourceStep,
} from '@mulder/core';
import type pg from 'pg';
import type { EmbedChunkInput } from './embedding-wrapper.js';
import { embedChunks, generateQuestions } from './embedding-wrapper.js';
import { chunkStory } from './semantic-chunker.js';
import type { EmbeddingData, EmbedInput, EmbedResult } from './types.js';

// Re-export building block types and functions
export type {
	EmbedChunkInput,
	EmbedChunkResult,
	EmbeddingWrapperConfig,
	QuestionResult,
} from './embedding-wrapper.js';
export { embedChunks, generateQuestions } from './embedding-wrapper.js';
export type { ChunkerConfig, SemanticChunk } from './semantic-chunker.js';
export { chunkStory } from './semantic-chunker.js';
export type { EmbeddingData, EmbedInput, EmbedResult } from './types.js';

// ────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────

const STEP_NAME = 'embed';

/** Default batch size for embedding API calls. */
const DEFAULT_BATCH_SIZE = 50;

/** Default number of questions per chunk. */
const DEFAULT_QUESTIONS_PER_CHUNK = 3;

// ────────────────────────────────────────────────────────────
// Force cleanup
// ────────────────────────────────────────────────────────────

/**
 * Cleans up existing embedding artifacts for a single story.
 * Deletes all chunks, resets story status to enriched.
 */
async function forceCleanupStory(storyId: string, pool: pg.Pool, logger: Logger): Promise<void> {
	const deletedChunks = await deleteChunksByStoryId(pool, storyId);
	await updateStoryStatus(pool, storyId, 'enriched');
	logger.debug({ storyId, deletedChunks }, 'Force cleanup complete for story');
}

/**
 * Cleans up existing embedding artifacts for all stories of a source.
 * Uses resetPipelineStep which cascades: deletes chunks, resets story statuses to enriched.
 */
async function forceCleanupSource(sourceId: string, pool: pg.Pool, logger: Logger): Promise<void> {
	await resetPipelineStep(pool, sourceId, 'embed');
	logger.info({ sourceId }, 'Force cleanup complete — stories reset to enriched');
}

// ────────────────────────────────────────────────────────────
// Main execute function
// ────────────────────────────────────────────────────────────

/**
 * Executes the embed pipeline step for a single story.
 *
 * Loads story Markdown from GCS, chunks it semantically, generates
 * question embeddings, embeds all chunks via the embedding service,
 * and persists results to PostgreSQL.
 *
 * @param input - Embed input (storyId, force)
 * @param config - Validated Mulder configuration
 * @param services - Service registry (storage, embedding, llm, firestore)
 * @param pool - PostgreSQL connection pool
 * @param logger - Logger instance
 * @returns Embed result
 */
export async function execute(
	input: EmbedInput,
	config: MulderConfig,
	services: Services,
	pool: pg.Pool | undefined,
	logger: Logger,
): Promise<EmbedResult> {
	const log = createChildLogger(logger, { step: STEP_NAME, storyId: input.storyId });
	const startTime = performance.now();
	const stepConfigHash = getStepConfigHash(config, STEP_NAME);

	log.info({ force: input.force ?? false }, 'Embed step started');

	// 1. Validate pool exists
	if (!pool) {
		throw new EmbedError('Database pool is required for embed step', EMBED_ERROR_CODES.EMBED_STORY_NOT_FOUND, {
			context: { storyId: input.storyId },
		});
	}

	// 2. Load story from DB
	const story = await findStoryById(pool, input.storyId);
	if (!story) {
		throw new EmbedError(`Story not found: ${input.storyId}`, EMBED_ERROR_CODES.EMBED_STORY_NOT_FOUND, {
			context: { storyId: input.storyId },
		});
	}

	// 3. Validate status — must be at least "enriched"
	const validStatuses = ['enriched', 'embedded', 'graphed', 'analyzed'];
	if (!validStatuses.includes(story.status)) {
		throw new EmbedError(
			`Story ${input.storyId} has invalid status "${story.status}" for embedding — must be at least "enriched"`,
			EMBED_ERROR_CODES.EMBED_INVALID_STATUS,
			{ context: { storyId: input.storyId, status: story.status } },
		);
	}

	// 4. Skip if already embedded (or beyond) and no --force
	if (story.status !== 'enriched' && !input.force) {
		log.info({ status: story.status }, 'Story already embedded — skipping (use --force to re-embed)');
		return {
			status: 'success',
			data: null,
			errors: [],
			metadata: {
				duration_ms: Math.round(performance.now() - startTime),
				items_processed: 0,
				items_skipped: 1,
				items_cached: 0,
			},
		};
	}

	// 5. Force cleanup if --force and already processed
	if (input.force && story.status !== 'enriched') {
		await forceCleanupStory(input.storyId, pool, log);
	}

	// 6. Load story Markdown from GCS
	let markdown: string;
	try {
		const buffer = await services.storage.download(story.gcsMarkdownUri);
		markdown = buffer.toString('utf-8');
	} catch (cause: unknown) {
		throw new EmbedError(
			`Story Markdown not found at ${story.gcsMarkdownUri} — has it been segmented?`,
			EMBED_ERROR_CODES.EMBED_MARKDOWN_NOT_FOUND,
			{ cause, context: { storyId: input.storyId, uri: story.gcsMarkdownUri } },
		);
	}

	const errors: StepError[] = [];

	// 7. Semantic chunking
	const chunkSizeTokens = config.embedding.chunk_size_tokens;
	const chunkOverlapTokens = config.embedding.chunk_overlap_tokens;
	const questionsPerChunk = config.embedding.questions_per_chunk ?? DEFAULT_QUESTIONS_PER_CHUNK;
	const batchSize = config.pipeline.batch_size.embed ?? DEFAULT_BATCH_SIZE;

	const semanticChunks = chunkStory(markdown, story.pageStart, story.pageEnd, {
		chunkSizeTokens,
		chunkOverlapTokens,
	});

	log.debug(
		{
			chunkCount: semanticChunks.length,
			chunkSizeTokens,
			chunkOverlapTokens,
		},
		'Semantic chunking complete',
	);

	if (semanticChunks.length === 0) {
		log.warn('No chunks produced from story Markdown — empty or too short');
		const durationMs = Math.round(performance.now() - startTime);

		await upsertSourceStep(pool, {
			sourceId: story.sourceId,
			stepName: STEP_NAME,
			status: 'completed',
			configHash: stepConfigHash,
		});

		await updateStoryStatus(pool, input.storyId, 'embedded');

		return {
			status: 'success',
			data: {
				storyId: input.storyId,
				chunksCreated: 0,
				questionsGenerated: 0,
				embeddingsCreated: 0,
			},
			errors: [],
			metadata: {
				duration_ms: durationMs,
				items_processed: 0,
				items_skipped: 0,
				items_cached: 0,
			},
		};
	}

	// 8. Persist content chunks (without embeddings)
	let contentChunks: Chunk[];
	try {
		const chunkInputs = semanticChunks.map((sc) => {
			const metadata: Record<string, unknown> = { ...sc.metadata };
			return {
				storyId: input.storyId,
				content: sc.content,
				chunkIndex: sc.chunkIndex,
				pageStart: sc.pageStart,
				pageEnd: sc.pageEnd,
				isQuestion: false,
				metadata,
			};
		});
		contentChunks = await createChunks(pool, chunkInputs);
	} catch (cause: unknown) {
		const message = cause instanceof Error ? cause.message : String(cause);
		throw new EmbedError(`Failed to persist content chunks: ${message}`, EMBED_ERROR_CODES.EMBED_CHUNK_WRITE_FAILED, {
			cause,
			context: { storyId: input.storyId },
		});
	}

	log.debug({ contentChunksCreated: contentChunks.length }, 'Content chunks persisted');

	// 9. Embed content chunks
	const contentChunkInputs: EmbedChunkInput[] = contentChunks.map((c) => ({
		chunkId: c.id,
		content: c.content,
		chunkIndex: c.chunkIndex,
	}));

	let contentEmbeddingCount = 0;
	try {
		const embeddingResults = await embedChunks(services.embedding, contentChunkInputs, batchSize);

		// 10. Update chunk embeddings
		for (const result of embeddingResults) {
			await updateChunkEmbedding(pool, result.chunkId, result.embedding);
			contentEmbeddingCount++;
		}
	} catch (cause: unknown) {
		const message = cause instanceof Error ? cause.message : String(cause);
		throw new EmbedError(`Failed to embed content chunks: ${message}`, EMBED_ERROR_CODES.EMBED_EMBEDDING_FAILED, {
			cause,
			context: { storyId: input.storyId },
		});
	}

	log.debug({ contentEmbeddingCount }, 'Content chunk embeddings stored');

	// 11. Generate questions (non-fatal)
	let totalQuestionsGenerated = 0;
	let questionEmbeddingCount = 0;

	try {
		const questionResults = await generateQuestions(services.llm, contentChunkInputs, questionsPerChunk);

		// 12. Persist question chunks
		const questionChunkInputs: CreateChunkInput[] = [];
		let questionChunkIndex = 0;

		for (const qr of questionResults) {
			for (const question of qr.questions) {
				questionChunkInputs.push({
					storyId: input.storyId,
					content: question,
					chunkIndex: questionChunkIndex++,
					pageStart: null,
					pageEnd: null,
					isQuestion: true,
					parentChunkId: qr.parentChunkId,
					metadata: {},
				});
				totalQuestionsGenerated++;
			}
		}

		if (questionChunkInputs.length > 0) {
			const questionChunks = await createChunks(pool, questionChunkInputs);

			// 13. Embed question chunks
			const questionEmbedInputs: EmbedChunkInput[] = questionChunks.map((c) => ({
				chunkId: c.id,
				content: c.content,
				chunkIndex: c.chunkIndex,
			}));

			const questionEmbeddingResults = await embedChunks(services.embedding, questionEmbedInputs, batchSize);

			for (const result of questionEmbeddingResults) {
				await updateChunkEmbedding(pool, result.chunkId, result.embedding);
				questionEmbeddingCount++;
			}
		}
	} catch (cause: unknown) {
		// Question generation failures are non-fatal
		const message = cause instanceof Error ? cause.message : String(cause);
		errors.push({
			code: EMBED_ERROR_CODES.EMBED_QUESTION_GENERATION_FAILED,
			message: `Question generation failed: ${message}`,
		});
		log.warn({ err: cause }, 'Question generation failed — continuing with content chunks only');
	}

	// 14. Determine overall status
	const totalEmbeddings = contentEmbeddingCount + questionEmbeddingCount;
	let status: 'success' | 'partial' | 'failed';
	if (errors.length === 0) {
		status = 'success';
	} else if (contentEmbeddingCount > 0) {
		status = 'partial';
	} else {
		status = 'failed';
	}

	// 15. Update story status + source step
	if (status !== 'failed') {
		await updateStoryStatus(pool, input.storyId, 'embedded');
		await upsertSourceStep(pool, {
			sourceId: story.sourceId,
			stepName: STEP_NAME,
			status: 'completed',
			configHash: stepConfigHash,
		});
	} else {
		await upsertSourceStep(pool, {
			sourceId: story.sourceId,
			stepName: STEP_NAME,
			status: 'failed',
			configHash: stepConfigHash,
		});
	}

	// 16. Firestore observability (fire-and-forget)
	services.firestore
		.setDocument('stories', input.storyId, {
			status: status !== 'failed' ? 'embedded' : 'failed',
			embeddedAt: new Date().toISOString(),
			chunksCreated: contentChunks.length,
			questionsGenerated: totalQuestionsGenerated,
			embeddingsCreated: totalEmbeddings,
		})
		.catch(() => {
			// Silently swallow — Firestore is best-effort observability
		});

	const durationMs = Math.round(performance.now() - startTime);
	const embeddingData: EmbeddingData = {
		storyId: input.storyId,
		chunksCreated: contentChunks.length,
		questionsGenerated: totalQuestionsGenerated,
		embeddingsCreated: totalEmbeddings,
	};

	log.info(
		{
			status,
			chunksCreated: contentChunks.length,
			questionsGenerated: totalQuestionsGenerated,
			embeddingsCreated: totalEmbeddings,
			errors: errors.length,
			duration_ms: durationMs,
		},
		'Embed step completed',
	);

	// 17. Return EmbedResult
	return {
		status,
		data: embeddingData,
		errors,
		metadata: {
			duration_ms: durationMs,
			items_processed: contentChunks.length,
			items_skipped: 0,
			items_cached: 0,
		},
	};
}

export { forceCleanupSource };
