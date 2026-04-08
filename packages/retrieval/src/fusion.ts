/**
 * Reciprocal Rank Fusion (RRF) — merges results from multiple retrieval
 * strategies into a single deduplicated, ranked list.
 *
 * RRF score per chunk: `Σ (weight_i / (k + rank_i))` where k defaults to 60.
 * Weights are configurable per strategy via `mulder.config.yaml`.
 *
 * This is the first half of the §5.2 fusion+re-ranking pipeline — the
 * re-ranking step (Gemini Flash) ships in E5.
 *
 * @see docs/specs/40_rrf_fusion.spec.md
 * @see docs/functional-spec.md §5.2
 */

import type { MulderConfig } from '@mulder/core';
import { createChildLogger, createLogger, RETRIEVAL_ERROR_CODES, RetrievalError } from '@mulder/core';
import type { FusedResult, FusionOptions, RetrievalResult, RetrievalStrategy } from './types.js';

const logger = createChildLogger(createLogger(), { module: 'retrieval-fusion' });

/** Default RRF constant k per the original RRF paper and functional spec §5.2. */
const DEFAULT_K = 60;

/**
 * Resolves per-strategy weights from explicit options or config defaults.
 * Returns only weights for strategies that appear in `strategyResults`.
 */
function resolveWeights(
	strategies: RetrievalStrategy[],
	config: MulderConfig,
	overrides?: Partial<Record<RetrievalStrategy, number>>,
): Map<RetrievalStrategy, number> {
	const configWeights: Record<RetrievalStrategy, number> = {
		vector: config.retrieval.strategies.vector.weight,
		fulltext: config.retrieval.strategies.fulltext.weight,
		graph: config.retrieval.strategies.graph.weight,
	};

	const resolved = new Map<RetrievalStrategy, number>();
	for (const strategy of strategies) {
		const weight = overrides?.[strategy] ?? configWeights[strategy];
		resolved.set(strategy, weight);
	}
	return resolved;
}

/**
 * Validates that all weights are non-negative.
 * Throws `RetrievalError` with code `RETRIEVAL_FUSION_INVALID_WEIGHTS` if any
 * weight is negative.
 */
function validateWeights(weights: Map<RetrievalStrategy, number>): void {
	for (const [strategy, weight] of weights) {
		if (weight < 0) {
			throw new RetrievalError(
				`Negative weight (${weight}) for strategy "${strategy}"`,
				RETRIEVAL_ERROR_CODES.RETRIEVAL_FUSION_INVALID_WEIGHTS,
				{ context: { strategy, weight } },
			);
		}
	}
}

/**
 * Validates the RRF constant k is positive.
 * Throws `RetrievalError` with code `RETRIEVAL_FUSION_INVALID_K` if k <= 0.
 */
function validateK(k: number): void {
	if (k <= 0) {
		throw new RetrievalError(
			`RRF constant k must be positive, got ${k}`,
			RETRIEVAL_ERROR_CODES.RETRIEVAL_FUSION_INVALID_K,
			{ context: { k } },
		);
	}
}

/**
 * Merges results from multiple retrieval strategies using Reciprocal Rank
 * Fusion (RRF) with configurable per-strategy weights.
 *
 * @param strategyResults - Map from strategy to its ranked results.
 *   May contain 0, 1, 2, or 3 strategies. Empty map returns `[]`.
 * @param config - Mulder configuration (for default weights and top_k).
 * @param options - Optional overrides for k, limit, and weights.
 * @returns Deduplicated results sorted by descending RRF score with 1-based ranks.
 */
export function rrfFuse(
	strategyResults: Map<RetrievalStrategy, RetrievalResult[]>,
	config: MulderConfig,
	options?: FusionOptions,
): FusedResult[] {
	const start = Date.now();

	// 1. Early return for empty input (sparse graph degradation — not an error).
	if (strategyResults.size === 0) {
		logger.debug('RRF fusion called with empty strategy results, returning []');
		return [];
	}

	// 2. Resolve parameters.
	const k = options?.k ?? DEFAULT_K;
	const limit = options?.limit ?? config.retrieval.top_k;
	const strategies = [...strategyResults.keys()];
	const weights = resolveWeights(strategies, config, options?.weights);

	// 3. Validate parameters.
	validateK(k);
	validateWeights(weights);

	// 4. Build accumulator: chunkId → intermediate fusion data.
	//    For each strategy's results, compute per-result RRF contribution.
	const accumulator = new Map<
		string,
		{
			chunkId: string;
			storyId: string;
			content: string;
			rrfScore: number;
			contributions: Array<{ strategy: RetrievalStrategy; rank: number; score: number }>;
			metadata: Record<string, unknown>;
		}
	>();

	for (const [strategy, results] of strategyResults) {
		const weight = weights.get(strategy) ?? 0;

		// Zero weight → skip this strategy's results entirely.
		if (weight === 0) {
			logger.debug({ strategy, weight }, 'skipping strategy with zero weight');
			continue;
		}

		// Track seen chunkIds within this strategy to handle intra-strategy dupes.
		const seenInStrategy = new Set<string>();

		for (const result of results) {
			// Defensive: use first occurrence only within the same strategy.
			if (seenInStrategy.has(result.chunkId)) {
				continue;
			}
			seenInStrategy.add(result.chunkId);

			const rrfContribution = weight / (k + result.rank);
			const existing = accumulator.get(result.chunkId);

			if (existing) {
				// Cross-strategy duplicate: sum scores, append contribution.
				existing.rrfScore += rrfContribution;
				existing.contributions.push({
					strategy,
					rank: result.rank,
					score: result.score,
				});
				// Merge metadata (later strategies overwrite conflicting keys).
				if (result.metadata) {
					Object.assign(existing.metadata, result.metadata);
				}
			} else {
				accumulator.set(result.chunkId, {
					chunkId: result.chunkId,
					storyId: result.storyId,
					content: result.content,
					rrfScore: rrfContribution,
					contributions: [{ strategy, rank: result.rank, score: result.score }],
					metadata: result.metadata ? { ...result.metadata } : {},
				});
			}
		}
	}

	// 5. Sort descending by fused RRF score.
	const sorted = [...accumulator.values()].sort((a, b) => b.rrfScore - a.rrfScore);

	// 6. Truncate to limit and assign 1-based ranks.
	const truncated = sorted.slice(0, limit);
	const fusedResults: FusedResult[] = truncated.map((entry, index) => ({
		chunkId: entry.chunkId,
		storyId: entry.storyId,
		content: entry.content,
		score: entry.rrfScore,
		rank: index + 1,
		contributions: entry.contributions,
		metadata: Object.keys(entry.metadata).length > 0 ? entry.metadata : undefined,
	}));

	logger.debug(
		{
			strategyCount: strategies.length,
			strategies,
			k,
			limit,
			inputChunks: [...strategyResults.values()].reduce((sum, r) => sum + r.length, 0),
			uniqueChunks: accumulator.size,
			outputCount: fusedResults.length,
			elapsedMs: Date.now() - start,
		},
		'RRF fusion complete',
	);

	return fusedResults;
}
