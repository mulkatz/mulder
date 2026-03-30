// ── Shared error hierarchy ──────────────────────────────────
export {
	MulderError,
	ConfigError,
	PipelineError,
	DatabaseError,
	ExternalServiceError,
	CONFIG_ERROR_CODES,
	PIPELINE_ERROR_CODES,
	DATABASE_ERROR_CODES,
	EXTERNAL_SERVICE_ERROR_CODES,
	TAXONOMY_ERROR_CODES,
	isMulderError,
	isRetryableError,
} from './shared/errors.js';

export type {
	ConfigErrorCode,
	PipelineErrorCode,
	DatabaseErrorCode,
	ExternalServiceErrorCode,
	TaxonomyErrorCode,
	MulderErrorCode,
} from './shared/errors.js';

// ── Logger ──────────────────────────────────────────────────
export {
	createLogger,
	createChildLogger,
	withDuration,
} from './shared/logger.js';

export type {
	Logger,
	LoggerOptions,
	ChildLoggerContext,
} from './shared/logger.js';

// ── Database ─────────────────────────────────────────────────
export {
	closeAllPools,
	getQueryPool,
	getWorkerPool,
	getMigrationStatus,
	runMigrations,
} from './database/index.js';

export type {
	MigrationResult,
	MigrationStatus,
} from './database/index.js';

// ── Config ──────────────────────────────────────────────────
export {
	ConfigValidationError,
	CONFIG_DEFAULTS,
	loadConfig,
	mulderConfigSchema,
} from './config/index.js';

export type {
	AnalysisConfig,
	CloudSqlConfig,
	ConfigIssue,
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
	ThresholdsConfig,
	VisualIntelligenceConfig,
} from './config/index.js';

// ── Service abstraction ─────────────────────────────────────
export { createServiceRegistry } from './shared/registry.js';
export { closeGcpClients } from './shared/gcp.js';

export type {
	DocumentAiResult,
	DocumentAiService,
	EmbeddingResult,
	EmbeddingService,
	FirestoreService,
	GroundedGenerateOptions,
	GroundedGenerateResult,
	LlmService,
	ServiceMode,
	Services,
	StorageListResult,
	StorageService,
	StructuredGenerateOptions,
	TextGenerateOptions,
} from './shared/services.js';

// ── Retry ───────────────────────────────────────────────────
export { withRetry } from './shared/retry.js';

export type { RetryOptions } from './shared/retry.js';

// ── Rate limiter ────────────────────────────────────────────
export { RateLimiter } from './shared/rate-limiter.js';

export type { RateLimiterOptions } from './shared/rate-limiter.js';
