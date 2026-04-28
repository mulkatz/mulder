/**
 * Graph pipeline step — the seventh pipeline step that writes entity
 * relationship edges, detects near-duplicate stories, calculates
 * dedup-aware corroboration scores, and flags potential contradictions.
 *
 * The graph step is pure SQL/computation — no LLM calls.
 *
 * @see docs/specs/35_graph_step.spec.md
 * @see docs/functional-spec.md §2.7
 */

import { performance } from 'node:perf_hooks';
import type { Logger, MulderConfig, Services, StepError } from '@mulder/core';
import {
	createChildLogger,
	deleteEdgesByStoryId,
	findEntitiesByStoryId,
	findStoryById,
	GRAPH_ERROR_CODES,
	GraphError,
	getStepConfigHash,
	resetPipelineStep,
	updateStoryStatus,
	upsertEdge,
	upsertSourceStep,
} from '@mulder/core';
import type pg from 'pg';
import { detectContradictions } from './contradiction.js';
import { updateCorroborationScores } from './corroboration.js';
import { detectDuplicates } from './dedup.js';
import type { GraphData, GraphInput, GraphResult } from './types.js';

// Re-export types
export type {
	ContradictionCandidate,
	CorroborationResult,
	DuplicatePair,
	GraphData,
	GraphInput,
	GraphResult,
} from './types.js';

// ────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────

const STEP_NAME = 'graph';

// ────────────────────────────────────────────────────────────
// Force cleanup
// ────────────────────────────────────────────────────────────

/**
 * Cleans up existing graph artifacts for a single story.
 * Deletes all edges for the story, resets story status to embedded.
 */
async function forceCleanupStory(storyId: string, pool: pg.Pool, logger: Logger): Promise<void> {
	const deletedEdges = await deleteEdgesByStoryId(pool, storyId);
	await updateStoryStatus(pool, storyId, 'embedded');
	logger.debug({ storyId, deletedEdges }, 'Force cleanup complete for story');
}

/**
 * Cleans up existing graph artifacts for all stories of a source.
 * Uses resetPipelineStep which cascades: deletes edges, resets story statuses to embedded.
 */
export async function forceCleanupSource(sourceId: string, pool: pg.Pool, logger: Logger): Promise<void> {
	await resetPipelineStep(pool, sourceId, 'graph');
	logger.info({ sourceId }, 'Force cleanup complete — stories reset to embedded');
}

// ────────────────────────────────────────────────────────────
// Main execute function
// ────────────────────────────────────────────────────────────

/**
 * Executes the graph pipeline step for a single story.
 *
 * 1. Validates story status (must be >= embedded)
 * 2. Writes RELATIONSHIP edges from story_entities
 * 3. Runs deduplication via MinHash
 * 4. Computes dedup-aware corroboration scores
 * 5. Flags potential contradictions via attribute diff
 * 6. Updates story status to graphed
 *
 * @param input - Graph input (storyId, force)
 * @param config - Validated Mulder configuration
 * @param services - Service registry (firestore for observability)
 * @param pool - PostgreSQL connection pool
 * @param logger - Logger instance
 * @returns Graph result
 */
export async function execute(
	input: GraphInput,
	config: MulderConfig,
	services: Services,
	pool: pg.Pool | undefined,
	logger: Logger,
): Promise<GraphResult> {
	const log = createChildLogger(logger, { step: STEP_NAME, storyId: input.storyId });
	const startTime = performance.now();
	const stepConfigHash = getStepConfigHash(config, STEP_NAME);

	log.info({ force: input.force ?? false }, 'Graph step started');

	// 1. Validate pool exists
	if (!pool) {
		throw new GraphError('Database pool is required for graph step', GRAPH_ERROR_CODES.GRAPH_STORY_NOT_FOUND, {
			context: { storyId: input.storyId },
		});
	}

	// 2. Load story from DB
	const story = await findStoryById(pool, input.storyId);
	if (!story) {
		throw new GraphError(`Story not found: ${input.storyId}`, GRAPH_ERROR_CODES.GRAPH_STORY_NOT_FOUND, {
			context: { storyId: input.storyId },
		});
	}

	// 3. Validate status — must be at least "embedded"
	const validStatuses = ['embedded', 'graphed', 'analyzed'];
	if (!validStatuses.includes(story.status)) {
		throw new GraphError(
			`Story ${input.storyId} has invalid status "${story.status}" for graphing — must be at least "embedded"`,
			GRAPH_ERROR_CODES.GRAPH_INVALID_STATUS,
			{ context: { storyId: input.storyId, status: story.status } },
		);
	}

	// 4. Skip if already graphed (or beyond) and no --force
	if (story.status !== 'embedded' && !input.force) {
		log.info({ status: story.status }, 'Story already graphed — skipping (use --force to re-graph)');
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
	if (input.force && story.status !== 'embedded') {
		await forceCleanupStory(input.storyId, pool, log);
	}

	const errors: StepError[] = [];
	let edgesCreated = 0;
	let edgesUpdated = 0;
	let duplicatesFound = 0;
	let corroborationUpdates = 0;
	let contradictionsFlagged = 0;

	// 6. Write RELATIONSHIP edges from story_entities
	try {
		const entities = await findEntitiesByStoryId(pool, input.storyId);

		// Load relationships from entity_edges where the entities are involved
		// For each pair of entities in this story, create edges based on
		// their co-occurrence (they appear in the same story)
		const entityIds = entities.map((e) => e.id);

		if (entityIds.length >= 2) {
			// Check if there are already relationship edges from enrichment
			// The enrich step may have created relationships between entities.
			// We look for existing edges that reference entities from this story.
			const existingRelationships = await pool.query<{
				source_entity_id: string;
				target_entity_id: string;
				relationship: string;
				attributes: Record<string, unknown>;
				confidence: number | null;
			}>(
				`SELECT ee.source_entity_id, ee.target_entity_id, ee.relationship,
				        ee.attributes, ee.confidence
				 FROM entity_edges ee
				 WHERE ee.story_id = $1 AND ee.edge_type = 'RELATIONSHIP'`,
				[input.storyId],
			);

			// Re-upsert these to ensure idempotency
			for (const rel of existingRelationships.rows) {
				await upsertEdge(pool, {
					sourceEntityId: rel.source_entity_id,
					targetEntityId: rel.target_entity_id,
					relationship: rel.relationship,
					attributes: rel.attributes,
					confidence: rel.confidence ?? undefined,
					storyId: input.storyId,
					edgeType: 'RELATIONSHIP',
				});
				edgesUpdated++;
			}

			// Optional fallback: when no explicit enrich relationships exist,
			// fabricate an O(n²) co_occurs_with edge between every entity pair
			// in the story. Disabled by default because a 50-entity story
			// produces 1225 edges and a 100-entity story 4950 — signal-dilute
			// at archive scale. Enable only when a downstream consumer needs
			// co-occurrence data.
			if (config.graph.cooccurrence_fallback && existingRelationships.rows.length === 0) {
				for (let i = 0; i < entityIds.length; i++) {
					for (let j = i + 1; j < entityIds.length; j++) {
						await upsertEdge(pool, {
							sourceEntityId: entityIds[i],
							targetEntityId: entityIds[j],
							relationship: 'co_occurs_with',
							attributes: { generatedBy: 'graph.cooccurrence_fallback' },
							storyId: input.storyId,
							edgeType: 'RELATIONSHIP',
						});
						edgesCreated++;
					}
				}
			}
		}

		log.debug({ edgesCreated, edgesUpdated }, 'Relationship edges written');
	} catch (cause: unknown) {
		const message = cause instanceof Error ? cause.message : String(cause);
		errors.push({
			code: GRAPH_ERROR_CODES.GRAPH_EDGE_WRITE_FAILED,
			message: `Failed to write relationship edges: ${message}`,
		});
		log.warn({ err: cause }, 'Relationship edge writing failed — continuing');
	}

	// 7. Deduplication
	try {
		if (config.deduplication.enabled) {
			const threshold = config.deduplication.segment_level.similarity_threshold;
			const duplicates = await detectDuplicates(pool, input.storyId, threshold);

			for (const dup of duplicates) {
				// Find entities shared between the two stories to create the edge
				const entitiesA = await findEntitiesByStoryId(pool, dup.storyIdA);
				const entitiesB = await findEntitiesByStoryId(pool, dup.storyIdB);

				// Use the first shared entity for the edge, or the first entities from each
				const entityIdA = entitiesA[0]?.id;
				const entityIdB = entitiesB[0]?.id;

				if (entityIdA && entityIdB) {
					await upsertEdge(pool, {
						sourceEntityId: entityIdA,
						targetEntityId: entityIdB,
						relationship: `duplicate_${dup.duplicateType}`,
						attributes: {
							storyIdA: dup.storyIdA,
							storyIdB: dup.storyIdB,
							similarity: dup.similarity,
							duplicateType: dup.duplicateType,
						},
						confidence: dup.similarity,
						storyId: input.storyId,
						edgeType: 'DUPLICATE_OF',
					});
					duplicatesFound++;
				}
			}

			log.debug({ duplicatesFound }, 'Deduplication complete');
		} else {
			log.debug('Deduplication disabled in config — skipping');
		}
	} catch (cause: unknown) {
		const message = cause instanceof Error ? cause.message : String(cause);
		errors.push({
			code: GRAPH_ERROR_CODES.GRAPH_DEDUP_FAILED,
			message: `Deduplication failed: ${message}`,
		});
		log.warn({ err: cause }, 'Deduplication failed — continuing');
	}

	// 8. Corroboration scoring
	try {
		const corroborationResults = await updateCorroborationScores(pool, input.storyId, config.deduplication);
		corroborationUpdates = corroborationResults.length;
		log.debug({ corroborationUpdates }, 'Corroboration scores updated');
	} catch (cause: unknown) {
		const message = cause instanceof Error ? cause.message : String(cause);
		errors.push({
			code: GRAPH_ERROR_CODES.GRAPH_CORROBORATION_FAILED,
			message: `Corroboration scoring failed: ${message}`,
		});
		log.warn({ err: cause }, 'Corroboration scoring failed — continuing');
	}

	// 9. Contradiction detection
	try {
		const contradictions = await detectContradictions(pool, input.storyId);

		for (const contradiction of contradictions) {
			// Self-loop on the canonical entity. A "claim" here is the tuple
			// (entity_id, story_id) — claims are not first-class rows, so the
			// edge sits on the entity and the two conflicting claim story IDs
			// are encoded in attributes.storyIdA / attributes.storyIdB
			// alongside attribute / valueA / valueB. M6 G3 Analyze loads
			// these edges and reads the conflict directly from JSONB.
			// See docs/functional-spec.md §2.7 step 6.
			await upsertEdge(pool, {
				sourceEntityId: contradiction.entityId,
				targetEntityId: contradiction.entityId,
				relationship: `contradiction_${contradiction.attribute}`,
				attributes: {
					attribute: contradiction.attribute,
					valueA: contradiction.valueA,
					valueB: contradiction.valueB,
					storyIdA: contradiction.storyIdA,
					storyIdB: contradiction.storyIdB,
				},
				// confidence intentionally omitted — to be resolved by Analyze step
				storyId: input.storyId,
				edgeType: 'POTENTIAL_CONTRADICTION',
			});
			contradictionsFlagged++;
		}

		log.debug({ contradictionsFlagged }, 'Contradiction detection complete');
	} catch (cause: unknown) {
		const message = cause instanceof Error ? cause.message : String(cause);
		errors.push({
			code: GRAPH_ERROR_CODES.GRAPH_CONTRADICTION_FAILED,
			message: `Contradiction detection failed: ${message}`,
		});
		log.warn({ err: cause }, 'Contradiction detection failed — continuing');
	}

	// 10. Determine overall status
	let status: 'success' | 'partial' | 'failed';
	if (errors.length === 0) {
		status = 'success';
	} else if (edgesCreated > 0 || edgesUpdated > 0 || corroborationUpdates > 0) {
		status = 'partial';
	} else {
		status = 'failed';
	}

	// 11. Update story status + source step
	if (status !== 'failed') {
		await updateStoryStatus(pool, input.storyId, 'graphed');
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

	// 12. Firestore observability (fire-and-forget)
	services.firestore
		.setDocument('stories', input.storyId, {
			status: status !== 'failed' ? 'graphed' : 'failed',
			graphedAt: new Date().toISOString(),
			edgesCreated,
			edgesUpdated,
			duplicatesFound,
			corroborationUpdates,
			contradictionsFlagged,
		})
		.catch(() => {
			// Silently swallow — Firestore is best-effort observability
		});

	const durationMs = Math.round(performance.now() - startTime);
	const graphData: GraphData = {
		storyId: input.storyId,
		edgesCreated,
		edgesUpdated,
		duplicatesFound,
		corroborationUpdates,
		contradictionsFlagged,
	};

	log.info(
		{
			status,
			edgesCreated,
			edgesUpdated,
			duplicatesFound,
			corroborationUpdates,
			contradictionsFlagged,
			errors: errors.length,
			duration_ms: durationMs,
		},
		'Graph step completed',
	);

	// 13. Return GraphResult
	return {
		status,
		data: graphData,
		errors,
		metadata: {
			duration_ms: durationMs,
			items_processed: 1,
			items_skipped: 0,
			items_cached: 0,
		},
	};
}
