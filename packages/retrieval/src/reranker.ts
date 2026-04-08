/**
 * LLM Re-ranking — Gemini Flash scores fused results against the original
 * query for final relevance ordering.
 *
 * Takes the output of RRF fusion (E4) and asks Gemini Flash to re-score each
 * candidate passage. This is the second half of the §5.2 fusion+re-ranking
 * pipeline.
 *
 * The function is a library-only concern — wiring into a user-facing `mulder
 * query` command ships in E6 (hybrid retrieval orchestrator).
 *
 * @see docs/specs/41_llm_reranking.spec.md
 * @see docs/functional-spec.md §5.2
 */

import type { LlmService, MulderConfig } from '@mulder/core';
import { createChildLogger, createLogger, RETRIEVAL_ERROR_CODES, RetrievalError, renderPrompt } from '@mulder/core';
import type { FusedResult, RerankedResult, RerankOptions } from './types.js';

const logger = createChildLogger(createLogger(), { module: 'retrieval-reranker' });

// ────────────────────────────────────────────────────────────
// JSON Schema for structured LLM output
// ────────────────────────────────────────────────────────────

/**
 * JSON Schema that Gemini must conform to when re-ranking candidates.
 *
 * The schema is also used as a dev-mode detection marker — the `rankings`
 * property is recognized by {@link DevLlmService.generateStructured} which
 * returns an empty rankings array so dev-mode callers get passthrough-style
 * ordering without requiring fixture inspection.
 */
const RERANK_JSON_SCHEMA: Record<string, unknown> = {
	type: 'object',
	properties: {
		rankings: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					passage_id: { type: 'string' },
					relevance_score: { type: 'number', minimum: 0, maximum: 1 },
				},
				required: ['passage_id', 'relevance_score'],
			},
		},
	},
	required: ['rankings'],
};

/** Expected shape of the Gemini re-ranking response. */
interface RerankResponse {
	rankings: Array<{ passage_id: string; relevance_score: number }>;
}

// ────────────────────────────────────────────────────────────
// Response validation
// ────────────────────────────────────────────────────────────

/**
 * Converts an unknown value to a plain property record without type
 * assertions. Returns `null` if the value is not a plain object.
 */
function toRecord(value: unknown): Record<string, unknown> | null {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		return null;
	}
	return Object.fromEntries(Object.entries(value));
}

/** Type guard for a single ranking entry. */
function isValidRankingEntry(entry: unknown): entry is { passage_id: string; relevance_score: number } {
	const record = toRecord(entry);
	if (record === null) {
		return false;
	}
	const passageId = record.passage_id;
	const relevanceScore = record.relevance_score;
	if (typeof passageId !== 'string' || passageId.length === 0) {
		return false;
	}
	if (typeof relevanceScore !== 'number' || Number.isNaN(relevanceScore)) {
		return false;
	}
	if (relevanceScore < 0 || relevanceScore > 1) {
		return false;
	}
	return true;
}

/**
 * Validates the LLM response matches the expected shape. Throws
 * `RetrievalError` with code `RETRIEVAL_RERANK_INVALID_RESPONSE` on any
 * structural defect: missing `rankings`, wrong types, or out-of-range score.
 */
function validateRerankResponse(response: unknown): RerankResponse {
	const record = toRecord(response);
	if (record === null) {
		throw new RetrievalError(
			'Rerank response must be an object',
			RETRIEVAL_ERROR_CODES.RETRIEVAL_RERANK_INVALID_RESPONSE,
			{ context: { responseType: typeof response } },
		);
	}
	const rankings = record.rankings;
	if (!Array.isArray(rankings)) {
		throw new RetrievalError(
			'Rerank response missing "rankings" array',
			RETRIEVAL_ERROR_CODES.RETRIEVAL_RERANK_INVALID_RESPONSE,
			{ context: { receivedKeys: Object.keys(record) } },
		);
	}
	const validated: Array<{ passage_id: string; relevance_score: number }> = [];
	for (const entry of rankings) {
		if (!isValidRankingEntry(entry)) {
			throw new RetrievalError(
				'Rerank response contains malformed ranking entry',
				RETRIEVAL_ERROR_CODES.RETRIEVAL_RERANK_INVALID_RESPONSE,
				{ context: { entry } },
			);
		}
		validated.push({ passage_id: entry.passage_id, relevance_score: entry.relevance_score });
	}
	return { rankings: validated };
}

// ────────────────────────────────────────────────────────────
// Passthrough helpers
// ────────────────────────────────────────────────────────────

/**
 * Builds passthrough `RerankedResult[]` from `FusedResult[]` without calling
 * the LLM. Used for the feature-flag bypass path: `rerankScore` reuses the
 * original RRF `score`, and `rank` is a 1-based index into the truncated list.
 */
function buildPassthrough(fusedResults: FusedResult[], limit: number): RerankedResult[] {
	return fusedResults.slice(0, limit).map((result, index) => ({
		chunkId: result.chunkId,
		storyId: result.storyId,
		content: result.content,
		score: result.score,
		rerankScore: result.score,
		rank: index + 1,
		contributions: result.contributions,
		metadata: result.metadata,
	}));
}

// ────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────

/**
 * Re-ranks fused retrieval results using Gemini Flash for final relevance
 * ordering. Truncates input to `candidates`, prompts the LLM with the query
 * plus candidate passages, and returns the top `limit` results sorted by
 * Gemini relevance scores.
 *
 * Algorithm (per spec §4.2):
 * 1. Validate input — non-empty trimmed query, array of fused results.
 * 2. Empty input → return `[]` without calling the LLM.
 * 3. Feature flag bypass — if `config.retrieval.rerank.enabled === false`,
 *    return the input truncated to `limit` with `rerankScore = score`.
 * 4. Truncate input to `candidates` by RRF rank.
 * 5. Render the `rerank` prompt with query + passage block.
 * 6. Call `llmService.generateStructured` with the RERANK_JSON_SCHEMA.
 * 7. Validate the response structure.
 * 8. Map `passage_id` → `relevance_score`. Unknown IDs are warned and
 *    discarded. Missing passages get a fallback score (min - ε) so they sort
 *    below all scored results.
 * 9. Sort descending by rerankScore (tiebreak: original RRF score).
 * 10. Truncate to `limit` and assign 1-based ranks.
 *
 * @param llmService - LLM service abstraction (uses `generateStructured`).
 * @param query - Original user query. Must be a non-empty trimmed string.
 * @param fusedResults - RRF-fused results (sorted by RRF rank). Empty allowed.
 * @param config - Mulder configuration (for rerank feature flag, candidates, top_k).
 * @param options - Optional overrides for candidates, limit, locale.
 * @returns Re-ranked results with 1-based contiguous ranks.
 *
 * @throws RetrievalError RETRIEVAL_INVALID_INPUT — empty query or invalid params.
 * @throws RetrievalError RETRIEVAL_RERANK_FAILED — LLM call failed.
 * @throws RetrievalError RETRIEVAL_RERANK_INVALID_RESPONSE — malformed LLM response.
 *
 * @see docs/specs/41_llm_reranking.spec.md §4.2
 * @see docs/functional-spec.md §5.2
 */
export async function rerank(
	llmService: LlmService,
	query: string,
	fusedResults: FusedResult[],
	config: MulderConfig,
	options?: RerankOptions,
): Promise<RerankedResult[]> {
	const start = Date.now();

	// 1. Input validation.
	if (typeof query !== 'string' || query.trim().length === 0) {
		throw new RetrievalError(
			'Query must be a non-empty trimmed string',
			RETRIEVAL_ERROR_CODES.RETRIEVAL_INVALID_INPUT,
			{ context: { queryType: typeof query, queryLength: typeof query === 'string' ? query.length : 0 } },
		);
	}
	if (!Array.isArray(fusedResults)) {
		throw new RetrievalError('fusedResults must be an array', RETRIEVAL_ERROR_CODES.RETRIEVAL_INVALID_INPUT, {
			context: { receivedType: typeof fusedResults },
		});
	}

	const enabled = config.retrieval.rerank.enabled;
	const candidates = options?.candidates ?? config.retrieval.rerank.candidates;
	const limit = options?.limit ?? config.retrieval.top_k;
	const locale = options?.locale ?? 'en';

	logger.debug(
		{
			query,
			inputCount: fusedResults.length,
			candidates,
			limit,
			enabled,
		},
		'rerank called',
	);

	// 2. Empty passthrough — no LLM call.
	if (fusedResults.length === 0) {
		return [];
	}

	// 3. Feature flag bypass — passthrough without LLM call.
	if (enabled === false) {
		logger.debug({ inputCount: fusedResults.length, limit }, 'rerank bypassed (feature flag)');
		return buildPassthrough(fusedResults, limit);
	}

	// 4. Resolve params.
	if (!Number.isInteger(candidates) || candidates <= 0) {
		throw new RetrievalError(
			`candidates must be a positive integer, got ${candidates}`,
			RETRIEVAL_ERROR_CODES.RETRIEVAL_INVALID_INPUT,
			{ context: { candidates } },
		);
	}
	if (!Number.isInteger(limit) || limit <= 0) {
		throw new RetrievalError(
			`limit must be a positive integer, got ${limit}`,
			RETRIEVAL_ERROR_CODES.RETRIEVAL_INVALID_INPUT,
			{ context: { limit } },
		);
	}

	// 5. Truncate input to candidates (already sorted by RRF rank).
	const candidatePool = fusedResults.slice(0, candidates);

	// 6. Build passages block — "[passage_id: <chunkId>]\n<content>\n" joined
	//    by blank lines. chunkId is the unique passage identifier.
	const passages = candidatePool.map((result) => `[passage_id: ${result.chunkId}]\n${result.content}\n`).join('\n');

	// 7. Render prompt via the core template engine.
	const prompt = renderPrompt('rerank', {
		locale,
		query,
		passages,
	});

	// 8. Call the LLM. Wrap any throw in RETRIEVAL_RERANK_FAILED.
	let rawResponse: unknown;
	try {
		rawResponse = await llmService.generateStructured({
			prompt,
			schema: RERANK_JSON_SCHEMA,
		});
	} catch (cause: unknown) {
		throw new RetrievalError('LLM re-ranking call failed', RETRIEVAL_ERROR_CODES.RETRIEVAL_RERANK_FAILED, {
			context: {
				query,
				candidates: candidatePool.length,
			},
			cause,
		});
	}

	// 9. Validate response structure. Throws RETRIEVAL_RERANK_INVALID_RESPONSE.
	const response = validateRerankResponse(rawResponse);

	// 10. Build passage_id → rerankScore map, filtering unknown IDs.
	const candidateIds = new Set(candidatePool.map((result) => result.chunkId));
	const scoreByPassageId = new Map<string, number>();
	for (const entry of response.rankings) {
		if (!candidateIds.has(entry.passage_id)) {
			logger.warn({ passageId: entry.passage_id }, 'rerank: unknown passage_id in response');
			continue;
		}
		// If LLM returns duplicate passage_ids, keep the first one seen.
		if (!scoreByPassageId.has(entry.passage_id)) {
			scoreByPassageId.set(entry.passage_id, entry.relevance_score);
		}
	}

	// 11. Compute fallback score for passages the LLM did not score.
	//     "min returned score minus epsilon" so missing passages sort below
	//     all scored ones but remain present in the output.
	const returnedScores = [...scoreByPassageId.values()];
	const epsilon = 1e-6;
	const fallbackScore = returnedScores.length > 0 ? Math.min(...returnedScores) - epsilon : -epsilon;

	// 12. Assemble reranked results.
	const scored: RerankedResult[] = candidatePool.map((result) => {
		const llmScore = scoreByPassageId.get(result.chunkId);
		return {
			chunkId: result.chunkId,
			storyId: result.storyId,
			content: result.content,
			score: result.score,
			rerankScore: llmScore ?? fallbackScore,
			rank: 0, // temporary — assigned after sort
			contributions: result.contributions,
			metadata: result.metadata,
		};
	});

	// 13. Sort descending by rerankScore (tiebreak: original RRF score desc).
	scored.sort((a, b) => {
		if (b.rerankScore !== a.rerankScore) {
			return b.rerankScore - a.rerankScore;
		}
		return b.score - a.score;
	});

	// 14. Truncate to limit and assign 1-based contiguous ranks.
	const truncated = scored.slice(0, limit).map((result, index) => ({
		...result,
		rank: index + 1,
	}));

	logger.debug(
		{
			inputCount: fusedResults.length,
			candidates: candidatePool.length,
			scoredCount: scoreByPassageId.size,
			returned: truncated.length,
			elapsedMs: Date.now() - start,
		},
		'rerank complete',
	);

	return truncated;
}
