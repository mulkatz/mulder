/**
 * Zod schemas for mulder.config.yaml — mirrors the example config exactly.
 * All optional fields have sensible defaults defined here.
 * Types are derived from these schemas via z.infer<> in types.ts.
 */

import { z } from 'zod';

// --- Attribute Types ---

const attributeTypeSchema = z.enum(['string', 'number', 'boolean', 'date', 'geo_point', 'string[]']);

const entityAttributeSchema = z.object({
	name: z.string().min(1),
	type: attributeTypeSchema,
});

// --- Ontology ---

const entityTypeSchema = z.object({
	name: z.string().min(1),
	description: z.string().min(1),
	attributes: z.array(entityAttributeSchema).default([]),
});

const relationshipSchema = z.object({
	name: z.string().min(1),
	source: z.string().min(1),
	target: z.string().min(1),
});

const ontologySchema = z.object({
	entity_types: z.array(entityTypeSchema).min(1),
	relationships: z.array(relationshipSchema).default([]),
});

// --- Project ---

const projectSchema = z.object({
	name: z.string().min(1),
	description: z.string().optional(),
	supported_locales: z.array(z.string().min(1)).default(['en']),
});

// --- GCP ---

const cloudSqlSchema = z.object({
	instance_name: z.string().min(1),
	database: z.string().min(1),
	tier: z.string().default('db-custom-2-8192'),
});

const storageSchema = z.object({
	bucket: z.string().min(1),
});

const gcpSchema = z.object({
	project_id: z.string().min(1),
	region: z.string().min(1),
	cloud_sql: cloudSqlSchema,
	storage: storageSchema,
});

// --- Ingestion ---

const ingestionSchema = z
	.object({
		max_file_size_mb: z.number().positive().default(100),
		max_pages: z.number().positive().int().default(2000),
	})
	.default({});

// --- Extraction ---

const segmentationConfigSchema = z.object({
	model: z.string().default('gemini-2.5-flash'),
});

const extractionSchema = z
	.object({
		native_text_threshold: z.number().min(0).max(1).default(0.9),
		max_vision_pages: z.number().positive().int().default(20),
		segmentation: segmentationConfigSchema.default({}),
	})
	.default({});

// --- Enrichment ---

const enrichmentSchema = z
	.object({
		model: z.string().default('gemini-2.5-flash'),
		max_story_tokens: z.number().positive().int().default(15000),
	})
	.default({});

// --- Entity Resolution ---

const resolutionStrategySchema = z.object({
	type: z.enum(['attribute_match', 'embedding_similarity', 'llm_assisted']),
	enabled: z.boolean().default(true),
	threshold: z.number().min(0).max(1).optional(),
	model: z.string().optional(),
});

const entityResolutionSchema = z
	.object({
		strategies: z.array(resolutionStrategySchema).default([
			{ type: 'attribute_match', enabled: true },
			{ type: 'embedding_similarity', enabled: true, threshold: 0.85 },
			{ type: 'llm_assisted', enabled: true, model: 'gemini-2.5-flash' },
		]),
		cross_lingual: z.boolean().default(true),
	})
	.default({});

// --- Deduplication ---

const segmentLevelSchema = z.object({
	strategy: z.enum(['minhash', 'embedding_similarity']).default('minhash'),
	similarity_threshold: z.number().min(0).max(1).default(0.9),
});

const corroborationFilterSchema = z.object({
	same_author_is_one_source: z.boolean().default(true),
	similarity_above_threshold_is_one_source: z.boolean().default(true),
});

const deduplicationSchema = z
	.object({
		enabled: z.boolean().default(true),
		segment_level: segmentLevelSchema.default({}),
		corroboration_filter: corroborationFilterSchema.default({}),
	})
	.default({});

// --- Embedding ---

const embeddingSchema = z
	.object({
		model: z.string().default('text-embedding-004'),
		storage_dimensions: z.number().positive().int().default(768),
		chunk_size_tokens: z.number().positive().int().default(512),
		chunk_overlap_tokens: z.number().nonnegative().int().default(50),
		questions_per_chunk: z.number().nonnegative().int().default(3),
	})
	.default({});

// --- Retrieval ---

const rerankSchema = z.object({
	enabled: z.boolean().default(true),
	model: z.string().default('gemini-2.5-flash'),
	candidates: z.number().positive().int().default(20),
});

const vectorStrategySchema = z.object({
	weight: z.number().min(0).max(1).default(0.5),
});

const fulltextStrategySchema = z.object({
	weight: z.number().min(0).max(1).default(0.3),
});

const graphStrategySchema = z.object({
	weight: z.number().min(0).max(1).default(0.2),
	max_hops: z.number().positive().int().default(2),
	supernode_threshold: z.number().positive().int().default(100),
});

const retrievalStrategiesSchema = z.object({
	vector: vectorStrategySchema.default({}),
	fulltext: fulltextStrategySchema.default({}),
	graph: graphStrategySchema.default({}),
});

const retrievalSchema = z
	.object({
		default_strategy: z.enum(['vector', 'fulltext', 'graph', 'hybrid']).default('hybrid'),
		top_k: z.number().positive().int().default(10),
		rerank: rerankSchema.default({}),
		strategies: retrievalStrategiesSchema.default({}),
	})
	.default({});

// --- Grounding (v2.0) ---

const groundingSchema = z
	.object({
		enabled: z.boolean().default(false),
		mode: z.enum(['pipeline', 'on_demand', 'disabled']).default('on_demand'),
		enrich_types: z.array(z.string().min(1)).default(['location', 'person', 'organization']),
		cache_ttl_days: z.number().positive().int().default(30),
	})
	.default({});

// --- Analysis (v2.0) ---

const analysisSchema = z
	.object({
		enabled: z.boolean().default(false),
		contradictions: z.boolean().default(true),
		reliability: z.boolean().default(true),
		evidence_chains: z.boolean().default(true),
		spatio_temporal: z.boolean().default(true),
		cluster_window_days: z.number().positive().int().default(30),
	})
	.default({});

// --- Thresholds ---

const thresholdsSchema = z
	.object({
		taxonomy_bootstrap: z.number().nonnegative().int().default(25),
		corroboration_meaningful: z.number().nonnegative().int().default(50),
		graph_community_detection: z.number().nonnegative().int().default(100),
		temporal_clustering: z.number().nonnegative().int().default(30),
		source_reliability: z.number().nonnegative().int().default(50),
	})
	.default({});

// --- Pipeline ---

const concurrencySchema = z.object({
	document_ai: z.number().positive().int().default(5),
	gemini: z.number().positive().int().default(10),
	embeddings: z.number().positive().int().default(20),
	grounding: z.number().positive().int().default(3),
});

const batchSizeSchema = z.object({
	extract: z.number().positive().int().default(10),
	segment: z.number().positive().int().default(5),
	embed: z.number().positive().int().default(50),
});

const retrySchema = z.object({
	max_attempts: z.number().positive().int().default(3),
	backoff_base_ms: z.number().positive().int().default(1000),
	backoff_max_ms: z.number().positive().int().default(30000),
});

const errorHandlingSchema = z.object({
	partial_results: z.boolean().default(true),
	continue_on_page_error: z.boolean().default(true),
});

const pipelineSchema = z
	.object({
		concurrency: concurrencySchema.default({}),
		batch_size: batchSizeSchema.default({}),
		retry: retrySchema.default({}),
		error_handling: errorHandlingSchema.default({}),
	})
	.default({});

// --- Safety ---

const safetySchema = z
	.object({
		max_pages_without_confirm: z.number().positive().int().default(500),
		max_cost_without_confirm_usd: z.number().positive().default(20),
		budget_alert_monthly_usd: z.number().positive().default(100),
		block_production_calls_in_test: z.boolean().default(true),
	})
	.default({});

// --- Phase 2 (reserved) ---

const visualIntelligenceSchema = z
	.object({
		enabled: z.boolean().default(false),
		extract_images: z.boolean().default(true),
		analyze_images: z.boolean().default(true),
		image_embedding: z.boolean().default(true),
		extract_from_maps: z.boolean().default(true),
		extract_from_diagrams: z.boolean().default(true),
	})
	.default({});

const digestSchema = z.object({
	enabled: z.boolean().default(false),
	frequency: z.enum(['daily', 'weekly', 'monthly']).default('weekly'),
});

const patternDiscoverySchema = z
	.object({
		enabled: z.boolean().default(false),
		run_after_batch: z.boolean().default(true),
		anomaly_detection: z.boolean().default(true),
		temporal_spikes: z.boolean().default(true),
		subgraph_similarity: z.boolean().default(true),
		digest: digestSchema.default({}),
	})
	.default({});

// --- Top-Level Config Schema ---

/**
 * Base schema without dev_mode conditional validation.
 * Cross-reference validation (ontology relationships) is applied via superRefine.
 */
const baseMulderConfigSchema = z.object({
	project: projectSchema,
	gcp: gcpSchema.optional(),
	dev_mode: z.boolean().default(false),
	ontology: ontologySchema,
	ingestion: ingestionSchema,
	extraction: extractionSchema,
	enrichment: enrichmentSchema,
	entity_resolution: entityResolutionSchema,
	deduplication: deduplicationSchema,
	embedding: embeddingSchema,
	retrieval: retrievalSchema,
	grounding: groundingSchema,
	analysis: analysisSchema,
	thresholds: thresholdsSchema,
	pipeline: pipelineSchema,
	safety: safetySchema,
	visual_intelligence: visualIntelligenceSchema,
	pattern_discovery: patternDiscoverySchema,
});

/**
 * Full config schema with cross-reference validation:
 * - When dev_mode is false (default), gcp is required
 * - Relationship source/target must reference existing entity type names
 */
export const mulderConfigSchema = baseMulderConfigSchema.superRefine((data, ctx) => {
	// GCP required when not in dev mode
	if (!data.dev_mode && !data.gcp) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			path: ['gcp'],
			message: 'GCP configuration is required when dev_mode is not enabled',
		});
	}

	// Cross-reference validation: relationship source/target must reference entity type names
	const entityTypeNames = new Set(data.ontology.entity_types.map((et) => et.name));

	for (let i = 0; i < data.ontology.relationships.length; i++) {
		const rel = data.ontology.relationships[i];

		if (!entityTypeNames.has(rel.source)) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['ontology', 'relationships', i, 'source'],
				message: `Relationship "${rel.name}" references unknown entity type "${rel.source}" as source. Available types: ${[...entityTypeNames].join(', ')}`,
			});
		}

		if (!entityTypeNames.has(rel.target)) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['ontology', 'relationships', i, 'target'],
				message: `Relationship "${rel.name}" references unknown entity type "${rel.target}" as target. Available types: ${[...entityTypeNames].join(', ')}`,
			});
		}
	}
});

// Export section schemas for reuse
export {
	analysisSchema,
	cloudSqlSchema,
	deduplicationSchema,
	embeddingSchema,
	enrichmentSchema,
	entityResolutionSchema,
	entityTypeSchema,
	extractionSchema,
	gcpSchema,
	groundingSchema,
	ingestionSchema,
	ontologySchema,
	patternDiscoverySchema,
	pipelineSchema,
	projectSchema,
	relationshipSchema,
	retrievalSchema,
	safetySchema,
	storageSchema,
	thresholdsSchema,
	visualIntelligenceSchema,
};
