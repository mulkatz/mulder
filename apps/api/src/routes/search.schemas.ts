import { z } from 'zod';

export const SEARCH_RETRIEVAL_STRATEGY_VALUES = ['vector', 'fulltext', 'graph'] as const;
export const SEARCH_STRATEGY_MODE_VALUES = ['vector', 'fulltext', 'graph', 'hybrid'] as const;

export const SearchRetrievalStrategySchema = z.enum(SEARCH_RETRIEVAL_STRATEGY_VALUES);
export const SearchStrategyModeSchema = z.enum(SEARCH_STRATEGY_MODE_VALUES);

export const SearchRequestSchema = z.object({
	query: z.string().trim().min(1),
	strategy: SearchStrategyModeSchema.optional(),
	top_k: z.number().int().positive().optional(),
	explain: z.boolean().optional().default(false),
});

export const SearchResultContributionSchema = z.object({
	strategy: SearchRetrievalStrategySchema,
	rank: z.number().int().positive(),
	score: z.number(),
});

export const SearchResultSchema = z.object({
	chunk_id: z.string().uuid(),
	story_id: z.string().uuid(),
	content: z.string(),
	score: z.number(),
	rerank_score: z.number(),
	rank: z.number().int().positive(),
	contributions: z.array(SearchResultContributionSchema),
	metadata: z.record(z.string(), z.unknown()),
});

export const SearchConfidenceSchema = z.object({
	corpus_size: z.number().int().nonnegative(),
	taxonomy_status: z.enum(['not_started', 'bootstrapping', 'active', 'mature']),
	corroboration_reliability: z.enum(['insufficient', 'low', 'moderate', 'high']),
	graph_density: z.number(),
	degraded: z.boolean(),
	message: z.string().nullable(),
});

export const SearchExplainContributionStrategySchema = z.object({
	strategy: SearchRetrievalStrategySchema,
	rank: z.number().int().positive(),
	score: z.number(),
});

export const SearchExplainContributionSchema = z.object({
	chunk_id: z.string().uuid(),
	rerank_score: z.number(),
	rrf_score: z.number(),
	strategies: z.array(SearchExplainContributionStrategySchema),
});

export const SearchExplainSchema = z.object({
	counts: z.record(z.string(), z.number().int().nonnegative()),
	skipped: z.array(z.string()),
	failures: z.record(z.string(), z.string()),
	seed_entity_ids: z.array(z.string().uuid()),
	contributions: z.array(SearchExplainContributionSchema),
});

export const SearchDataSchema = z.object({
	query: z.string().trim().min(1),
	strategy: SearchStrategyModeSchema,
	top_k: z.number().int().positive(),
	results: z.array(SearchResultSchema),
	confidence: SearchConfidenceSchema,
	explain: SearchExplainSchema,
});

export const SearchResponseSchema = z.object({
	data: SearchDataSchema,
});

export type SearchRequest = z.infer<typeof SearchRequestSchema>;
export type SearchResponse = z.infer<typeof SearchResponseSchema>;
export type SearchResult = z.infer<typeof SearchResultSchema>;
export type SearchExplain = z.infer<typeof SearchExplainSchema>;
export type SearchConfidence = z.infer<typeof SearchConfidenceSchema>;
