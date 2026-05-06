/**
 * Default values for optional config fields.
 * These match the defaults in mulder.config.example.yaml.
 * Zod schemas use .default() to apply these, but this constant
 * serves as documentation and test reference.
 */

import type { ApiConfig } from './types.js';

const apiDefaults: ApiConfig = {
	port: 8080,
	auth: {
		api_keys: [],
		browser: {
			enabled: true,
			cookie_name: 'mulder_session',
			session_secret: 'dev-insecure-change-me',
			session_ttl_hours: 168,
			invitation_ttl_hours: 168,
			cookie_secure: false,
			same_site: 'Lax',
		},
	},
	rate_limiting: {
		enabled: true,
	},
	budget: {
		enabled: true,
		monthly_limit_usd: 50,
		extract_per_page_usd: 0.006,
		segment_per_page_usd: 0.002,
		enrich_per_source_usd: 0.015,
		embed_per_source_usd: 0.004,
		graph_per_source_usd: 0.001,
	},
};

export const CONFIG_DEFAULTS = {
	dev_mode: false,

	project: {
		supported_locales: ['en'],
	},

	api: apiDefaults,

	gcp: {
		cloud_sql: {
			tier: 'db-custom-2-8192',
		},
	},

	ingestion: {
		max_file_size_mb: 100,
		max_pages: 2000,
	},

	ingest_provenance: {
		required_metadata: {
			channel: true,
			submitted_by: true,
			collection_id: false,
			original_source: false,
			custody_chain: false,
		},
		archives: {
			auto_register: true,
		},
		collections: {
			auto_create_from_archive: true,
			auto_tag_from_path_segments: true,
			default_collection: null,
			default_sensitivity_level: 'internal' as const,
			default_language: 'und',
			default_credibility_profile_id: null,
		},
	},

	extraction: {
		native_text_threshold: 0.9,
		max_vision_pages: 20,
		segmentation: {
			model: 'gemini-2.5-flash',
		},
	},

	document_quality: {
		enabled: true,
		assessment: {
			method: 'ocr_confidence' as const,
			engine: null,
			ocr_confidence_threshold: 0.7,
			native_text_ratio_threshold: 0.5,
		},
		routing: {
			high: { path: 'standard' as const },
			medium: { path: 'enhanced_ocr' as const, fallback: 'visual_extraction' as const },
			low: { path: 'visual_extraction' as const, fallback: 'manual_transcription_required' as const },
			unusable: { path: 'skip' as const, create_manual_task: false },
		},
		quality_propagation: {
			enabled: true,
			low_quality_embedding_weight: 0.5,
			low_quality_assertion_penalty: 0.3,
		},
		manual_queue: {
			enabled: false,
			notify_reviewers: false,
			priority: 'normal' as const,
		},
	},

	access_control: {
		enabled: true,
		sensitivity: {
			levels: ['public', 'internal', 'restricted', 'confidential'],
			default_level: 'internal' as const,
			auto_detection: true,
			propagation: 'upward' as const,
			pii_types: [
				'person_name',
				'contact_info',
				'medical_data',
				'location_private',
				'location_sighting',
				'financial',
				'unpublished_research',
				'legal',
			],
		},
		rbac: {
			roles_source: 'config/roles.yaml',
			default_role: 'analyst',
		},
		external_query_gate: {
			enabled: false,
		},
	},

	source_rollback: {
		undo_window_hours: 72,
		auto_purge_after_undo_window: true,
		require_reason: true,
		require_confirmation: true,
		orphan_handling: 'mark' as const,
		journal_annotation: true,
		notify_on_purge: true,
	},

	credibility: {
		enabled: true,
		dimensions: [
			{ id: 'institutional_authority', label: 'Institutional authority' },
			{ id: 'domain_track_record', label: 'Domain track record' },
			{ id: 'conflict_of_interest', label: 'Conflict of interest' },
			{ id: 'transparency', label: 'Transparency / verifiability' },
			{ id: 'consistency', label: 'Internal consistency over time' },
		],
		auto_profile_on_ingest: true,
		require_human_review: true,
		display_in_reports: true,
		agent_instruction: 'weight_but_never_exclude' as const,
	},

	contradiction_management: {
		enabled: true,
		conflict_types: ['factual', 'interpretive', 'taxonomic', 'temporal', 'spatial', 'attributive'],
		severity_levels: ['minor', 'significant', 'fundamental'],
		detection: {
			pipeline: true,
			agent: false,
			human_reported: false,
			embedding_similarity_band: [0.3, 0.8] as [number, number],
			require_shared_entity: true,
			llm_confirmation: true,
			llm_engine: 'gemini-2.5-pro',
			min_confidence: 0.7,
			max_candidates_per_story: 25,
		},
		auto_severity_assessment: true,
		review: {
			conflict_detection: 'single_review' as const,
			resolution: 'single_review' as const,
		},
		metrics: {
			track_contradiction_density: true,
			track_resolution_rate: true,
			feed_credibility_profiles: true,
		},
	},

	review_workflow: {
		enabled: true,
		artifact_types: {
			assertion_classification: {
				review_depth: 'spot_check' as const,
				spot_check_percentage: 20,
				auto_approve_after_hours: 168,
				auto_approve_min_confidence: 0.9,
			},
			credibility_profile: {
				review_depth: 'double_review' as const,
				auto_approve_after_hours: null,
				escalation_reviewer: null,
			},
			taxonomy_mapping: {
				review_depth: 'single_review' as const,
				auto_approve_after_hours: 336,
			},
			similar_case_link: {
				review_depth: 'single_review' as const,
				auto_approve_after_hours: 168,
			},
			agent_finding: {
				review_depth: 'single_review' as const,
				auto_approve_after_hours: null,
			},
		},
		metrics: {
			track_accuracy: true,
			auto_adjust_depth: true,
			accuracy_threshold_for_upgrade: 0.7,
			accuracy_threshold_for_downgrade: 0.95,
		},
	},

	enrichment: {
		model: 'gemini-2.5-flash',
		max_story_tokens: 15000,
		assertion_classification: {
			enabled: true,
			conservative_labeling: true,
			require_confidence_metadata: true,
			default_provenance: 'llm_auto' as const,
			reviewable: true,
			review_depth: 'spot_check' as const,
			spot_check_percentage: 20,
		},
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
		min_confidence: 0.7,
		exclude_domains: [],
	},

	translation: {
		enabled: true,
		default_target_language: 'en',
		supported_languages: ['de', 'en', 'fr', 'es', 'pt', 'ru', 'zh', 'ja', 'pl', 'cs'],
		engine: 'gemini-2.5-flash',
		output_format: 'markdown' as const,
		cache_enabled: true,
		max_document_length_tokens: 500000,
	},

	analysis: {
		enabled: false,
		contradictions: true,
		reliability: true,
		evidence_chains: true,
		evidence_theses: [],
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
