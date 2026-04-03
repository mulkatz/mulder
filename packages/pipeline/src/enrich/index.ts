/**
 * Enrich pipeline step — the fourth pipeline step that extracts entities
 * and relationships from stories using Gemini structured output, normalizes
 * them against the taxonomy (pg_trgm), resolves cross-document entity
 * matches (3-tier), and writes results to PostgreSQL.
 *
 * Orchestrates existing building blocks: JSON Schema generator (spec 26),
 * taxonomy normalization (spec 27), cross-lingual entity resolution (spec 28).
 *
 * @see docs/specs/29_enrich_step.spec.md
 * @see docs/functional-spec.md §2.4
 */

import { performance } from 'node:perf_hooks';
import type { Logger, MulderConfig, Services, StepError } from '@mulder/core';
import {
	createChildLogger,
	deleteEdgesByStoryId,
	deleteSourceStep,
	deleteStoryEntitiesBySourceId,
	deleteStoryEntitiesByStoryId,
	ENRICH_ERROR_CODES,
	EnrichError,
	findStoriesBySourceId,
	findStoryById,
	linkStoryEntity,
	renderPrompt,
	updateStoryStatus,
	upsertEdge,
	upsertEntityByNameType,
	upsertSourceStep,
} from '@mulder/core';
import { normalizeTaxonomy } from '@mulder/taxonomy';
import type pg from 'pg';
import { resolveEntity } from './resolution.js';
import { generateExtractionSchema, getExtractionResponseSchema } from './schema.js';
import type { EnrichInput, EnrichmentData, EnrichResult, ExtractionResponse } from './types.js';

export { resolveEntity } from './resolution.js';
export type {
	ResolutionCandidate,
	ResolutionResult,
	ResolutionTier,
	ResolveEntityOptions,
} from './resolution-types.js';
export {
	generateExtractionSchema,
	getEntityTypeNames,
	getExtractionResponseSchema,
} from './schema.js';
export type {
	EnrichInput,
	EnrichmentData,
	EnrichResult,
	ExtractedEntity,
	ExtractedRelationship,
	ExtractionResponse,
} from './types.js';

// ────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────

const STEP_NAME = 'enrich';

/** Default max tokens per story before pre-chunking kicks in. */
const DEFAULT_MAX_STORY_TOKENS = 15_000;

/** Target tokens per pre-chunk. */
const TARGET_CHUNK_TOKENS = 10_000;

/** Rough character-to-token ratio. */
const CHARS_PER_TOKEN = 4;

// ────────────────────────────────────────────────────────────
// Token estimation
// ────────────────────────────────────────────────────────────

/**
 * Estimates the token count for a text string using a character-based
 * approximation (chars / 4). The LlmService interface does not expose
 * a `countTokens` method, so this is the fallback per spec §4.4.
 */
function estimateTokens(text: string): number {
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

// ────────────────────────────────────────────────────────────
// Pre-chunking
// ────────────────────────────────────────────────────────────

/**
 * Splits story Markdown at paragraph boundaries into chunks of
 * approximately `targetTokens` tokens each.
 *
 * Paragraphs are never split — if a single paragraph exceeds the
 * target, it becomes its own chunk.
 */
function preChunkMarkdown(markdown: string, targetTokens: number): string[] {
	const paragraphs = markdown.split(/\n\n+/);
	const chunks: string[] = [];
	let currentChunk: string[] = [];
	let currentTokens = 0;

	for (const paragraph of paragraphs) {
		const paragraphTokens = estimateTokens(paragraph);

		if (currentTokens + paragraphTokens > targetTokens && currentChunk.length > 0) {
			chunks.push(currentChunk.join('\n\n'));
			currentChunk = [];
			currentTokens = 0;
		}

		currentChunk.push(paragraph);
		currentTokens += paragraphTokens;
	}

	if (currentChunk.length > 0) {
		chunks.push(currentChunk.join('\n\n'));
	}

	return chunks;
}

// ────────────────────────────────────────────────────────────
// Extraction deduplication (for pre-chunked stories)
// ────────────────────────────────────────────────────────────

/**
 * Merges extraction results from multiple pre-chunks into a single
 * deduplicated extraction response. Deduplicates entities by (type, name)
 * and relationships by (source, target, type).
 */
function mergeExtractionResponses(responses: ExtractionResponse[]): ExtractionResponse {
	const entityMap = new Map<string, ExtractionResponse['entities'][0]>();
	const relationshipSet = new Set<string>();
	const mergedRelationships: ExtractionResponse['relationships'] = [];

	for (const response of responses) {
		for (const entity of response.entities) {
			const key = `${entity.type}:${entity.name}`;
			const existing = entityMap.get(key);
			if (existing) {
				// Merge mentions and keep highest confidence
				const mergedMentions = [...new Set([...existing.mentions, ...entity.mentions])];
				entityMap.set(key, {
					...existing,
					confidence: Math.max(existing.confidence, entity.confidence),
					mentions: mergedMentions,
					attributes: { ...existing.attributes, ...entity.attributes },
				});
			} else {
				entityMap.set(key, entity);
			}
		}

		for (const rel of response.relationships) {
			const key = `${rel.source_entity}:${rel.target_entity}:${rel.relationship_type}`;
			if (!relationshipSet.has(key)) {
				relationshipSet.add(key);
				mergedRelationships.push(rel);
			}
		}
	}

	return {
		entities: [...entityMap.values()],
		relationships: mergedRelationships,
	};
}

// ────────────────────────────────────────────────────────────
// Force cleanup
// ────────────────────────────────────────────────────────────

/**
 * Cleans up existing enrichment artifacts for a single story.
 * Deletes story_entities and entity_edges, resets story status to segmented.
 */
async function forceCleanupStory(storyId: string, pool: pg.Pool, logger: Logger): Promise<void> {
	const deletedLinks = await deleteStoryEntitiesByStoryId(pool, storyId);
	const deletedEdges = await deleteEdgesByStoryId(pool, storyId);
	await updateStoryStatus(pool, storyId, 'segmented');
	logger.debug({ storyId, deletedLinks, deletedEdges }, 'Force cleanup complete for story');
}

/**
 * Cleans up existing enrichment artifacts for all stories of a source.
 * Deletes story_entities and entity_edges, resets story statuses to segmented.
 */
async function forceCleanupSource(sourceId: string, pool: pg.Pool, logger: Logger): Promise<void> {
	const stories = await findStoriesBySourceId(pool, sourceId);
	const deletedLinks = await deleteStoryEntitiesBySourceId(pool, sourceId);

	let totalDeletedEdges = 0;
	for (const story of stories) {
		const deletedEdges = await deleteEdgesByStoryId(pool, story.id);
		totalDeletedEdges += deletedEdges;
		await updateStoryStatus(pool, story.id, 'segmented');
	}

	await deleteSourceStep(pool, sourceId, STEP_NAME);

	logger.info(
		{ sourceId, stories: stories.length, deletedLinks, deletedEdges: totalDeletedEdges },
		'Force cleanup complete for source',
	);
}

// ────────────────────────────────────────────────────────────
// Main execute function
// ────────────────────────────────────────────────────────────

/**
 * Executes the enrich pipeline step for a single story.
 *
 * Loads story Markdown from GCS, extracts entities and relationships
 * via Gemini structured output, normalizes against taxonomy, resolves
 * cross-document entity matches, and writes results to PostgreSQL.
 *
 * @param input - Enrich input (storyId, force)
 * @param config - Validated Mulder configuration
 * @param services - Service registry (storage, llm, embedding, firestore)
 * @param pool - PostgreSQL connection pool
 * @param logger - Logger instance
 * @returns Enrich result
 */
export async function execute(
	input: EnrichInput,
	config: MulderConfig,
	services: Services,
	pool: pg.Pool | undefined,
	logger: Logger,
): Promise<EnrichResult> {
	const log = createChildLogger(logger, { step: STEP_NAME, storyId: input.storyId });
	const startTime = performance.now();

	log.info({ force: input.force ?? false }, 'Enrich step started');

	if (!pool) {
		throw new EnrichError('Database pool is required for enrich step', ENRICH_ERROR_CODES.ENRICH_STORY_NOT_FOUND, {
			context: { storyId: input.storyId },
		});
	}

	// 1. Load story from DB
	const story = await findStoryById(pool, input.storyId);
	if (!story) {
		throw new EnrichError(`Story not found: ${input.storyId}`, ENRICH_ERROR_CODES.ENRICH_STORY_NOT_FOUND, {
			context: { storyId: input.storyId },
		});
	}

	// 2. Validate status — must be at least "segmented"
	const validStatuses = ['segmented', 'enriched', 'embedded', 'graphed', 'analyzed'];
	if (!validStatuses.includes(story.status)) {
		throw new EnrichError(
			`Story ${input.storyId} has invalid status "${story.status}" for enrichment — must be at least "segmented"`,
			ENRICH_ERROR_CODES.ENRICH_INVALID_STATUS,
			{ context: { storyId: input.storyId, status: story.status } },
		);
	}

	// Already enriched (or beyond) and no --force? Skip.
	if (story.status !== 'segmented' && !input.force) {
		log.info({ status: story.status }, 'Story already enriched — skipping (use --force to re-enrich)');
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

	// 3. Force cleanup if --force and already processed
	if (input.force && story.status !== 'segmented') {
		await forceCleanupStory(input.storyId, pool, log);
	}

	// 4. Load story Markdown from GCS
	let markdown: string;
	try {
		const buffer = await services.storage.download(story.gcsMarkdownUri);
		markdown = buffer.toString('utf-8');
	} catch (cause: unknown) {
		throw new EnrichError(
			`Story Markdown not found at ${story.gcsMarkdownUri} — has it been segmented?`,
			ENRICH_ERROR_CODES.ENRICH_MARKDOWN_NOT_FOUND,
			{ cause, context: { storyId: input.storyId, uri: story.gcsMarkdownUri } },
		);
	}

	// 5. Token count check and pre-chunking
	const maxTokens = config.enrichment?.max_story_tokens ?? DEFAULT_MAX_STORY_TOKENS;
	const estimatedTokens = estimateTokens(markdown);
	const needsChunking = estimatedTokens > maxTokens;

	const textChunks = needsChunking ? preChunkMarkdown(markdown, TARGET_CHUNK_TOKENS) : [markdown];

	log.debug(
		{
			estimatedTokens,
			maxTokens,
			needsChunking,
			chunkCount: textChunks.length,
		},
		'Token estimation complete',
	);

	// 6. Generate JSON Schema from ontology
	const ontology = config.ontology;
	const jsonSchema = generateExtractionSchema(ontology);
	const responseSchema = getExtractionResponseSchema(ontology);

	// 7. Build ontology description for the prompt
	const ontologyDescription = JSON.stringify(
		{
			entity_types: ontology.entity_types.map((et) => ({
				name: et.name,
				attributes: et.attributes.map((a) => ({ name: a.name, type: a.type })),
			})),
			relationships: ontology.relationships.map((r) => ({
				name: r.name,
				source: r.source,
				target: r.target,
			})),
		},
		null,
		2,
	);

	// 8. Extract entities from each chunk
	const errors: StepError[] = [];
	const chunkResponses: ExtractionResponse[] = [];
	const locale = config.project.supported_locales[0] ?? 'en';

	for (let i = 0; i < textChunks.length; i++) {
		const chunk = textChunks[i];

		const renderedPrompt = renderPrompt('extract-entities', {
			locale,
			ontology: ontologyDescription,
			story_text: chunk,
		});

		try {
			const response = await services.llm.generateStructured<ExtractionResponse>({
				prompt: renderedPrompt,
				schema: jsonSchema,
				responseValidator: (data) => responseSchema.parse(data),
			});
			chunkResponses.push(response);
		} catch (cause: unknown) {
			const message = cause instanceof Error ? cause.message : String(cause);
			errors.push({
				code: ENRICH_ERROR_CODES.ENRICH_LLM_FAILED,
				message: `LLM extraction failed for chunk ${i + 1}/${textChunks.length}: ${message}`,
			});
			log.warn({ chunk: i + 1, err: cause }, 'LLM extraction failed for chunk');
		}
	}

	// If all chunks failed, return failed
	if (chunkResponses.length === 0) {
		const durationMs = Math.round(performance.now() - startTime);
		log.error({ storyId: input.storyId }, 'All extraction chunks failed');

		await upsertSourceStep(pool, {
			sourceId: story.sourceId,
			stepName: STEP_NAME,
			status: 'failed',
		});

		return {
			status: 'failed',
			data: null,
			errors,
			metadata: {
				duration_ms: durationMs,
				items_processed: 0,
				items_skipped: 0,
				items_cached: 0,
			},
		};
	}

	// 9. Merge and deduplicate extraction results
	const extraction = mergeExtractionResponses(chunkResponses);

	log.info(
		{
			entities: extraction.entities.length,
			relationships: extraction.relationships.length,
			chunksUsed: textChunks.length,
			chunksSucceeded: chunkResponses.length,
		},
		'Extraction complete',
	);

	// 10. Sort entities lexicographically by (type, name) for deadlock prevention
	const sortedEntities = [...extraction.entities].sort((a, b) => {
		const typeCompare = a.type.localeCompare(b.type);
		if (typeCompare !== 0) return typeCompare;
		return a.name.localeCompare(b.name);
	});

	// 11. Process each entity: upsert, normalize, resolve, link
	const normalizationThreshold = config.taxonomy?.normalization_threshold ?? 0.4;
	let entitiesResolved = 0;
	let taxonomyEntriesAdded = 0;

	/** Map from entity name to entity ID for relationship resolution. */
	const entityNameToId = new Map<string, string>();

	for (const extracted of sortedEntities) {
		try {
			// 11a. Upsert entity
			const entity = await upsertEntityByNameType(pool, {
				name: extracted.name,
				type: extracted.type,
				attributes: extracted.attributes,
			});
			entityNameToId.set(extracted.name, entity.id);

			// 11b. Taxonomy normalization
			const normResult = await normalizeTaxonomy(pool, extracted.name, extracted.type, normalizationThreshold);
			if (normResult.action === 'created') {
				taxonomyEntriesAdded++;
			}

			// 11c. Cross-lingual entity resolution
			if (config.entity_resolution) {
				const resolution = await resolveEntity({
					entity,
					pool,
					services,
					config: config.entity_resolution,
				});

				if (resolution.action === 'merged') {
					entitiesResolved++;
					// Update the name-to-ID mapping to point to the canonical entity
					entityNameToId.set(extracted.name, resolution.canonicalEntity.id);
				}
			}

			// 11d. Link entity to story
			await linkStoryEntity(pool, {
				storyId: input.storyId,
				entityId: entityNameToId.get(extracted.name) ?? entity.id,
				confidence: extracted.confidence,
				mentionCount: extracted.mentions.length,
			});
		} catch (cause: unknown) {
			const message = cause instanceof Error ? cause.message : String(cause);
			errors.push({
				code: ENRICH_ERROR_CODES.ENRICH_ENTITY_WRITE_FAILED,
				message: `Failed to process entity "${extracted.name}" (${extracted.type}): ${message}`,
			});
			log.warn({ entityName: extracted.name, entityType: extracted.type, err: cause }, 'Failed to process entity');
		}
	}

	// 12. Process relationships
	let relationshipsCreated = 0;

	for (const rel of extraction.relationships) {
		const sourceEntityId = entityNameToId.get(rel.source_entity);
		const targetEntityId = entityNameToId.get(rel.target_entity);

		if (!sourceEntityId || !targetEntityId) {
			log.debug(
				{
					sourceEntity: rel.source_entity,
					targetEntity: rel.target_entity,
					relationship: rel.relationship_type,
				},
				'Skipping relationship — source or target entity not found',
			);
			continue;
		}

		try {
			await upsertEdge(pool, {
				sourceEntityId,
				targetEntityId,
				relationship: rel.relationship_type,
				confidence: rel.confidence,
				storyId: input.storyId,
				edgeType: 'RELATIONSHIP',
				attributes: rel.attributes ?? {},
			});
			relationshipsCreated++;
		} catch (cause: unknown) {
			const message = cause instanceof Error ? cause.message : String(cause);
			errors.push({
				code: ENRICH_ERROR_CODES.ENRICH_ENTITY_WRITE_FAILED,
				message: `Failed to create relationship ${rel.source_entity} -[${rel.relationship_type}]-> ${rel.target_entity}: ${message}`,
			});
			log.warn(
				{
					sourceEntity: rel.source_entity,
					targetEntity: rel.target_entity,
					relationship: rel.relationship_type,
					err: cause,
				},
				'Failed to create relationship edge',
			);
		}
	}

	// 13. Determine overall status
	const entitiesExtracted = sortedEntities.length;
	let status: 'success' | 'partial' | 'failed';
	if (errors.length === 0) {
		status = 'success';
	} else if (entityNameToId.size > 0) {
		status = 'partial';
	} else {
		status = 'failed';
	}

	// 14. Update story status + source step
	if (status !== 'failed') {
		await updateStoryStatus(pool, input.storyId, 'enriched');
		await upsertSourceStep(pool, {
			sourceId: story.sourceId,
			stepName: STEP_NAME,
			status: 'completed',
		});
	} else {
		await upsertSourceStep(pool, {
			sourceId: story.sourceId,
			stepName: STEP_NAME,
			status: 'failed',
		});
	}

	// 15. Firestore observability (fire-and-forget)
	services.firestore
		.setDocument('stories', input.storyId, {
			status: status !== 'failed' ? 'enriched' : 'failed',
			enrichedAt: new Date().toISOString(),
			entitiesExtracted,
			entitiesResolved,
			relationshipsCreated,
		})
		.catch(() => {
			// Silently swallow — Firestore is best-effort observability
		});

	const durationMs = Math.round(performance.now() - startTime);
	const enrichmentData: EnrichmentData = {
		storyId: input.storyId,
		entitiesExtracted,
		entitiesResolved,
		relationshipsCreated,
		taxonomyEntriesAdded,
		chunksUsed: textChunks.length,
	};

	log.info(
		{
			status,
			entitiesExtracted,
			entitiesResolved,
			relationshipsCreated,
			taxonomyEntriesAdded,
			chunksUsed: textChunks.length,
			errors: errors.length,
			duration_ms: durationMs,
		},
		'Enrich step completed',
	);

	return {
		status,
		data: enrichmentData,
		errors,
		metadata: {
			duration_ms: durationMs,
			items_processed: entitiesExtracted,
			items_skipped: 0,
			items_cached: 0,
		},
	};
}

export { forceCleanupSource };
