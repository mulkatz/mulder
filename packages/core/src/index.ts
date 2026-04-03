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
	TaxonomyConfig,
	ThresholdsConfig,
	VertexConfig,
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
	AttributeCandidate,
	CreateEntityAliasInput,
	CreateEntityInput,
	CreateSourceInput,
	CreateStoryInput,
	CreateTaxonomyEntryInput,
	EmbeddingCandidate,
	Entity,
	EntityAlias,
	EntityFilter,
	MigrationResult,
	MigrationStatus,
	NormalizationResult,
	Source,
	SourceFilter,
	SourceStatus,
	SourceStep,
	SourceStepStatus,
	Story,
	StoryFilter,
	StoryStatus,
	TaxonomyEntry,
	TaxonomyEntryStatus,
	TaxonomyFilter,
	TaxonomySimilarityMatch,
	UpdateEntityInput,
	UpdateSourceInput,
	UpdateStoryInput,
	UpdateTaxonomyEntryInput,
	UpsertSourceStepInput,
} from './database/index.js';
// ── Database ─────────────────────────────────────────────────
export {
	closeAllPools,
	countEntities,
	countSources,
	countStories,
	countTaxonomyEntries,
	createEntity,
	createEntityAlias,
	createSource,
	createStory,
	createTaxonomyEntry,
	deleteSource,
	deleteSourceStep,
	deleteStoriesBySourceId,
	deleteStory,
	deleteTaxonomyEntry,
	findAliasesByEntityId,
	findAllEntities,
	findAllSources,
	findAllStories,
	findAllTaxonomyEntries,
	findCandidatesByAttributes,
	findCandidatesByEmbedding,
	findEntityByAlias,
	findEntityById,
	findSourceByHash,
	findSourceById,
	findSourceStep,
	findSourceSteps,
	findStoriesBySourceId,
	findStoryById,
	findTaxonomyEntryById,
	findTaxonomyEntryByName,
	getMigrationStatus,
	getQueryPool,
	getWorkerPool,
	runMigrations,
	searchTaxonomyBySimilarity,
	updateEntity,
	updateEntityEmbedding,
	updateSource,
	updateSourceStatus,
	updateStory,
	updateStoryStatus,
	updateTaxonomyEntry,
	upsertSourceStep,
} from './database/index.js';
// ── LLM cache ────────────────────────────────────────────────
export type { CacheEntry, CacheStats, LlmCache } from './llm-cache.js';
export { createLlmCache, DEFAULT_CACHE_DB_PATH } from './llm-cache.js';
export type { NativeTextDetectOptions, NativeTextResult, PdfMetadata } from './pipeline/index.js';
// ── Pipeline utilities ─────────────────────────────────────
export { detectNativeText, extractPdfMetadata } from './pipeline/index.js';
// ── Prompt template engine ─────────────────────────────────
export { clearPromptCaches, listTemplates, renderPrompt } from './prompts/index.js';
// ── Cache hash ───────────────────────────────────────────────
export type { CacheKeyParams } from './shared/cache-hash.js';
export { computeCacheKey } from './shared/cache-hash.js';
export type {
	ConfigErrorCode,
	DatabaseErrorCode,
	ExternalServiceErrorCode,
	ExtractErrorCode,
	IngestErrorCode,
	MulderErrorCode,
	PipelineErrorCode,
	PromptErrorCode,
	SegmentErrorCode,
	TaxonomyErrorCode,
} from './shared/errors.js';
export {
	CONFIG_ERROR_CODES,
	ConfigError,
	DATABASE_ERROR_CODES,
	DatabaseError,
	EXTERNAL_SERVICE_ERROR_CODES,
	EXTRACT_ERROR_CODES,
	ExternalServiceError,
	ExtractError,
	INGEST_ERROR_CODES,
	IngestError,
	isMulderError,
	isRetryableError,
	MulderError,
	PIPELINE_ERROR_CODES,
	PipelineError,
	PROMPT_ERROR_CODES,
	PromptError,
	SEGMENT_ERROR_CODES,
	SegmentError,
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
export { createGcpServices } from './shared/services.gcp.js';
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
// ── Vertex AI wrapper ────────────────────────────────────────
export type { VertexClient, VertexClientOptions } from './vertex.js';
export { createVertexClient } from './vertex.js';
