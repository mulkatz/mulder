/**
 * TypeScript types derived from Zod schemas via z.infer<>.
 * Never hand-write interfaces that duplicate schema structure.
 */

import type { z } from 'zod';
import type {
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
	groundingSchema,
	ingestionSchema,
	ingestProvenanceSchema,
	mulderConfigSchema,
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
} from './schema.js';

// --- Section Types ---

export type ProjectConfig = z.infer<typeof projectSchema>;
export type AccessControlConfig = z.infer<typeof accessControlSchema>;
export type AccessControlSensitivityConfig = z.infer<typeof accessControlSensitivitySchema>;
export type ApiConfig = z.infer<typeof apiSchema>;
export type ApiAuthKeyConfig = ApiConfig['auth']['api_keys'][number];
export type ApiAuthConfig = ApiConfig['auth'];
export type ApiRateLimitingConfig = ApiConfig['rate_limiting'];
export type ApiBudgetConfig = z.infer<typeof apiBudgetSchema>;
export type GcpConfig = z.infer<typeof gcpSchema>;
export type CloudSqlConfig = z.infer<typeof cloudSqlSchema>;
export type StorageConfig = z.infer<typeof storageSchema>;
export type DocumentAiConfig = z.infer<typeof documentAiSchema>;
export type IngestionConfig = z.infer<typeof ingestionSchema>;
export type ExtractionConfig = z.infer<typeof extractionSchema>;
export type EnrichmentConfig = z.infer<typeof enrichmentSchema>;
export type AssertionClassificationConfig = z.infer<typeof assertionClassificationSchema>;
export type EntityResolutionConfig = z.infer<typeof entityResolutionSchema>;
export type DeduplicationConfig = z.infer<typeof deduplicationSchema>;
export type DocumentQualityConfig = z.infer<typeof documentQualitySchema>;
export type EmbeddingConfig = z.infer<typeof embeddingSchema>;
export type RetrievalConfig = z.infer<typeof retrievalSchema>;
export type GroundingConfig = z.infer<typeof groundingSchema>;
export type IngestProvenanceConfig = z.infer<typeof ingestProvenanceSchema>;
export type AnalysisConfig = z.infer<typeof analysisSchema>;
export type TaxonomyConfig = z.infer<typeof taxonomySchema>;
export type ThresholdsConfig = z.infer<typeof thresholdsSchema>;
export type PipelineConfig = z.infer<typeof pipelineSchema>;
export type SafetyConfig = z.infer<typeof safetySchema>;
export type SourceRollbackConfig = z.infer<typeof sourceRollbackSchema>;
export type CredibilityConfig = z.infer<typeof credibilitySchema>;
export type CredibilityDimensionConfig = z.infer<typeof credibilityDimensionSchema>;
export type VertexConfig = z.infer<typeof vertexSchema>;
export type VisualIntelligenceConfig = z.infer<typeof visualIntelligenceSchema>;
export type PatternDiscoveryConfig = z.infer<typeof patternDiscoverySchema>;

// --- Ontology Types ---

export type EntityTypeConfig = z.infer<typeof entityTypeSchema>;
export type RelationshipConfig = z.infer<typeof relationshipSchema>;
export type OntologyConfig = z.infer<typeof ontologySchema>;

// --- Top-Level Config ---

export type MulderConfig = z.infer<typeof mulderConfigSchema>;
