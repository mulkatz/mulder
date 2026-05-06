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
import type {
	DocumentQualityAssessment,
	KnowledgeAssertion,
	Logger,
	MulderConfig,
	SensitivityLevel,
	SensitivityMetadata,
	Services,
	StepError,
} from '@mulder/core';
import {
	createChildLogger,
	defaultSensitivityMetadata,
	deleteConflictNodesForStory,
	deleteEdgesByStoryId,
	deleteKnowledgeAssertionsForStory,
	deleteStoryEntitiesByStoryId,
	ENRICH_ERROR_CODES,
	EnrichError,
	findLatestDocumentQualityAssessment,
	findStoryById,
	getStepConfigHash,
	linkStoryEntity,
	mapSensitivityMetadataToDb,
	mergeSensitivityMetadata,
	normalizeConfidenceMetadata,
	normalizeSensitivityMetadata,
	provenanceForSource,
	renderPrompt,
	resetPipelineStep,
	updateEntity,
	updateSourceSensitivityFromArtifacts,
	updateStorySensitivityFromArtifacts,
	updateStoryStatus,
	upsertEdge,
	upsertEntityByNameType,
	upsertKnowledgeAssertion,
	upsertSourceStep,
} from '@mulder/core';
import { normalizeTaxonomy } from '@mulder/taxonomy';
import type pg from 'pg';
import { detectAssertionConflicts } from './conflicts.js';
import { generateSourceCredibilityProfileDraft } from './credibility.js';
import { resolveEntity } from './resolution.js';
import { generateExtractionSchema, getExtractionResponseSchema } from './schema.js';
import type {
	EnrichInput,
	EnrichmentData,
	EnrichResult,
	ExtractedSensitivityMetadata,
	ExtractionResponse,
} from './types.js';

export type { AssertionConflictDetectionResult } from './conflicts.js';
export { detectAssertionConflicts } from './conflicts.js';
export type { CredibilityProfileGenerationResult, CredibilityProfileGenerationStatus } from './credibility.js';
export { generateSourceCredibilityProfileDraft } from './credibility.js';
export { resolveEntity } from './resolution.js';
export type {
	ResolutionCandidate,
	ResolutionResult,
	ResolutionTier,
	ResolveEntityOptions,
} from './resolution-types.js';
export type { ExtractionSchemaOptions } from './schema.js';
export {
	generateExtractionSchema,
	getEntityTypeNames,
	getExtractionResponseSchema,
} from './schema.js';
export type {
	EnrichInput,
	EnrichmentData,
	EnrichResult,
	ExtractedAssertion,
	ExtractedEntity,
	ExtractedRelationship,
	ExtractedSensitivityMetadata,
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

/**
 * Conservative chars-per-token ratio used for *paragraph-level* sizing
 * inside `preChunkMarkdown`. The top-level token-budget check uses the
 * real tokenizer via `LlmService.countTokens`; this ratio only governs
 * how aggressively we split paragraphs into pre-chunks. Set to 2 (instead
 * of the more common 4) so non-Latin scripts produce smaller chunks
 * rather than larger ones — over-splitting is harmless, under-splitting
 * risks Gemini truncating mid-JSON.
 */
const PARAGRAPH_CHARS_PER_TOKEN = 2;

// ────────────────────────────────────────────────────────────
// Paragraph-level token estimation (for chunk sizing only)
// ────────────────────────────────────────────────────────────

function estimateParagraphTokens(text: string): number {
	return Math.ceil(text.length / PARAGRAPH_CHARS_PER_TOKEN);
}

function buildAssertionQualityMetadata(assessment: DocumentQualityAssessment | null): Record<string, unknown> | null {
	if (!assessment) {
		return null;
	}

	return {
		document_quality_assessment_id: assessment.id,
		overall_quality: assessment.overallQuality,
		processable: assessment.processable,
		recommended_path: assessment.recommendedPath,
		assessed_at: assessment.assessedAt.toISOString(),
	};
}

function mapAssertionEntityIds(
	entityNames: readonly string[] | undefined,
	entityNameToId: Map<string, string>,
): string[] {
	if (!entityNames) {
		return [];
	}

	const entityIds = new Set<string>();
	for (const entityName of entityNames) {
		const id = entityNameToId.get(entityName.trim());
		if (id) {
			entityIds.add(id);
		}
	}
	return [...entityIds].sort();
}

function toExtractedSensitivityMetadata(value: unknown, fallbackLevel: SensitivityLevel): ExtractedSensitivityMetadata {
	const metadata = normalizeSensitivityMetadata(value, fallbackLevel);
	const dbMetadata = mapSensitivityMetadataToDb(metadata);
	return {
		level: metadata.level,
		reason: metadata.reason,
		assigned_by: metadata.assignedBy,
		assigned_at: metadata.assignedAt,
		pii_types: metadata.piiTypes,
		declassify_date: typeof dbMetadata.declassify_date === 'string' ? dbMetadata.declassify_date : null,
	};
}

function mergeExtractedSensitivity(
	items: readonly (ExtractedSensitivityMetadata | undefined)[],
	fallbackLevel: SensitivityLevel,
): ExtractedSensitivityMetadata {
	return toExtractedSensitivityMetadata(mergeSensitivityMetadata(items, fallbackLevel), fallbackLevel);
}

function detectedSensitivityMetadata(value: unknown, fallbackLevel: SensitivityLevel): SensitivityMetadata {
	const metadata = normalizeSensitivityMetadata(value, fallbackLevel);
	return {
		...metadata,
		assignedBy: 'llm_auto',
	};
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
		const paragraphTokens = estimateParagraphTokens(paragraph);

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
	const relationshipMap = new Map<string, ExtractionResponse['relationships'][0]>();
	const assertionMap = new Map<string, NonNullable<ExtractionResponse['assertions']>[0]>();

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
					sensitivity: mergeExtractedSensitivity([existing.sensitivity, entity.sensitivity], 'internal'),
				});
			} else {
				entityMap.set(key, entity);
			}
		}

		for (const rel of response.relationships) {
			const key = `${rel.source_entity}:${rel.target_entity}:${rel.relationship_type}`;
			const existing = relationshipMap.get(key);
			if (existing) {
				relationshipMap.set(key, {
					...existing,
					confidence: Math.max(existing.confidence, rel.confidence),
					attributes: { ...(existing.attributes ?? {}), ...(rel.attributes ?? {}) },
					sensitivity: mergeExtractedSensitivity([existing.sensitivity, rel.sensitivity], 'internal'),
				});
			} else {
				relationshipMap.set(key, rel);
			}
		}

		for (const assertion of response.assertions ?? []) {
			const key = `${assertion.assertion_type}:${assertion.content}`;
			const existing = assertionMap.get(key);
			if (existing) {
				assertionMap.set(key, {
					...existing,
					entity_names: [...new Set([...(existing.entity_names ?? []), ...(assertion.entity_names ?? [])])].sort(),
					sensitivity: mergeExtractedSensitivity([existing.sensitivity, assertion.sensitivity], 'internal'),
				});
			} else {
				assertionMap.set(key, assertion);
			}
		}
	}

	const merged: ExtractionResponse = {
		entities: [...entityMap.values()],
		relationships: [...relationshipMap.values()],
	};
	if (assertionMap.size > 0) {
		merged.assertions = [...assertionMap.values()];
	}
	return merged;
}

// ────────────────────────────────────────────────────────────
// Force cleanup
// ────────────────────────────────────────────────────────────

/**
 * Cleans up existing enrichment artifacts for a single story.
 * Deletes story_entities and entity_edges, resets story status to segmented.
 */
async function forceCleanupStory(storyId: string, pool: pg.Pool, logger: Logger): Promise<void> {
	const deletedConflicts = await deleteConflictNodesForStory(pool, storyId);
	const deletedAssertions = await deleteKnowledgeAssertionsForStory(pool, storyId);
	const deletedLinks = await deleteStoryEntitiesByStoryId(pool, storyId);
	const deletedEdges = await deleteEdgesByStoryId(pool, storyId);
	await updateStoryStatus(pool, storyId, 'segmented');
	logger.debug(
		{ storyId, deletedConflicts, deletedAssertions, deletedLinks, deletedEdges },
		'Force cleanup complete for story',
	);
}

/**
 * Cleans up existing enrichment artifacts for all stories of a source.
 * Deletes story_entities and entity_edges, resets story statuses to segmented.
 */
async function forceCleanupSource(sourceId: string, pool: pg.Pool, logger: Logger): Promise<void> {
	await resetPipelineStep(pool, sourceId, 'enrich');
	logger.info({ sourceId }, 'Force cleanup complete — stories reset to segmented');
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
	const stepConfigHash = getStepConfigHash(config, STEP_NAME);

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
	const artifactProvenance = provenanceForSource(story.sourceId, input.extractionPipelineRun ?? null);
	const assertionClassificationConfig = config.enrichment.assertion_classification;
	const assertionClassificationEnabled = assertionClassificationConfig.enabled;
	const sensitivityConfig = config.access_control.sensitivity;
	const defaultSensitivityLevel = sensitivityConfig.default_level;
	const sensitivityAutoDetectionEnabled = config.access_control.enabled && sensitivityConfig.auto_detection;
	const defaultSensitivity = defaultSensitivityMetadata(defaultSensitivityLevel, {
		assignedBy: 'policy_rule',
		reason: 'default_policy',
	});
	const latestQualityAssessment = assertionClassificationEnabled
		? await findLatestDocumentQualityAssessment(pool, story.sourceId)
		: null;
	const assertionQualityMetadata = buildAssertionQualityMetadata(latestQualityAssessment);

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

	// 5. Token count check (real tokenizer) and pre-chunking
	const maxTokens = config.enrichment?.max_story_tokens ?? DEFAULT_MAX_STORY_TOKENS;
	const tokenCount = await services.llm.countTokens(markdown);
	const needsChunking = tokenCount > maxTokens;

	const textChunks = needsChunking ? preChunkMarkdown(markdown, TARGET_CHUNK_TOKENS) : [markdown];

	log.debug(
		{
			tokenCount,
			maxTokens,
			needsChunking,
			chunkCount: textChunks.length,
		},
		'Token count complete',
	);

	// 6. Generate JSON Schema from ontology
	const ontology = config.ontology;
	const extractionSchemaOptions = {
		assertionClassificationEnabled,
		sensitivityAutoDetectionEnabled,
		sensitivityLevels: sensitivityConfig.levels,
		piiTypes: sensitivityConfig.pii_types,
	};
	const jsonSchema = generateExtractionSchema(ontology, extractionSchemaOptions);
	const responseSchema = getExtractionResponseSchema(ontology, extractionSchemaOptions);

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
			sensitivity_auto_detection: sensitivityAutoDetectionEnabled ? 'true' : 'false',
			sensitivity_levels: sensitivityConfig.levels.join(', '),
			sensitivity_default_level: defaultSensitivityLevel,
			sensitivity_pii_types: sensitivityConfig.pii_types.join(', '),
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
			configHash: stepConfigHash,
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
			assertions: extraction.assertions?.length ?? 0,
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

	// 11. Process each entity: normalize taxonomy, upsert with link, resolve, link to story
	const normalizationThreshold = config.taxonomy?.normalization_threshold ?? 0.4;
	let entitiesResolved = 0;
	let taxonomyEntriesAdded = 0;
	let taxonomyLinked = 0;

	/** Map from entity name to entity ID for relationship resolution. */
	const entityNameToId = new Map<string, string>();

	for (const extracted of sortedEntities) {
		try {
			const sensitivityMetadata = sensitivityAutoDetectionEnabled
				? detectedSensitivityMetadata(extracted.sensitivity, defaultSensitivityLevel)
				: defaultSensitivity;
			// 11a. Taxonomy normalization (must run before upsert so the
			// resulting entity row carries the canonical taxonomy_id from
			// the start; cross-story queries can then group entities that
			// share the same canonical reference).
			const normResult = await normalizeTaxonomy(pool, extracted.name, extracted.type, normalizationThreshold);
			if (normResult.action === 'created') {
				taxonomyEntriesAdded++;
			}

			// 11b. Upsert entity with the taxonomy link populated.
			const entity = await upsertEntityByNameType(pool, {
				name: extracted.name,
				type: extracted.type,
				attributes: extracted.attributes,
				taxonomyId: normResult.taxonomyEntry.id,
				provenance: artifactProvenance,
				sensitivityLevel: sensitivityMetadata.level,
				sensitivityMetadata,
			});
			entityNameToId.set(extracted.name, entity.id);
			if (entity.taxonomyId) {
				taxonomyLinked++;
			}

			// 11c. Cross-lingual entity resolution
			let wasMerged = false;
			if (config.entity_resolution) {
				const resolution = await resolveEntity({
					entity,
					pool,
					services,
					config: config.entity_resolution,
					provenance: artifactProvenance,
				});

				if (resolution.action === 'merged') {
					entitiesResolved++;
					wasMerged = true;
					// Update the name-to-ID mapping to point to the canonical entity
					entityNameToId.set(extracted.name, resolution.canonicalEntity.id);
				}
			}

			// Set canonical_id to self if not merged (self-canonical)
			if (!wasMerged && entity.canonicalId === null) {
				await updateEntity(pool, entity.id, { canonicalId: entity.id, provenance: artifactProvenance });
			}

			// 11d. Link entity to story
			await linkStoryEntity(pool, {
				storyId: input.storyId,
				entityId: entityNameToId.get(extracted.name) ?? entity.id,
				confidence: extracted.confidence,
				mentionCount: extracted.mentions.length,
				provenance: artifactProvenance,
				sensitivityLevel: sensitivityMetadata.level,
				sensitivityMetadata,
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
			const sensitivityMetadata = sensitivityAutoDetectionEnabled
				? detectedSensitivityMetadata(rel.sensitivity, defaultSensitivityLevel)
				: defaultSensitivity;
			await upsertEdge(pool, {
				sourceEntityId,
				targetEntityId,
				relationship: rel.relationship_type,
				confidence: rel.confidence,
				storyId: input.storyId,
				edgeType: 'RELATIONSHIP',
				attributes: rel.attributes ?? {},
				provenance: artifactProvenance,
				sensitivityLevel: sensitivityMetadata.level,
				sensitivityMetadata,
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

	// 13. Persist classified assertions after resolved entity IDs are known.
	let assertionsPersisted = 0;
	const persistedAssertions: KnowledgeAssertion[] = [];

	if (assertionClassificationEnabled) {
		for (const assertion of extraction.assertions ?? []) {
			const content = assertion.content.trim();
			if (content.length === 0) {
				continue;
			}

			try {
				const sensitivityMetadata = sensitivityAutoDetectionEnabled
					? detectedSensitivityMetadata(assertion.sensitivity, defaultSensitivityLevel)
					: defaultSensitivity;
				const persistedAssertion = await upsertKnowledgeAssertion(pool, {
					sourceId: story.sourceId,
					storyId: input.storyId,
					assertionType: assertion.assertion_type,
					content,
					confidenceMetadata: normalizeConfidenceMetadata(assertion.confidence_metadata),
					classificationProvenance:
						assertion.classification_provenance ?? assertionClassificationConfig.default_provenance,
					extractedEntityIds: mapAssertionEntityIds(assertion.entity_names, entityNameToId),
					provenance: artifactProvenance,
					qualityMetadata: assertionQualityMetadata,
					sensitivityLevel: sensitivityMetadata.level,
					sensitivityMetadata,
				});
				persistedAssertions.push(persistedAssertion);
				assertionsPersisted++;
			} catch (cause: unknown) {
				const message = cause instanceof Error ? cause.message : String(cause);
				errors.push({
					code: ENRICH_ERROR_CODES.ENRICH_ENTITY_WRITE_FAILED,
					message: `Failed to persist assertion "${content}": ${message}`,
				});
				log.warn({ assertionType: assertion.assertion_type, err: cause }, 'Failed to persist assertion');
			}
		}
	}

	const conflictDetectionResult =
		persistedAssertions.length > 0
			? await detectAssertionConflicts({
					storyId: input.storyId,
					assertions: persistedAssertions,
					config,
					services,
					pool,
					logger: log,
				})
			: { candidatesExamined: 0, conflictsCreated: 0, skipped: 0, failures: 0, errors: [] };
	errors.push(...conflictDetectionResult.errors);

	// 14. Determine overall status
	const entitiesExtracted = sortedEntities.length;
	let status: 'success' | 'partial' | 'failed';
	if (errors.length === 0) {
		status = 'success';
	} else if (entityNameToId.size > 0) {
		status = 'partial';
	} else {
		status = 'failed';
	}

	// 15. Update story status + source step
	let credibilityProfileCreated = false;
	let credibilityProfileStatus: EnrichmentData['credibilityProfileStatus'] = 'skipped';

	if (status !== 'failed') {
		if (sensitivityConfig.propagation === 'upward') {
			await updateStorySensitivityFromArtifacts(pool, input.storyId);
			await updateSourceSensitivityFromArtifacts(pool, story.sourceId);
		}
		await updateStoryStatus(pool, input.storyId, 'enriched');

		const credibilityResult = await generateSourceCredibilityProfileDraft({
			sourceId: story.sourceId,
			config: config.credibility,
			services,
			pool,
			logger: log,
		});
		credibilityProfileCreated = credibilityResult.created;
		credibilityProfileStatus = credibilityResult.status;

		let credibilityErrorMessage: string | undefined;
		if (credibilityResult.status === 'failed') {
			credibilityErrorMessage = `Source credibility draft generation failed: ${
				credibilityResult.reason ?? 'unknown error'
			}`;
			errors.push({
				code: ENRICH_ERROR_CODES.ENRICH_LLM_FAILED,
				message: credibilityErrorMessage,
			});
			log.warn(
				{ sourceId: story.sourceId, reason: credibilityResult.reason },
				'Source credibility draft generation failed non-fatally',
			);
		}

		await upsertSourceStep(pool, {
			sourceId: story.sourceId,
			stepName: STEP_NAME,
			status: credibilityResult.status === 'failed' ? 'partial' : 'completed',
			configHash: stepConfigHash,
			errorMessage: credibilityErrorMessage,
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
			status: status !== 'failed' ? 'enriched' : 'failed',
			enrichedAt: new Date().toISOString(),
			entitiesExtracted,
			entitiesResolved,
			relationshipsCreated,
			assertionsPersisted,
			conflictsCreated: conflictDetectionResult.conflictsCreated,
			credibilityProfileCreated,
			credibilityProfileStatus,
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
		assertionsPersisted,
		conflictCandidatesExamined: conflictDetectionResult.candidatesExamined,
		conflictsCreated: conflictDetectionResult.conflictsCreated,
		conflictDetectionsSkipped: conflictDetectionResult.skipped,
		conflictDetectionFailures: conflictDetectionResult.failures,
		taxonomyEntriesAdded,
		taxonomyLinked,
		credibilityProfileCreated,
		credibilityProfileStatus,
		chunksUsed: textChunks.length,
	};

	log.info(
		{
			status,
			entitiesExtracted,
			entitiesResolved,
			relationshipsCreated,
			assertionsPersisted,
			conflictsCreated: conflictDetectionResult.conflictsCreated,
			conflictDetectionFailures: conflictDetectionResult.failures,
			taxonomyEntriesAdded,
			taxonomyLinked,
			credibilityProfileCreated,
			credibilityProfileStatus,
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
