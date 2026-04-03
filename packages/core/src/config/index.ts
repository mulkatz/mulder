/**
 * Config module barrel export.
 * Public API: loadConfig, MulderConfig, ConfigValidationError, mulderConfigSchema
 */

export { CONFIG_DEFAULTS } from './defaults.js';
export type { ConfigIssue } from './errors.js';
export { ConfigValidationError } from './errors.js';
export { loadConfig } from './loader.js';
export { mulderConfigSchema } from './schema.js';
export type {
	AnalysisConfig,
	CloudSqlConfig,
	DeduplicationConfig,
	DocumentAiConfig,
	EmbeddingConfig,
	EnrichmentConfig,
	EntityResolutionConfig,
	EntityTypeConfig,
	ExtractionConfig,
	GcpConfig,
	GroundingConfig,
	IngestionConfig,
	MulderConfig,
	OntologyConfig,
	PatternDiscoveryConfig,
	PipelineConfig,
	ProjectConfig,
	RelationshipConfig,
	RetrievalConfig,
	SafetyConfig,
	StorageConfig,
	TaxonomyConfig,
	ThresholdsConfig,
	VertexConfig,
	VisualIntelligenceConfig,
} from './types.js';
