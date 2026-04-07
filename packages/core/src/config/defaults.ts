/**
 * Default values for optional config fields.
 * These match the defaults in mulder.config.example.yaml.
 * Zod schemas use .default() to apply these, but this constant
 * serves as documentation and test reference.
 */

export const CONFIG_DEFAULTS = {
	dev_mode: false,

	project: {
		supported_locales: ['en'],
	},

	gcp: {
		cloud_sql: {
			tier: 'db-custom-2-8192',
		},
	},

	ingestion: {
		max_file_size_mb: 100,
		max_pages: 2000,
	},

	extraction: {
		native_text_threshold: 0.9,
		max_vision_pages: 20,
		segmentation: {
			model: 'gemini-2.5-flash',
		},
	},

	enrichment: {
		model: 'gemini-2.5-flash',
		max_story_tokens: 15000,
	},

	taxonomy: {
		normalization_threshold: 0.4,
	},

	entity_resolution: {
		strategies: [
			{ type: 'attribute_match' as const, enabled: true },
			{ type: 'embedding_similarity' as const, enabled: true, threshold: 0.85 },
			{ type: 'llm_assisted' as const, enabled: true, model: 'gemini-2.5-flash' },
		],
		cross_lingual: true,
	},

	deduplication: {
		enabled: true,
		segment_level: {
			strategy: 'minhash' as const,
			similarity_threshold: 0.9,
		},
		corroboration_filter: {
			same_author_is_one_source: true,
			similarity_above_threshold_is_one_source: true,
		},
		min_independent_sources: 3,
	},

	embedding: {
		model: 'text-embedding-004',
		storage_dimensions: 768,
		chunk_size_tokens: 512,
		chunk_overlap_tokens: 50,
		questions_per_chunk: 3,
	},

	retrieval: {
		default_strategy: 'hybrid' as const,
		top_k: 10,
		rerank: {
			enabled: true,
			model: 'gemini-2.5-flash',
			candidates: 20,
		},
		strategies: {
			vector: { weight: 0.5, ef_search: 40 },
			fulltext: { weight: 0.3 },
			graph: { weight: 0.2, max_hops: 2, supernode_threshold: 100 },
		},
	},

	grounding: {
		enabled: false,
		mode: 'on_demand' as const,
		enrich_types: ['location', 'person', 'organization'],
		cache_ttl_days: 30,
	},

	analysis: {
		enabled: false,
		contradictions: true,
		reliability: true,
		evidence_chains: true,
		spatio_temporal: true,
		cluster_window_days: 30,
	},

	thresholds: {
		taxonomy_bootstrap: 25,
		corroboration_meaningful: 50,
		graph_community_detection: 100,
		temporal_clustering: 30,
		source_reliability: 50,
	},

	pipeline: {
		concurrency: {
			document_ai: 5,
			gemini: 10,
			embeddings: 20,
			grounding: 3,
		},
		batch_size: {
			extract: 10,
			segment: 5,
			embed: 50,
			graph: 50,
		},
		retry: {
			max_attempts: 3,
			backoff_base_ms: 1000,
			backoff_max_ms: 30000,
		},
		error_handling: {
			partial_results: true,
			continue_on_page_error: true,
		},
	},

	safety: {
		max_pages_without_confirm: 500,
		max_cost_without_confirm_usd: 20,
		budget_alert_monthly_usd: 100,
		block_production_calls_in_test: true,
	},

	visual_intelligence: {
		enabled: false,
		extract_images: true,
		analyze_images: true,
		image_embedding: true,
		extract_from_maps: true,
		extract_from_diagrams: true,
	},

	pattern_discovery: {
		enabled: false,
		run_after_batch: true,
		anomaly_detection: true,
		temporal_spikes: true,
		subgraph_similarity: true,
		digest: {
			enabled: false,
			frequency: 'weekly' as const,
		},
	},
} as const;
