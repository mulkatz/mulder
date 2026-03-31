// ── Shared error hierarchy ──────────────────────────────────

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
// ── Config ──────────────────────────────────────────────────
export {
	CONFIG_DEFAULTS,
	ConfigValidationError,
	loadConfig,
	mulderConfigSchema,
} from './config/index.js';
export type {
	CreateSourceInput,
	MigrationResult,
	MigrationStatus,
	Source,
	SourceFilter,
	SourceStatus,
	SourceStep,
	SourceStepStatus,
	UpdateSourceInput,
	UpsertSourceStepInput,
} from './database/index.js';
// ── Database ─────────────────────────────────────────────────
export {
	closeAllPools,
	countSources,
	createSource,
	deleteSource,
	findAllSources,
	findSourceByHash,
	findSourceById,
	findSourceStep,
	findSourceSteps,
	getMigrationStatus,
	getQueryPool,
	getWorkerPool,
	runMigrations,
	updateSource,
	updateSourceStatus,
	upsertSourceStep,
} from './database/index.js';
export type { NativeTextDetectOptions, NativeTextResult } from './pipeline/index.js';
// ── Pipeline utilities ─────────────────────────────────────
export { detectNativeText } from './pipeline/index.js';
export type {
	ConfigErrorCode,
	DatabaseErrorCode,
	ExternalServiceErrorCode,
	IngestErrorCode,
	MulderErrorCode,
	PipelineErrorCode,
	TaxonomyErrorCode,
} from './shared/errors.js';
export {
	CONFIG_ERROR_CODES,
	ConfigError,
	DATABASE_ERROR_CODES,
	DatabaseError,
	EXTERNAL_SERVICE_ERROR_CODES,
	ExternalServiceError,
	INGEST_ERROR_CODES,
	IngestError,
	isMulderError,
	isRetryableError,
	MulderError,
	PIPELINE_ERROR_CODES,
	PipelineError,
	TAXONOMY_ERROR_CODES,
} from './shared/errors.js';
export { closeGcpClients } from './shared/gcp.js';
export type {
	ChildLoggerContext,
	Logger,
	LoggerOptions,
} from './shared/logger.js';
// ── Logger ──────────────────────────────────────────────────
export {
	createChildLogger,
	createLogger,
	withDuration,
} from './shared/logger.js';
export type { RateLimiterOptions } from './shared/rate-limiter.js';
// ── Rate limiter ────────────────────────────────────────────
export { RateLimiter } from './shared/rate-limiter.js';
// ── Service abstraction ─────────────────────────────────────
export { createServiceRegistry } from './shared/registry.js';
export type { RetryOptions } from './shared/retry.js';
// ── Retry ───────────────────────────────────────────────────
export { withRetry } from './shared/retry.js';
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
export type { StepError } from './shared/types.js';
