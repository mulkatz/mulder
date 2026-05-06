/**
 * Zod schemas for mulder.config.yaml — mirrors the example config exactly.
 * All optional fields have sensible defaults defined here.
 * Types are derived from these schemas via z.infer<> in types.ts.
 */

import { z } from 'zod';
import { PII_TYPES, SENSITIVITY_LEVELS } from '../shared/sensitivity.js';

/**
 * Zod 4 helper: `.default({})` no longer works because the default must match
 * the OUTPUT type (all property defaults filled in). This helper parses `{}`
 * through the schema to produce a correctly-typed default value.
 */
function defaults<T extends z.ZodObject<z.ZodRawShape>>(schema: T): z.output<T> {
	return schema.parse({});
}

const sensitivityLevelSchema = z.enum(SENSITIVITY_LEVELS);

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

// --- API ---

const apiAuthKeySchema = z.object({
	name: z.string().min(1),
	key: z.string().min(1),
});

const apiBrowserAuthSchema = z.object({
	enabled: z.boolean().default(true),
	cookie_name: z.string().min(1).default('mulder_session'),
	session_secret: z.string().min(1).default('dev-insecure-change-me'),
	session_ttl_hours: z.number().positive().int().default(168),
	invitation_ttl_hours: z.number().positive().int().default(168),
	cookie_secure: z.boolean().default(false),
	same_site: z.enum(['Strict', 'Lax', 'None']).default('Lax'),
});

const apiAuthSchema = z.object({
	api_keys: z.array(apiAuthKeySchema).default([]),
	browser: apiBrowserAuthSchema.default(defaults(apiBrowserAuthSchema)),
});

const apiRateLimitingSchema = z.object({
	enabled: z.boolean().default(true),
});

const apiBudgetSchema = z.object({
	enabled: z.boolean().default(true),
	monthly_limit_usd: z.number().positive().default(50),
	extract_per_page_usd: z.number().nonnegative().default(0.006),
	segment_per_page_usd: z.number().nonnegative().default(0.002),
	enrich_per_source_usd: z.number().nonnegative().default(0.015),
	embed_per_source_usd: z.number().nonnegative().default(0.004),
	graph_per_source_usd: z.number().nonnegative().default(0.001),
});

const apiObj = z.object({
	port: z.number().int().positive().default(8080),
	auth: apiAuthSchema.default(defaults(apiAuthSchema)),
	rate_limiting: apiRateLimitingSchema.default(defaults(apiRateLimitingSchema)),
	budget: apiBudgetSchema.default(defaults(apiBudgetSchema)),
});
const apiSchema = apiObj.default(defaults(apiObj));

// --- GCP ---

const cloudSqlSchema = z.object({
	instance_name: z.string().min(1),
	database: z.string().min(1),
	tier: z.string().default('db-custom-2-8192'),
	host: z.string().min(1).default('localhost'),
	port: z.number().int().positive().default(5432),
	user: z.string().min(1).default('mulder'),
	password: z.string().optional(),
});

const storageSchema = z.object({
	bucket: z.string().min(1),
});

const documentAiSchema = z.object({
	processor_id: z.string().min(1),
	/**
	 * Document AI multi-region endpoint. Document AI processors live in
	 * either `eu` or `us` — sub-regions like `europe-west1` are not valid
	 * processor locations and will produce a 404 at the API endpoint.
	 */
	location: z.enum(['eu', 'us']).default('eu'),
});

const gcpSchema = z.object({
	project_id: z.string().min(1),
	region: z.string().min(1),
	cloud_sql: cloudSqlSchema,
	storage: storageSchema,
	document_ai: documentAiSchema,
});

// --- Ingestion ---

const ingestionObj = z.object({
	max_file_size_mb: z.number().positive().default(100),
	max_pages: z.number().positive().int().default(2000),
});
const ingestionSchema = ingestionObj.default(defaults(ingestionObj));

// --- Ingest Provenance ---

const ingestProvenanceRequiredMetadataSchema = z.object({
	channel: z.boolean().default(true),
	submitted_by: z.boolean().default(true),
	collection_id: z.boolean().default(false),
	original_source: z.boolean().default(false),
	custody_chain: z.boolean().default(false),
});

const ingestProvenanceArchivesSchema = z.object({
	auto_register: z.boolean().default(true),
});

const collectionDefaultPolicySchema = z.object({
	name: z.string().min(1),
	description: z.string().default(''),
	type: z.enum(['archive_mirror', 'thematic', 'import_batch', 'curated', 'other']).default('import_batch'),
	visibility: z.enum(['private', 'team', 'public']).default('private'),
	created_by: z.string().min(1).default('system'),
	tags: z.array(z.string().min(1)).default([]),
});

const ingestProvenanceCollectionsSchema = z.object({
	auto_create_from_archive: z.boolean().default(true),
	auto_tag_from_path_segments: z.boolean().default(true),
	default_collection: collectionDefaultPolicySchema.nullable().default(null),
	default_sensitivity_level: sensitivityLevelSchema.default('internal'),
	default_language: z.string().min(1).default('und'),
	default_credibility_profile_id: z.string().uuid().nullable().default(null),
});

const ingestProvenanceObj = z.object({
	required_metadata: ingestProvenanceRequiredMetadataSchema.default(defaults(ingestProvenanceRequiredMetadataSchema)),
	archives: ingestProvenanceArchivesSchema.default(defaults(ingestProvenanceArchivesSchema)),
	collections: ingestProvenanceCollectionsSchema.default(defaults(ingestProvenanceCollectionsSchema)),
});
const ingestProvenanceSchema = ingestProvenanceObj.default(defaults(ingestProvenanceObj));

// --- Extraction ---

const segmentationConfigSchema = z.object({
	model: z.string().default('gemini-2.5-flash'),
});

const extractionObj = z.object({
	native_text_threshold: z.number().min(0).max(1).default(0.9),
	confidence_threshold: z.number().min(0).max(1).default(0.85),
	max_vision_pages: z.number().positive().int().default(20),
	segmentation: segmentationConfigSchema.default(defaults(segmentationConfigSchema)),
});
const extractionSchema = extractionObj.default(defaults(extractionObj));

// --- Document Quality ---

const documentQualityAssessmentSchema = z.object({
	method: z.enum(['ocr_confidence', 'gemini_vision', 'both']).default('ocr_confidence'),
	engine: z.string().min(1).nullable().default(null),
	ocr_confidence_threshold: z.number().min(0).max(1).default(0.7),
	native_text_ratio_threshold: z.number().min(0).max(1).default(0.5),
});

const extractionPathSchema = z.enum([
	'standard',
	'enhanced_ocr',
	'visual_extraction',
	'handwriting_recognition',
	'manual_transcription_required',
	'skip',
]);

function documentQualityRouteSchema(defaultPath: z.infer<typeof extractionPathSchema>) {
	return z.object({
		path: extractionPathSchema.default(defaultPath),
		fallback: extractionPathSchema.optional(),
		create_manual_task: z.boolean().optional(),
	});
}

const highQualityRouteSchema = documentQualityRouteSchema('standard');
const mediumQualityRouteSchema = documentQualityRouteSchema('enhanced_ocr');
const lowQualityRouteSchema = documentQualityRouteSchema('visual_extraction');
const unusableQualityRouteSchema = documentQualityRouteSchema('skip');

const documentQualityRoutingSchema = z.object({
	high: highQualityRouteSchema.default({ path: 'standard' }),
	medium: mediumQualityRouteSchema.default({ path: 'enhanced_ocr', fallback: 'visual_extraction' }),
	low: lowQualityRouteSchema.default({ path: 'visual_extraction', fallback: 'manual_transcription_required' }),
	unusable: unusableQualityRouteSchema.default({ path: 'skip', create_manual_task: false }),
});

const documentQualityPropagationSchema = z.object({
	enabled: z.boolean().default(true),
	low_quality_embedding_weight: z.number().min(0).max(1).default(0.5),
	low_quality_assertion_penalty: z.number().min(0).max(1).default(0.3),
});

const documentQualityManualQueueSchema = z.object({
	enabled: z.boolean().default(false),
	notify_reviewers: z.boolean().default(false),
	priority: z.enum(['low', 'normal', 'high']).default('normal'),
});

const documentQualityObj = z.object({
	enabled: z.boolean().default(true),
	assessment: documentQualityAssessmentSchema.default(defaults(documentQualityAssessmentSchema)),
	routing: documentQualityRoutingSchema.default(defaults(documentQualityRoutingSchema)),
	quality_propagation: documentQualityPropagationSchema.default(defaults(documentQualityPropagationSchema)),
	manual_queue: documentQualityManualQueueSchema.default(defaults(documentQualityManualQueueSchema)),
});
const documentQualitySchema = documentQualityObj.default(defaults(documentQualityObj));

// --- Access Control ---

const piiTypeSchema = z.enum(PII_TYPES);

const accessControlSensitivitySchema = z.object({
	levels: z.array(sensitivityLevelSchema).default([...SENSITIVITY_LEVELS]),
	default_level: sensitivityLevelSchema.default('internal'),
	auto_detection: z.boolean().default(true),
	propagation: z.enum(['upward']).default('upward'),
	pii_types: z.array(piiTypeSchema).default([...PII_TYPES]),
});

const accessControlRbacSchema = z.object({
	roles_source: z.string().min(1).default('config/roles.yaml'),
	default_role: z.string().min(1).default('analyst'),
});

const accessControlExternalQueryGateSchema = z.object({
	enabled: z.boolean().default(false),
});

const accessControlObj = z.object({
	enabled: z.boolean().default(true),
	sensitivity: accessControlSensitivitySchema.default(defaults(accessControlSensitivitySchema)),
	rbac: accessControlRbacSchema.default(defaults(accessControlRbacSchema)),
	external_query_gate: accessControlExternalQueryGateSchema.default(defaults(accessControlExternalQueryGateSchema)),
});
const accessControlSchema = accessControlObj.default(defaults(accessControlObj));

// --- Source Rollback ---

const sourceRollbackObj = z.object({
	undo_window_hours: z.number().positive().int().default(72),
	auto_purge_after_undo_window: z.boolean().default(true),
	require_reason: z.boolean().default(true),
	require_confirmation: z.boolean().default(true),
	orphan_handling: z.enum(['mark', 'delete']).default('mark'),
	journal_annotation: z.boolean().default(true),
	notify_on_purge: z.boolean().default(true),
});
const sourceRollbackSchema = sourceRollbackObj.default(defaults(sourceRollbackObj));

// --- Credibility ---

const credibilityDimensionSchema = z.object({
	id: z.string().min(1),
	label: z.string().min(1),
});

const credibilityObj = z.object({
	enabled: z.boolean().default(true),
	dimensions: z
		.array(credibilityDimensionSchema)
		.min(1)
		.default([
			{ id: 'institutional_authority', label: 'Institutional authority' },
			{ id: 'domain_track_record', label: 'Domain track record' },
			{ id: 'conflict_of_interest', label: 'Conflict of interest' },
			{ id: 'transparency', label: 'Transparency / verifiability' },
			{ id: 'consistency', label: 'Internal consistency over time' },
		]),
	auto_profile_on_ingest: z.boolean().default(true),
	require_human_review: z.boolean().default(true),
	display_in_reports: z.boolean().default(true),
	agent_instruction: z.enum(['weight_but_never_exclude']).default('weight_but_never_exclude'),
});
const credibilitySchema = credibilityObj.default(defaults(credibilityObj));

// --- Enrichment ---

const assertionClassificationSchema = z.object({
	enabled: z.boolean().default(true),
	conservative_labeling: z.boolean().default(true),
	require_confidence_metadata: z.boolean().default(true),
	default_provenance: z.enum(['llm_auto', 'human_reviewed', 'author_explicit']).default('llm_auto'),
	reviewable: z.boolean().default(true),
	review_depth: z.enum(['spot_check', 'single_review', 'double_review']).default('spot_check'),
	spot_check_percentage: z.number().int().min(0).max(100).default(20),
});

const enrichmentObj = z.object({
	model: z.string().default('gemini-2.5-flash'),
	max_story_tokens: z.number().positive().int().default(15000),
	assertion_classification: assertionClassificationSchema.default(defaults(assertionClassificationSchema)),
});
const enrichmentSchema = enrichmentObj.default(defaults(enrichmentObj));

// --- Taxonomy ---

const taxonomyObj = z.object({
	normalization_threshold: z.number().min(0).max(1).default(0.4),
});
const taxonomySchema = taxonomyObj.default(defaults(taxonomyObj));

// --- Entity Resolution ---

const resolutionStrategySchema = z.object({
	type: z.enum(['attribute_match', 'embedding_similarity', 'llm_assisted']),
	enabled: z.boolean().default(true),
	threshold: z.number().min(0).max(1).optional(),
	model: z.string().optional(),
});

const entityResolutionObj = z.object({
	strategies: z.array(resolutionStrategySchema).default([
		{ type: 'attribute_match', enabled: true },
		{ type: 'embedding_similarity', enabled: true, threshold: 0.85 },
		{ type: 'llm_assisted', enabled: true, model: 'gemini-2.5-flash' },
	]),
	cross_lingual: z.boolean().default(true),
});
const entityResolutionSchema = entityResolutionObj.default(defaults(entityResolutionObj));

// --- Deduplication ---

const segmentLevelSchema = z.object({
	strategy: z.enum(['minhash', 'embedding_similarity']).default('minhash'),
	similarity_threshold: z.number().min(0).max(1).default(0.9),
});

const corroborationFilterSchema = z.object({
	same_author_is_one_source: z.boolean().default(true),
	similarity_above_threshold_is_one_source: z.boolean().default(true),
});

const deduplicationObj = z.object({
	enabled: z.boolean().default(true),
	segment_level: segmentLevelSchema.default(defaults(segmentLevelSchema)),
	corroboration_filter: corroborationFilterSchema.default(defaults(corroborationFilterSchema)),
	min_independent_sources: z.number().positive().int().default(3),
});
const deduplicationSchema = deduplicationObj.default(defaults(deduplicationObj));

// --- Graph Step ---

const graphObj = z.object({
	/**
	 * When true, the graph step creates an O(n²) `co_occurs_with` edge between
	 * every pair of entities in a story that has no explicit relationships
	 * from enrich. A 50-entity story produces 1225 edges; a 100-entity story
	 * produces 4950. Only enable this if you have a specific downstream
	 * consumer that needs co-occurrence fallback data; otherwise leave it off
	 * to keep `entity_edges` signal-dense at archive scale.
	 */
	cooccurrence_fallback: z.boolean().default(false),
});
const graphSchema = graphObj.default(defaults(graphObj));

// --- Embedding ---

const embeddingObj = z.object({
	model: z.string().default('text-embedding-004'),
	storage_dimensions: z.number().positive().int().default(768),
	chunk_size_tokens: z.number().positive().int().default(512),
	chunk_overlap_tokens: z.number().nonnegative().int().default(50),
	questions_per_chunk: z.number().nonnegative().int().default(3),
});
const embeddingSchema = embeddingObj.default(defaults(embeddingObj));

// --- Retrieval ---

const rerankSchema = z.object({
	enabled: z.boolean().default(true),
	model: z.string().default('gemini-2.5-flash'),
	candidates: z.number().positive().int().default(20),
	/**
	 * Minimum reranker score (after Gemini Flash re-ranks the fused list)
	 * required for the orchestrator to surface a result. When the top
	 * reranker score is below this AND the confidence object reports the
	 * query as degraded, the orchestrator returns an empty result list with
	 * `confidence.message = 'no_meaningful_matches'` instead of the top-k
	 * fallback. Defaults to 0.0 — set to 0.3 or higher to filter
	 * off-corpus queries (e.g. "Rezept für Apfelstrudel" against a UFO
	 * archive).
	 */
	min_score: z.number().min(0).max(1).default(0.0),
});

const vectorStrategySchema = z.object({
	weight: z.number().min(0).max(1).default(0.5),
	ef_search: z.number().int().positive().default(40),
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
	vector: vectorStrategySchema.default(defaults(vectorStrategySchema)),
	fulltext: fulltextStrategySchema.default(defaults(fulltextStrategySchema)),
	graph: graphStrategySchema.default(defaults(graphStrategySchema)),
});

const retrievalObj = z.object({
	default_strategy: z.enum(['vector', 'fulltext', 'graph', 'hybrid']).default('hybrid'),
	top_k: z.number().positive().int().default(10),
	rerank: rerankSchema.default(defaults(rerankSchema)),
	strategies: retrievalStrategiesSchema.default(defaults(retrievalStrategiesSchema)),
});
const retrievalSchema = retrievalObj.default(defaults(retrievalObj));

// --- Grounding (v2.0) ---

const groundingObj = z.object({
	enabled: z.boolean().default(false),
	mode: z.enum(['pipeline', 'on_demand', 'disabled']).default('on_demand'),
	enrich_types: z.array(z.string().min(1)).default(['location', 'person', 'organization']),
	cache_ttl_days: z.number().positive().int().default(30),
	min_confidence: z.number().min(0).max(1).default(0.7),
	exclude_domains: z.array(z.string().min(1)).default([]),
});
const groundingSchema = groundingObj.default(defaults(groundingObj));

// --- Analysis (v2.0) ---

const analysisObj = z.object({
	enabled: z.boolean().default(false),
	contradictions: z.boolean().default(true),
	reliability: z.boolean().default(true),
	evidence_chains: z.boolean().default(true),
	evidence_theses: z.array(z.string().min(1)).default([]),
	spatio_temporal: z.boolean().default(true),
	cluster_window_days: z.number().positive().int().default(30),
});
const analysisSchema = analysisObj.default(defaults(analysisObj));

// --- Thresholds ---

const thresholdsObj = z.object({
	taxonomy_bootstrap: z.number().nonnegative().int().default(25),
	corroboration_meaningful: z.number().nonnegative().int().default(50),
	graph_community_detection: z.number().nonnegative().int().default(100),
	temporal_clustering: z.number().nonnegative().int().default(30),
	source_reliability: z.number().nonnegative().int().default(50),
});
const thresholdsSchema = thresholdsObj.default(defaults(thresholdsObj));

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
	graph: z.number().positive().int().default(50),
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

const pipelineObj = z.object({
	concurrency: concurrencySchema.default(defaults(concurrencySchema)),
	batch_size: batchSizeSchema.default(defaults(batchSizeSchema)),
	retry: retrySchema.default(defaults(retrySchema)),
	error_handling: errorHandlingSchema.default(defaults(errorHandlingSchema)),
});
const pipelineSchema = pipelineObj.default(defaults(pipelineObj));

// --- Vertex AI ---

const vertexObj = z.object({
	max_concurrent_requests: z.number().int().min(1).max(20).default(2),
});
const vertexSchema = vertexObj.default(defaults(vertexObj));

// --- Safety ---

const safetyObj = z.object({
	max_pages_without_confirm: z.number().positive().int().default(500),
	max_cost_without_confirm_usd: z.number().positive().default(20),
	budget_alert_monthly_usd: z.number().positive().default(100),
	block_production_calls_in_test: z.boolean().default(true),
});
const safetySchema = safetyObj.default(defaults(safetyObj));

// --- Phase 2 (reserved) ---

const visualIntelligenceObj = z.object({
	enabled: z.boolean().default(false),
	extract_images: z.boolean().default(true),
	analyze_images: z.boolean().default(true),
	image_embedding: z.boolean().default(true),
	extract_from_maps: z.boolean().default(true),
	extract_from_diagrams: z.boolean().default(true),
});
const visualIntelligenceSchema = visualIntelligenceObj.default(defaults(visualIntelligenceObj));

const digestSchema = z.object({
	enabled: z.boolean().default(false),
	frequency: z.enum(['daily', 'weekly', 'monthly']).default('weekly'),
});

const patternDiscoveryObj = z.object({
	enabled: z.boolean().default(false),
	run_after_batch: z.boolean().default(true),
	anomaly_detection: z.boolean().default(true),
	temporal_spikes: z.boolean().default(true),
	subgraph_similarity: z.boolean().default(true),
	digest: digestSchema.default(defaults(digestSchema)),
});
const patternDiscoverySchema = patternDiscoveryObj.default(defaults(patternDiscoveryObj));

// --- Top-Level Config Schema ---

/**
 * Base schema without dev_mode conditional validation.
 * Cross-reference validation (ontology relationships) is applied via superRefine.
 */
const baseMulderConfigSchema = z.object({
	project: projectSchema,
	api: apiSchema,
	gcp: gcpSchema.optional(),
	dev_mode: z.boolean().default(false),
	ontology: ontologySchema,
	ingestion: ingestionSchema,
	ingest_provenance: ingestProvenanceSchema,
	extraction: extractionSchema,
	document_quality: documentQualitySchema,
	access_control: accessControlSchema,
	source_rollback: sourceRollbackSchema,
	credibility: credibilitySchema,
	enrichment: enrichmentSchema,
	taxonomy: taxonomySchema,
	entity_resolution: entityResolutionSchema,
	deduplication: deduplicationSchema,
	graph: graphSchema,
	embedding: embeddingSchema,
	retrieval: retrievalSchema,
	grounding: groundingSchema,
	analysis: analysisSchema,
	thresholds: thresholdsSchema,
	pipeline: pipelineSchema,
	safety: safetySchema,
	vertex: vertexSchema,
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
				params: { customCode: 'invalid_reference' },
			});
		}

		if (!entityTypeNames.has(rel.target)) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['ontology', 'relationships', i, 'target'],
				message: `Relationship "${rel.name}" references unknown entity type "${rel.target}" as target. Available types: ${[...entityTypeNames].join(', ')}`,
				params: { customCode: 'invalid_reference' },
			});
		}
	}
});

// Export section schemas for reuse
export {
	accessControlSchema,
	accessControlSensitivitySchema,
	analysisSchema,
	apiBudgetSchema,
	apiSchema,
	assertionClassificationSchema,
	cloudSqlSchema,
	credibilityDimensionSchema,
	credibilitySchema,
	deduplicationSchema,
	documentAiSchema,
	documentQualitySchema,
	embeddingSchema,
	enrichmentSchema,
	entityResolutionSchema,
	entityTypeSchema,
	extractionSchema,
	gcpSchema,
	graphSchema,
	groundingSchema,
	ingestionSchema,
	ingestProvenanceSchema,
	ontologySchema,
	patternDiscoverySchema,
	pipelineSchema,
	projectSchema,
	relationshipSchema,
	retrievalSchema,
	safetySchema,
	sourceRollbackSchema,
	storageSchema,
	taxonomySchema,
	thresholdsSchema,
	vertexSchema,
	visualIntelligenceSchema,
};
