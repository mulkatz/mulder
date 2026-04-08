/**
 * Query entity extraction + corpus confidence helpers for the hybrid
 * retrieval orchestrator (E6).
 *
 * Both helpers are deterministic, cheap, and rely on plain SQL — no LLM call.
 *
 * - {@link extractQueryEntities} performs alias-based seed entity matching
 *   for graph traversal. The strategy is intentionally simple per
 *   spec 42 §2 ("Out of scope" — LLM-based extraction).
 * - {@link computeQueryConfidence} computes the §5.3 confidence object from
 *   `COUNT(*)` queries on `sources`, `entities`, and `entity_edges`.
 *
 * @see docs/specs/42_hybrid_retrieval_orchestrator.spec.md §4.1
 * @see docs/functional-spec.md §5, §5.3
 */

import {
	countEntities,
	createChildLogger,
	createLogger,
	findEntityByAlias,
	type MulderConfig,
	RETRIEVAL_ERROR_CODES,
	RetrievalError,
} from '@mulder/core';
import type pg from 'pg';
import type { QueryConfidence } from './types.js';

const logger = createChildLogger(createLogger(), { module: 'retrieval-query-entities' });

// ────────────────────────────────────────────────────────────
// Tokenization config
// ────────────────────────────────────────────────────────────

/** Split tokens on whitespace and common punctuation. */
const TOKEN_SPLIT_REGEX = /[\s.,;:!?()[\]{}"']+/;

/** Discard tokens shorter than this many characters. */
const MIN_TOKEN_LENGTH = 2;

/** Maximum n-gram window size. */
const MAX_NGRAM = 3;

/** Hard cap on candidate phrases examined per query (avoids quadratic blowup). */
const MAX_CANDIDATE_PHRASES = 100;

/** Hard cap on returned seed entities (bounds graph traversal fan-out). */
const MAX_SEED_ENTITIES = 20;

// ────────────────────────────────────────────────────────────
// extractQueryEntities
// ────────────────────────────────────────────────────────────

/**
 * Generates 1-, 2-, and 3-gram candidate phrases from a tokenized query.
 *
 * Tokens shorter than {@link MIN_TOKEN_LENGTH} are dropped before n-gram
 * generation. Total candidate count is capped at {@link MAX_CANDIDATE_PHRASES}.
 */
function buildCandidatePhrases(query: string): string[] {
	const tokens = query
		.split(TOKEN_SPLIT_REGEX)
		.map((token) => token.trim())
		.filter((token) => token.length >= MIN_TOKEN_LENGTH);

	if (tokens.length === 0) {
		return [];
	}

	const phrases: string[] = [];
	for (let n = 1; n <= MAX_NGRAM; n++) {
		for (let i = 0; i + n <= tokens.length; i++) {
			phrases.push(tokens.slice(i, i + n).join(' '));
			if (phrases.length >= MAX_CANDIDATE_PHRASES) {
				return phrases;
			}
		}
	}
	return phrases;
}

/**
 * Extracts candidate seed entities from a free-text query for graph traversal.
 *
 * Strategy (deterministic, no LLM):
 *   1. Tokenize the query on whitespace + punctuation.
 *   2. Generate 1-, 2-, and 3-gram candidate phrases.
 *   3. For each phrase, look up `findEntityByAlias` first with the original
 *      casing, then with a lowercased fallback. The `entity_aliases.alias`
 *      column is case-sensitive, so casing matters.
 *   4. Deduplicate by entity id, preserving first-seen order.
 *   5. Cap final seeds at {@link MAX_SEED_ENTITIES}.
 *
 * Empty result is fine — the orchestrator skips graph strategy gracefully.
 *
 * @param pool - PostgreSQL connection pool.
 * @param query - Free-text user query.
 * @returns Seed entity IDs in first-seen order.
 */
export async function extractQueryEntities(pool: pg.Pool, query: string): Promise<string[]> {
	const start = Date.now();

	if (typeof query !== 'string' || query.trim().length === 0) {
		return [];
	}

	const phrases = buildCandidatePhrases(query);
	if (phrases.length === 0) {
		return [];
	}

	const seenIds = new Set<string>();
	const seeds: string[] = [];

	for (const phrase of phrases) {
		if (seeds.length >= MAX_SEED_ENTITIES) {
			break;
		}

		// Try original casing first.
		let entity = await findEntityByAlias(pool, phrase);

		// Fall back to lowercased lookup if no match and the casing differs.
		if (entity === null) {
			const lowered = phrase.toLowerCase();
			if (lowered !== phrase) {
				entity = await findEntityByAlias(pool, lowered);
			}
		}

		if (entity !== null && !seenIds.has(entity.id)) {
			seenIds.add(entity.id);
			seeds.push(entity.id);
		}
	}

	logger.debug(
		{
			queryLength: query.length,
			phraseCount: phrases.length,
			seedCount: seeds.length,
			elapsedMs: Date.now() - start,
		},
		'extractQueryEntities complete',
	);

	return seeds;
}

// ────────────────────────────────────────────────────────────
// computeQueryConfidence
// ────────────────────────────────────────────────────────────

/**
 * Counts sources past raw ingestion. A "corpus" is everything that has
 * progressed beyond the initial `ingested` state — i.e., documents that have
 * actually been processed and contribute content.
 */
async function countCorpusSources(pool: pg.Pool): Promise<number> {
	try {
		const result = await pool.query<{ count: string }>(
			"SELECT COUNT(*) AS count FROM sources WHERE status != 'ingested'",
		);
		return Number.parseInt(result.rows[0]?.count ?? '0', 10);
	} catch (cause: unknown) {
		throw new RetrievalError(
			'Failed to count corpus sources for query confidence',
			RETRIEVAL_ERROR_CODES.RETRIEVAL_QUERY_FAILED,
			{ cause },
		);
	}
}

/** Counts all rows in the `entity_edges` table. */
async function countEntityEdges(pool: pg.Pool): Promise<number> {
	try {
		const result = await pool.query<{ count: string }>('SELECT COUNT(*) AS count FROM entity_edges');
		return Number.parseInt(result.rows[0]?.count ?? '0', 10);
	} catch (cause: unknown) {
		throw new RetrievalError(
			'Failed to count entity edges for query confidence',
			RETRIEVAL_ERROR_CODES.RETRIEVAL_QUERY_FAILED,
			{ cause },
		);
	}
}

/**
 * Classifies taxonomy maturity from corpus size against the
 * `taxonomy_bootstrap` threshold.
 */
function classifyTaxonomyStatus(corpusSize: number, taxonomyBootstrap: number): QueryConfidence['taxonomy_status'] {
	if (corpusSize === 0) {
		return 'not_started';
	}
	if (corpusSize < taxonomyBootstrap) {
		return 'bootstrapping';
	}
	if (corpusSize < 2 * taxonomyBootstrap) {
		return 'active';
	}
	return 'mature';
}

/**
 * Classifies corroboration reliability from corpus size against the
 * `corroboration_meaningful` threshold.
 */
function classifyCorroborationReliability(
	corpusSize: number,
	corroborationMeaningful: number,
): QueryConfidence['corroboration_reliability'] {
	if (corpusSize < 10) {
		return 'insufficient';
	}
	if (corpusSize < corroborationMeaningful) {
		return 'low';
	}
	if (corpusSize < 2 * corroborationMeaningful) {
		return 'moderate';
	}
	return 'high';
}

/**
 * Computes the {@link QueryConfidence} object per functional spec §5.3.
 *
 * All values are derived from cheap COUNT(*) queries. No expensive graph
 * metrics. Wraps any DB error in `RetrievalError(RETRIEVAL_QUERY_FAILED)`.
 *
 * Thresholds come from `config.thresholds`:
 *   - `taxonomy_status`: `not_started` (0), `bootstrapping` (< taxonomy_bootstrap),
 *     `active` (< 2× threshold), `mature` (≥ 2× threshold)
 *   - `corroboration_reliability`: `insufficient` (< 10),
 *     `low` (< corroboration_meaningful), `moderate` (< 2× threshold),
 *     `high` (≥ 2× threshold)
 *   - `graph_density`: `edge_count / entity_count` (0.0 if entity_count = 0)
 *   - `degraded`: true if `corpus_size < taxonomy_bootstrap` OR `graphHitCount === 0`
 */
export async function computeQueryConfidence(
	pool: pg.Pool,
	config: MulderConfig,
	options: { graphHitCount: number },
): Promise<QueryConfidence> {
	const start = Date.now();

	const corpusSize = await countCorpusSources(pool);
	const entityCount = await countEntities(pool);
	const edgeCount = await countEntityEdges(pool);

	const graphDensity = entityCount > 0 ? edgeCount / entityCount : 0;
	const taxonomyStatus = classifyTaxonomyStatus(corpusSize, config.thresholds.taxonomy_bootstrap);
	const corroborationReliability = classifyCorroborationReliability(
		corpusSize,
		config.thresholds.corroboration_meaningful,
	);
	const degraded = corpusSize < config.thresholds.taxonomy_bootstrap || options.graphHitCount === 0;

	const confidence: QueryConfidence = {
		corpus_size: corpusSize,
		taxonomy_status: taxonomyStatus,
		corroboration_reliability: corroborationReliability,
		graph_density: graphDensity,
		degraded,
	};

	logger.debug(
		{
			corpusSize,
			entityCount,
			edgeCount,
			graphHitCount: options.graphHitCount,
			degraded,
			elapsedMs: Date.now() - start,
		},
		'computeQueryConfidence complete',
	);

	return confidence;
}
