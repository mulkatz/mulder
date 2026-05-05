/**
 * Cross-lingual entity resolution -- 3-tier strategy.
 *
 * Resolves newly extracted entities against existing entities in the database
 * across languages, name variants, and documents.
 *
 * Tier 1: Attribute match (deterministic) -- exact match on structured identifiers
 * Tier 2: Embedding similarity (statistical) -- cosine similarity via text-embedding-004
 * Tier 3: LLM-assisted (semantic) -- Gemini decides for ambiguous pairs
 *
 * On match at any tier, the new entity is merged: its canonical_id points to
 * the existing entity and its name is added as an alias.
 *
 * @see docs/specs/28_cross_lingual_entity_resolution.spec.md §4.3
 * @see docs/functional-spec.md §2.4
 */

import type { ArtifactProvenanceInput, Entity, EntityResolutionConfig, Services } from '@mulder/core';
import {
	createChildLogger,
	createEntityAlias,
	createLogger,
	findAliasesByEntityId,
	findCandidatesByAttributes,
	findCandidatesByEmbedding,
	renderPrompt,
	updateEntity,
	updateEntityEmbedding,
} from '@mulder/core';
import type pg from 'pg';
import type {
	ResolutionCandidate,
	ResolutionResult,
	ResolutionTier,
	ResolveEntityOptions,
} from './resolution-types.js';

const logger = createLogger();
const resolutionLogger = createChildLogger(logger, { module: 'entity-resolution' });

// ────────────────────────────────────────────────────────────
// LLM response schema for Tier 3
// ────────────────────────────────────────────────────────────

/** JSON Schema for Gemini structured output in Tier 3 resolution. */
const LLM_RESOLUTION_SCHEMA: Record<string, unknown> = {
	type: 'object',
	properties: {
		same_entity: { type: 'boolean', description: 'Whether the two entities refer to the same real-world thing' },
		confidence: { type: 'number', description: 'Confidence score between 0 and 1' },
		reasoning: { type: 'string', description: 'Brief explanation of the decision' },
	},
	required: ['same_entity', 'confidence', 'reasoning'],
};

/** Parsed LLM resolution response. */
interface LlmResolutionResponse {
	same_entity: boolean;
	confidence: number;
	reasoning: string;
}

// ────────────────────────────────────────────────────────────
// Strategy config helpers
// ────────────────────────────────────────────────────────────

interface StrategyConfig {
	type: string;
	enabled: boolean;
	threshold?: number;
	model?: string;
}

function getStrategy(config: EntityResolutionConfig, type: string): StrategyConfig | undefined {
	return config.strategies.find((s) => s.type === type);
}

function isStrategyEnabled(config: EntityResolutionConfig, type: string): boolean {
	const strategy = getStrategy(config, type);
	return strategy?.enabled ?? false;
}

// ────────────────────────────────────────────────────────────
// Tier 1: Attribute match
// ────────────────────────────────────────────────────────────

/**
 * Checks if the entity has at least one matchable identifier attribute.
 * Matchable keys: wikidata_id, geo_point, iso_date.
 */
function hasMatchableAttributes(attributes: Record<string, unknown>): boolean {
	return (
		typeof attributes.wikidata_id === 'string' ||
		typeof attributes.iso_date === 'string' ||
		(attributes.geo_point !== null &&
			attributes.geo_point !== undefined &&
			typeof attributes.geo_point === 'object' &&
			!Array.isArray(attributes.geo_point))
	);
}

async function runTier1(pool: pg.Pool, entity: Entity): Promise<ResolutionCandidate | null> {
	if (!hasMatchableAttributes(entity.attributes)) {
		resolutionLogger.debug({ entityId: entity.id, name: entity.name }, 'Tier 1 skipped: no matchable attributes');
		return null;
	}

	const candidates = await findCandidatesByAttributes(pool, entity.type, entity.attributes, entity.id);

	if (candidates.length === 0) {
		resolutionLogger.debug({ entityId: entity.id, name: entity.name }, 'Tier 1: no attribute matches found');
		return null;
	}

	const best = candidates[0];
	resolutionLogger.info(
		{
			entityId: entity.id,
			entityName: entity.name,
			matchedId: best.entity.id,
			matchedName: best.entity.name,
		},
		'Tier 1: attribute match found',
	);

	return {
		entity: best.entity,
		tier: 'attribute_match',
		score: 1.0,
		evidence: `Attribute match: ${best.matchDetail}`,
	};
}

// ────────────────────────────────────────────────────────────
// Tier 2: Embedding similarity
// ────────────────────────────────────────────────────────────

async function runTier2(
	pool: pg.Pool,
	entity: Entity,
	services: Services,
	threshold: number,
): Promise<{ match: ResolutionCandidate | null; nearMisses: Array<{ entity: Entity; similarity: number }> }> {
	// Embed entity name
	const embedResults = await services.embedding.embed([entity.name]);
	const embedding = embedResults[0].vector;

	// Store embedding on the entity for future queries
	await updateEntityEmbedding(pool, entity.id, embedding);

	// Search for candidates above threshold
	const candidates = await findCandidatesByEmbedding(pool, entity.type, embedding, threshold, entity.id);

	// Also find near-misses for potential Tier 3 escalation (80% of threshold to threshold)
	const nearMissThreshold = threshold * 0.8;
	const nearMissCandidates = await findCandidatesByEmbedding(
		pool,
		entity.type,
		embedding,
		nearMissThreshold,
		entity.id,
	);
	const nearMisses = nearMissCandidates
		.filter((c) => c.similarity < threshold)
		.map((c) => ({ entity: c.entity, similarity: c.similarity }));

	if (candidates.length === 0) {
		resolutionLogger.debug(
			{ entityId: entity.id, name: entity.name, nearMissCount: nearMisses.length },
			'Tier 2: no candidates above threshold',
		);
		return { match: null, nearMisses };
	}

	const best = candidates[0];
	resolutionLogger.info(
		{
			entityId: entity.id,
			entityName: entity.name,
			matchedId: best.entity.id,
			matchedName: best.entity.name,
			similarity: best.similarity,
		},
		'Tier 2: embedding match found',
	);

	return {
		match: {
			entity: best.entity,
			tier: 'embedding_similarity',
			score: best.similarity,
			evidence: `Embedding cosine similarity: ${best.similarity.toFixed(4)}`,
		},
		nearMisses,
	};
}

// ────────────────────────────────────────────────────────────
// Tier 3: LLM-assisted
// ────────────────────────────────────────────────────────────

async function runTier3(
	pool: pg.Pool,
	entity: Entity,
	candidateEntities: Array<{ entity: Entity; similarity: number }>,
	services: Services,
): Promise<ResolutionCandidate | null> {
	if (candidateEntities.length === 0) {
		resolutionLogger.debug({ entityId: entity.id, name: entity.name }, 'Tier 3 skipped: no candidate pairs');
		return null;
	}

	// Try each candidate with LLM until we find a match
	for (const candidate of candidateEntities) {
		// Gather aliases for both entities
		const [entityAliases, candidateAliases] = await Promise.all([
			findAliasesByEntityId(pool, entity.id),
			findAliasesByEntityId(pool, candidate.entity.id),
		]);

		const prompt = renderPrompt('resolve-entity', {
			entity_a: {
				name: candidate.entity.name,
				type: candidate.entity.type,
				attributes: JSON.stringify(candidate.entity.attributes),
				aliases: candidateAliases.map((a) => a.alias).join(', ') || 'none',
			},
			entity_b: {
				name: entity.name,
				type: entity.type,
				attributes: JSON.stringify(entity.attributes),
				aliases: entityAliases.map((a) => a.alias).join(', ') || 'none',
			},
		});

		const response = await services.llm.generateStructured<LlmResolutionResponse>({
			prompt,
			schema: LLM_RESOLUTION_SCHEMA,
		});

		resolutionLogger.debug(
			{
				entityName: entity.name,
				candidateName: candidate.entity.name,
				sameEntity: response.same_entity,
				confidence: response.confidence,
				reasoning: response.reasoning,
			},
			'Tier 3: LLM resolution result',
		);

		if (response.same_entity && response.confidence > 0.7) {
			resolutionLogger.info(
				{
					entityId: entity.id,
					entityName: entity.name,
					matchedId: candidate.entity.id,
					matchedName: candidate.entity.name,
					confidence: response.confidence,
				},
				'Tier 3: LLM confirmed match',
			);

			return {
				entity: candidate.entity,
				tier: 'llm_assisted',
				score: response.confidence,
				evidence: `LLM reasoning: ${response.reasoning}`,
			};
		}
	}

	resolutionLogger.debug({ entityId: entity.id, name: entity.name }, 'Tier 3: no LLM-confirmed matches');
	return null;
}

// ────────────────────────────────────────────────────────────
// Merge operation
// ────────────────────────────────────────────────────────────

/**
 * Merges a new entity into an existing canonical entity:
 * 1. Sets canonical_id on the new entity pointing to the matched entity
 * 2. Adds the new entity's name as an alias on the canonical entity
 * 3. Increments source_count on the canonical entity
 */
async function mergeEntities(
	pool: pg.Pool,
	newEntity: Entity,
	canonicalEntity: Entity,
	tier: ResolutionTier,
	score: number,
	evidence: string,
	provenance?: ArtifactProvenanceInput,
): Promise<void> {
	// Set canonical_id on the new entity
	await updateEntity(pool, newEntity.id, {
		canonicalId: canonicalEntity.id,
	});

	// Add new entity name as alias on canonical entity
	await createEntityAlias(pool, {
		entityId: canonicalEntity.id,
		alias: newEntity.name,
		source: `resolution:${tier}`,
		provenance,
	});

	// Increment source_count on canonical entity
	await updateEntity(pool, canonicalEntity.id, {
		sourceCount: canonicalEntity.sourceCount + 1,
		provenance,
	});

	resolutionLogger.info(
		{
			newEntityId: newEntity.id,
			newEntityName: newEntity.name,
			canonicalId: canonicalEntity.id,
			canonicalName: canonicalEntity.name,
			tier,
			score,
			evidence,
		},
		'Entities merged',
	);
}

// ────────────────────────────────────────────────────────────
// Main resolution function
// ────────────────────────────────────────────────────────────

/**
 * Resolves a single entity against existing entities using the 3-tier strategy.
 *
 * For each enabled tier in config order:
 * 1. attribute_match -- findCandidatesByAttributes()
 * 2. embedding_similarity -- embed name, findCandidatesByEmbedding()
 * 3. llm_assisted -- take Tier 2 near-misses, Gemini decides
 *
 * If a candidate is found above the tier's threshold, merge and return.
 * If no match is found at any tier, return { action: 'new' }.
 *
 * @param options - Entity, pool, services, and config
 * @returns Resolution result with action, canonical entity, match details, and tiers executed
 */
export async function resolveEntity(options: ResolveEntityOptions): Promise<ResolutionResult> {
	const { entity, pool, services, config, provenance } = options;
	const tiersExecuted: ResolutionTier[] = [];

	resolutionLogger.debug({ entityId: entity.id, name: entity.name, type: entity.type }, 'Starting entity resolution');

	// Tier 2 near-misses, captured for potential Tier 3 escalation
	let tier2NearMisses: Array<{ entity: Entity; similarity: number }> = [];

	// ── Tier 1: Attribute match ──────────────────────────────
	if (isStrategyEnabled(config, 'attribute_match')) {
		tiersExecuted.push('attribute_match');
		const match = await runTier1(pool, entity);

		if (match) {
			await mergeEntities(pool, entity, match.entity, match.tier, match.score, match.evidence, provenance);
			return {
				action: 'merged',
				canonicalEntity: match.entity,
				match,
				tiersExecuted,
			};
		}
	}

	// ── Tier 2: Embedding similarity ─────────────────────────
	if (isStrategyEnabled(config, 'embedding_similarity')) {
		tiersExecuted.push('embedding_similarity');
		const strategy = getStrategy(config, 'embedding_similarity');
		const threshold = strategy?.threshold ?? 0.85;

		const { match, nearMisses } = await runTier2(pool, entity, services, threshold);
		tier2NearMisses = nearMisses;

		if (match) {
			await mergeEntities(pool, entity, match.entity, match.tier, match.score, match.evidence, provenance);
			return {
				action: 'merged',
				canonicalEntity: match.entity,
				match,
				tiersExecuted,
			};
		}
	}

	// ── Tier 3: LLM-assisted ─────────────────────────────────
	if (isStrategyEnabled(config, 'llm_assisted')) {
		tiersExecuted.push('llm_assisted');

		// Use Tier 2 near-misses as candidates for LLM resolution
		const candidates = tier2NearMisses;

		if (candidates.length > 0) {
			const match = await runTier3(pool, entity, candidates, services);

			if (match) {
				await mergeEntities(pool, entity, match.entity, match.tier, match.score, match.evidence, provenance);
				return {
					action: 'merged',
					canonicalEntity: match.entity,
					match,
					tiersExecuted,
				};
			}
		} else {
			resolutionLogger.debug(
				{ entityId: entity.id, name: entity.name },
				'Tier 3 skipped: no near-miss candidates from Tier 2',
			);
		}
	}

	// ── No match found ───────────────────────────────────────
	resolutionLogger.debug(
		{ entityId: entity.id, name: entity.name, tiersExecuted },
		'No resolution match found, entity remains new',
	);

	return {
		action: 'new',
		canonicalEntity: entity,
		match: null,
		tiersExecuted,
	};
}
