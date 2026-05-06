/**
 * Config module barrel export.
 * Public API: loadConfig, MulderConfig, ConfigValidationError, mulderConfigSchema
 */

export { CONFIG_DEFAULTS } from './defaults.js';
export type { ConfigIssue } from './errors.js';
export { ConfigValidationError } from './errors.js';
export { loadConfig } from './loader.js';
export type { ReprocessHashStepName } from './reprocess-hash.js';
export { computeReprocessConfigHash, getReprocessConfigSubset } from './reprocess-hash.js';
export { mulderConfigSchema } from './schema.js';
export type {
	AccessControlConfig,
	AccessControlSensitivityConfig,
	AnalysisConfig,
	ApiAuthConfig,
	ApiAuthKeyConfig,
	ApiBudgetConfig,
	ApiConfig,
	ApiRateLimitingConfig,
	CloudSqlConfig,
	ContradictionManagementConfig,
	CredibilityConfig,
	CredibilityDimensionConfig,
	DeduplicationConfig,
	DocumentAiConfig,
	DocumentQualityConfig,
	EmbeddingConfig,
	EnrichmentConfig,
	EntityResolutionConfig,
	EntityTypeConfig,
	ExtractionConfig,
	GcpConfig,
	GroundingConfig,
	IngestionConfig,
	IngestProvenanceConfig,
	MulderConfig,
	OntologyConfig,
	PatternDiscoveryConfig,
	PipelineConfig,
	ProjectConfig,
	RelationshipConfig,
	RetrievalConfig,
	SafetyConfig,
	SourceRollbackConfig,
	StorageConfig,
	TaxonomyConfig,
	ThresholdsConfig,
	VertexConfig,
	VisualIntelligenceConfig,
} from './types.js';
