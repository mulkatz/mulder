import { performance } from 'node:perf_hooks';
import {
	createChildLogger,
	createServiceRegistry,
	DATABASE_ERROR_CODES,
	DatabaseError,
	getQueryPool,
	type Logger,
	loadConfig,
	type MulderConfig,
	type Services,
} from '@mulder/core';
import { type HybridRetrievalResult, type HybridRetrieveOptions, hybridRetrieve } from '@mulder/retrieval';
import type pg from 'pg';
import type {
	SearchConfidence,
	SearchExplain,
	SearchRequest,
	SearchResponse,
	SearchResult,
} from '../routes/search.schemas.js';

interface SearchContext {
	config: MulderConfig;
	pool: pg.Pool;
	services: Services;
}

interface SearchExecutionInput extends SearchRequest {
	no_rerank: boolean;
}

let cachedContext: SearchContext | null = null;
let cachedConfigPath: string | null = null;

function resolveConfigPath(): string {
	return process.env.MULDER_CONFIG ?? 'mulder.config.yaml';
}

function resolveSearchContext(logger: Logger): SearchContext {
	const configPath = resolveConfigPath();
	if (cachedContext && cachedConfigPath === configPath) {
		return cachedContext;
	}

	const config = loadConfig(configPath);
	if (!config.gcp?.cloud_sql) {
		throw new DatabaseError(
			'GCP cloud_sql configuration is required for search routes',
			DATABASE_ERROR_CODES.DB_CONNECTION_FAILED,
			{
				context: {
					configPath,
				},
			},
		);
	}

	const services = createServiceRegistry(config, logger);
	const pool = getQueryPool(config.gcp.cloud_sql);

	cachedContext = {
		config,
		pool,
		services,
	};
	cachedConfigPath = configPath;

	return cachedContext;
}

function mapSearchResultContribution(contribution: HybridRetrievalResult['results'][number]['contributions'][number]) {
	return {
		strategy: contribution.strategy,
		rank: contribution.rank,
		score: contribution.score,
	};
}

function mapSearchResult(result: HybridRetrievalResult['results'][number]): SearchResult {
	return {
		chunk_id: result.chunkId,
		story_id: result.storyId,
		content: result.content,
		score: result.score,
		rerank_score: result.rerankScore,
		rank: result.rank,
		contributions: result.contributions.map(mapSearchResultContribution),
		metadata: result.metadata ?? {},
	};
}

function mapSearchConfidence(confidence: HybridRetrievalResult['confidence']): SearchConfidence {
	return {
		corpus_size: confidence.corpus_size,
		taxonomy_status: confidence.taxonomy_status,
		corroboration_reliability: confidence.corroboration_reliability,
		graph_density: confidence.graph_density,
		degraded: confidence.degraded,
		message: confidence.message ?? null,
	};
}

function mapSearchExplain(explain: HybridRetrievalResult['explain']): SearchExplain {
	return {
		counts: explain.counts,
		skipped: explain.skipped,
		failures: explain.failures,
		seed_entity_ids: explain.seedEntityIds,
		contributions:
			explain.contributions?.map((item) => ({
				chunk_id: item.chunkId,
				rerank_score: item.rerankScore,
				rrf_score: item.rrfScore,
				strategies: item.strategies.map((strategy) => ({
					strategy: strategy.strategy,
					rank: strategy.rank,
					score: strategy.score,
				})),
			})) ?? [],
	};
}

export function buildSearchResponse(result: HybridRetrievalResult): SearchResponse {
	return {
		data: {
			query: result.query,
			strategy: result.strategy,
			top_k: result.topK,
			results: result.results.map(mapSearchResult),
			confidence: mapSearchConfidence(result.confidence),
			explain: mapSearchExplain(result.explain),
		},
	};
}

function buildRetrieveOptions(input: SearchExecutionInput): HybridRetrieveOptions {
	return {
		strategy: input.strategy,
		topK: input.top_k,
		noRerank: input.no_rerank,
		explain: input.explain,
	};
}

export async function runSearch(input: SearchExecutionInput, logger: Logger): Promise<SearchResponse> {
	const requestLogger = createChildLogger(logger, {
		module: 'api',
		route: 'search',
		strategy: input.strategy ?? 'hybrid',
		top_k: input.top_k ?? null,
		no_rerank: input.no_rerank,
		explain: input.explain,
	});
	const startedAt = performance.now();
	const context = resolveSearchContext(requestLogger);
	const result = await hybridRetrieve(
		context.pool,
		context.services.embedding,
		context.services.llm,
		context.config,
		input.query,
		buildRetrieveOptions(input),
	);
	const response = buildSearchResponse(result);

	requestLogger.info(
		{
			strategy: response.data.strategy,
			top_k: response.data.top_k,
			no_rerank: input.no_rerank,
			result_count: response.data.results.length,
			duration_ms: Math.round(performance.now() - startedAt),
		},
		'search request completed',
	);

	return response;
}

export function resetSearchContextForTests(): void {
	cachedContext = null;
	cachedConfigPath = null;
}
