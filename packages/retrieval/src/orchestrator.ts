/**
 * Hybrid retrieval orchestrator (E6) — wires the three retrieval strategies
 * (vector, fulltext, graph), RRF fusion, and LLM re-ranking together behind
 * a single library function.
 *
 * Behavior:
 *   1. Validate input (query, strategy, topK).
 *   2. Resolve defaults from config.
 *   3. Pick active strategies from the strategy mode.
 *   4. Extract seed entities for graph traversal (only when graph is active).
 *   5. Run active strategies in parallel via Promise.allSettled. Per-strategy
 *      failures are captured but do NOT crash the orchestrator unless ALL
 *      active strategies fail/skip.
 *   6. Fuse results via RRF.
 *   7. Optionally re-rank via Gemini Flash. The bypass branch builds a
 *      passthrough RerankedResult[] from the fused list.
 *   8. Compute the §5.3 confidence object.
 *   9. Assemble and return the HybridRetrievalResult.
 *
 * @see docs/specs/42_hybrid_retrieval_orchestrator.spec.md §4.2
 * @see docs/functional-spec.md §5
 */

import {
	createChildLogger,
	createLogger,
	type EmbeddingService,
	type LlmService,
	type MulderConfig,
	RETRIEVAL_ERROR_CODES,
	RetrievalError,
} from '@mulder/core';
import type pg from 'pg';
import { fulltextSearch } from './fulltext.js';
import { rrfFuse } from './fusion.js';
import { graphSearch } from './graph.js';
import { computeQueryConfidence, extractQueryEntities } from './query-entities.js';
import { rerank } from './reranker.js';
import type {
	HybridRetrievalExplain,
	HybridRetrievalResult,
	HybridRetrieveOptions,
	RerankedResult,
	RetrievalResult,
	RetrievalStrategy,
	RetrievalStrategyMode,
} from './types.js';
import { vectorSearch } from './vector.js';

const logger = createChildLogger(createLogger(), { module: 'retrieval-orchestrator' });

/** Valid `RetrievalStrategyMode` values, used for input validation. */
const VALID_STRATEGY_MODES: readonly RetrievalStrategyMode[] = ['vector', 'fulltext', 'graph', 'hybrid'] as const;

/**
 * Maps a strategy mode to the list of underlying strategies that should run.
 *
 * - `hybrid` → all three
 * - `vector | fulltext | graph` → that single strategy
 */
function activeStrategiesFor(mode: RetrievalStrategyMode): RetrievalStrategy[] {
	if (mode === 'hybrid') {
		return ['vector', 'fulltext', 'graph'];
	}
	return [mode];
}

/**
 * Builds passthrough `RerankedResult[]` from a fused list when re-ranking
 * is bypassed (`noRerank=true` or feature flag disabled). The `rerankScore`
 * mirrors the RRF score and ranks become 1-based positions in the truncated
 * list.
 */
function buildPassthroughReranked(fused: ReturnType<typeof rrfFuse>, topK: number): RerankedResult[] {
	return fused.slice(0, topK).map((result, index) => ({
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

/** Internal task descriptor — name + executor closure. */
interface StrategyTask {
	name: RetrievalStrategy;
	run: () => Promise<RetrievalResult[]>;
}

/**
 * Hybrid retrieval entrypoint. Composes vector + fulltext + graph search,
 * fuses via RRF, and optionally re-ranks via Gemini Flash.
 *
 * @param pool - PostgreSQL connection pool.
 * @param embeddingService - Embedding service (used by vector strategy).
 * @param llmService - LLM service (used by re-ranking).
 * @param config - Mulder configuration.
 * @param query - Free-text user query. Must be non-empty after trimming.
 * @param options - Optional strategy mode, topK, rerank toggle, explain toggle.
 * @returns The full {@link HybridRetrievalResult} including confidence + explain.
 *
 * @throws RetrievalError RETRIEVAL_INVALID_INPUT — empty query, bad topK, bad strategy.
 * @throws RetrievalError RETRIEVAL_ORCHESTRATOR_FAILED — every active strategy failed/skipped.
 */
export async function hybridRetrieve(
	pool: pg.Pool,
	embeddingService: EmbeddingService,
	llmService: LlmService,
	config: MulderConfig,
	query: string,
	options?: HybridRetrieveOptions,
): Promise<HybridRetrievalResult> {
	const start = Date.now();

	// 1. Validate query.
	if (typeof query !== 'string' || query.trim().length === 0) {
		throw new RetrievalError(
			'hybridRetrieve requires a non-empty `query` string',
			RETRIEVAL_ERROR_CODES.RETRIEVAL_INVALID_INPUT,
			{ context: { queryType: typeof query, queryLength: typeof query === 'string' ? query.length : 0 } },
		);
	}

	// 2. Validate strategy (before resolving defaults so callers see the
	//    bad value, not a config-derived fallback).
	if (options?.strategy !== undefined && !VALID_STRATEGY_MODES.includes(options.strategy)) {
		throw new RetrievalError(
			`Invalid strategy "${String(options.strategy)}" — must be one of ${VALID_STRATEGY_MODES.join(' | ')}`,
			RETRIEVAL_ERROR_CODES.RETRIEVAL_INVALID_INPUT,
			{ context: { strategy: options.strategy } },
		);
	}

	// 3. Validate topK if provided.
	if (options?.topK !== undefined) {
		if (!Number.isInteger(options.topK) || options.topK <= 0) {
			throw new RetrievalError(
				`topK must be a positive integer, got ${String(options.topK)}`,
				RETRIEVAL_ERROR_CODES.RETRIEVAL_INVALID_INPUT,
				{ context: { topK: options.topK } },
			);
		}
	}

	// 4. Resolve defaults.
	const strategy: RetrievalStrategyMode = options?.strategy ?? config.retrieval.default_strategy;
	const topK = options?.topK ?? config.retrieval.top_k;
	const noRerank = options?.noRerank === true;
	const explain = options?.explain === true;
	const trimmedQuery = query.trim();
	const oversample = Math.max(topK * 3, config.retrieval.rerank.candidates);

	logger.debug({ query: trimmedQuery, strategy, topK, noRerank, explain, oversample }, 'hybridRetrieve called');

	// 5. Pick active strategies.
	const activeStrategies = activeStrategiesFor(strategy);

	// 6. Extract seed entities for graph traversal — only if graph is active.
	const graphActive = activeStrategies.includes('graph');
	const seedEntityIds = graphActive ? await extractQueryEntities(pool, trimmedQuery) : [];

	// 7. Build task list. Strategies with no usable input (graph w/o seeds)
	//    are recorded as skipped instead of executed.
	const skipped: string[] = [];
	const tasks: StrategyTask[] = [];

	for (const name of activeStrategies) {
		if (name === 'vector') {
			tasks.push({
				name: 'vector',
				run: () => vectorSearch(pool, embeddingService, config, { query: trimmedQuery, limit: oversample }),
			});
			continue;
		}
		if (name === 'fulltext') {
			tasks.push({
				name: 'fulltext',
				run: () => fulltextSearch(pool, config, { query: trimmedQuery, limit: oversample }),
			});
			continue;
		}
		if (name === 'graph') {
			if (seedEntityIds.length === 0) {
				skipped.push('graph:no_seeds');
				continue;
			}
			const seeds = seedEntityIds;
			tasks.push({
				name: 'graph',
				run: () => graphSearch(pool, config, { entityIds: seeds, limit: oversample }),
			});
		}
	}

	// 8. Execute all tasks in parallel.
	const settled = await Promise.allSettled(tasks.map((task) => task.run()));

	const strategyResults = new Map<RetrievalStrategy, RetrievalResult[]>();
	const failures: Partial<Record<RetrievalStrategy, string>> = {};

	for (let i = 0; i < tasks.length; i++) {
		const task = tasks[i];
		const outcome = settled[i];
		if (outcome.status === 'fulfilled') {
			strategyResults.set(task.name, outcome.value);
			continue;
		}
		const reason: unknown = outcome.reason;
		const code = reason instanceof RetrievalError ? reason.code : reason instanceof Error ? 'UNKNOWN' : 'UNKNOWN';
		const message = reason instanceof Error ? reason.message : String(reason);
		failures[task.name] = code;
		logger.warn({ strategy: task.name, code, message }, 'strategy failed');
	}

	// 9. Bail if every active strategy failed or was skipped.
	if (strategyResults.size === 0) {
		throw new RetrievalError(
			'All active retrieval strategies failed or were skipped',
			RETRIEVAL_ERROR_CODES.RETRIEVAL_ORCHESTRATOR_FAILED,
			{
				context: {
					strategy,
					activeStrategies,
					failures,
					skipped,
				},
			},
		);
	}

	// 10. Fuse with RRF (oversample so reranker has headroom).
	const fused = rrfFuse(strategyResults, config, { limit: oversample });

	// 11. Optionally re-rank.
	let reranked: RerankedResult[];
	if (noRerank || config.retrieval.rerank.enabled === false) {
		reranked = buildPassthroughReranked(fused, topK);
	} else {
		reranked = await rerank(llmService, trimmedQuery, fused, config, { limit: topK });
	}

	// 12. Compute confidence.
	const graphHitCount = strategyResults.get('graph')?.length ?? 0;
	const confidence = await computeQueryConfidence(pool, config, { graphHitCount });

	// 13. Build counts map for explain.
	const counts: Partial<Record<RetrievalStrategy, number>> = {};
	for (const [name, results] of strategyResults) {
		counts[name] = results.length;
	}

	const explainBlock: HybridRetrievalExplain = {
		counts,
		skipped,
		failures,
		seedEntityIds,
	};

	// 14. Populate per-result contributions only when explain is requested.
	//     We need a fused-by-chunkId lookup so we can attach the RRF metadata
	//     (rrfScore + per-strategy ranks) to each surviving rerank entry.
	if (explain) {
		const fusedByChunk = new Map(fused.map((entry) => [entry.chunkId, entry]));
		explainBlock.contributions = reranked.map((result) => {
			const fusedEntry = fusedByChunk.get(result.chunkId);
			return {
				chunkId: result.chunkId,
				rerankScore: result.rerankScore,
				rrfScore: fusedEntry?.score ?? result.score,
				strategies: fusedEntry?.contributions ?? result.contributions,
			};
		});
	}

	const finalResult: HybridRetrievalResult = {
		query: trimmedQuery,
		strategy,
		topK,
		results: reranked,
		confidence,
		explain: explainBlock,
	};

	logger.info(
		{
			query: trimmedQuery,
			strategy,
			topK,
			noRerank,
			counts,
			skipped,
			failures: Object.keys(failures),
			finalCount: reranked.length,
			elapsedMs: Date.now() - start,
		},
		'hybridRetrieve complete',
	);

	return finalResult;
}
