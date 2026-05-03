/**
 * Structured error hierarchy for the Mulder platform.
 *
 * Base `MulderError` with mandatory `code` and optional `context`,
 * plus domain-specific subclasses that enforce typed error codes.
 *
 * @see docs/specs/04_custom_error_classes.spec.md
 * @see docs/functional-spec.md §7.1, §7.2
 */

// ────────────────────────────────────────────────────────────
// Error code constants
// ────────────────────────────────────────────────────────────

/** Config domain error codes. */
export const CONFIG_ERROR_CODES = {
	/** @reserved Config file resolution in CLI commands */
	CONFIG_NOT_FOUND: 'CONFIG_NOT_FOUND',
	CONFIG_INVALID: 'CONFIG_INVALID',
} as const;

export type ConfigErrorCode = (typeof CONFIG_ERROR_CODES)[keyof typeof CONFIG_ERROR_CODES];

/** Pipeline domain error codes. */
export const PIPELINE_ERROR_CODES = {
	/** Source row not found in DB during pipeline run. */
	PIPELINE_SOURCE_NOT_FOUND: 'PIPELINE_SOURCE_NOT_FOUND',
	/** Externally supplied pipeline run row does not exist. */
	PIPELINE_RUN_NOT_FOUND: 'PIPELINE_RUN_NOT_FOUND',
	/** Source status does not match the expected step entry condition. */
	PIPELINE_WRONG_STATUS: 'PIPELINE_WRONG_STATUS',
	/** Retry requested but the latest failed step cannot be retried. */
	PIPELINE_RETRY_CONFLICT: 'PIPELINE_RETRY_CONFLICT',
	/** Requested source-specific step range has no executable work. */
	PIPELINE_INVALID_STEP_RANGE: 'PIPELINE_INVALID_STEP_RANGE',
	/** Monthly budget gate rejected a new accepted run. */
	PIPELINE_BUDGET_EXCEEDED: 'PIPELINE_BUDGET_EXCEEDED',
	/** A pipeline step threw — wraps the underlying step error code. */
	PIPELINE_STEP_FAILED: 'PIPELINE_STEP_FAILED',
	/** @reserved D6 pipeline orchestrator retry exhaustion */
	PIPELINE_RATE_LIMITED: 'PIPELINE_RATE_LIMITED',
} as const;

export type PipelineErrorCode = (typeof PIPELINE_ERROR_CODES)[keyof typeof PIPELINE_ERROR_CODES];

/** Database domain error codes. */
export const DATABASE_ERROR_CODES = {
	DB_CONNECTION_FAILED: 'DB_CONNECTION_FAILED',
	DB_MIGRATION_FAILED: 'DB_MIGRATION_FAILED',
	DB_QUERY_FAILED: 'DB_QUERY_FAILED',
	DB_NOT_FOUND: 'DB_NOT_FOUND',
} as const;

export type DatabaseErrorCode = (typeof DATABASE_ERROR_CODES)[keyof typeof DATABASE_ERROR_CODES];

/** External service domain error codes. */
export const EXTERNAL_SERVICE_ERROR_CODES = {
	EXT_DOCUMENT_AI_FAILED: 'EXT_DOCUMENT_AI_FAILED',
	EXT_VERTEX_AI_FAILED: 'EXT_VERTEX_AI_FAILED',
	EXT_STORAGE_FAILED: 'EXT_STORAGE_FAILED',
} as const;

export type ExternalServiceErrorCode = (typeof EXTERNAL_SERVICE_ERROR_CODES)[keyof typeof EXTERNAL_SERVICE_ERROR_CODES];

/** Taxonomy domain error codes (used by M3+). */
export const TAXONOMY_ERROR_CODES = {
	/** @reserved F1 taxonomy bootstrap command */
	TAXONOMY_BOOTSTRAP_TOO_FEW: 'TAXONOMY_BOOTSTRAP_TOO_FEW',
	/** F1 taxonomy bootstrap — corpus below threshold */
	TAXONOMY_BELOW_THRESHOLD: 'TAXONOMY_BELOW_THRESHOLD',
	/** F2 taxonomy merge — curated YAML validation failed */
	TAXONOMY_VALIDATION_FAILED: 'TAXONOMY_VALIDATION_FAILED',
	/** F2 taxonomy merge — duplicate entries in curated YAML */
	TAXONOMY_DUPLICATE_ENTRY: 'TAXONOMY_DUPLICATE_ENTRY',
	/** @reserved F2 taxonomy merge — referenced ID not found in database (graceful skip, not thrown) */
	TAXONOMY_ID_NOT_FOUND: 'TAXONOMY_ID_NOT_FOUND',
	/** F2 taxonomy merge — transaction failed */
	TAXONOMY_MERGE_FAILED: 'TAXONOMY_MERGE_FAILED',
} as const;

export type TaxonomyErrorCode = (typeof TAXONOMY_ERROR_CODES)[keyof typeof TAXONOMY_ERROR_CODES];

/** Ingest step error codes. */
export const INGEST_ERROR_CODES = {
	INGEST_FILE_NOT_FOUND: 'INGEST_FILE_NOT_FOUND',
	INGEST_NOT_PDF: 'INGEST_NOT_PDF',
	INGEST_UNSUPPORTED_SOURCE_TYPE: 'INGEST_UNSUPPORTED_SOURCE_TYPE',
	INGEST_UNKNOWN_SOURCE_TYPE: 'INGEST_UNKNOWN_SOURCE_TYPE',
	INGEST_FILE_TOO_LARGE: 'INGEST_FILE_TOO_LARGE',
	INGEST_TOO_MANY_PAGES: 'INGEST_TOO_MANY_PAGES',
	INGEST_UPLOAD_FAILED: 'INGEST_UPLOAD_FAILED',
	INGEST_URL_FETCH_FAILED: 'INGEST_URL_FETCH_FAILED',
	/** @reserved M9 cross-format dedup */
	INGEST_DUPLICATE: 'INGEST_DUPLICATE',
} as const;

export type IngestErrorCode = (typeof INGEST_ERROR_CODES)[keyof typeof INGEST_ERROR_CODES];

/** Extract step error codes. */
export const EXTRACT_ERROR_CODES = {
	EXTRACT_SOURCE_NOT_FOUND: 'EXTRACT_SOURCE_NOT_FOUND',
	EXTRACT_INVALID_STATUS: 'EXTRACT_INVALID_STATUS',
	EXTRACT_DOCUMENT_AI_FAILED: 'EXTRACT_DOCUMENT_AI_FAILED',
	EXTRACT_VISION_FALLBACK_FAILED: 'EXTRACT_VISION_FALLBACK_FAILED',
	EXTRACT_NATIVE_TEXT_FAILED: 'EXTRACT_NATIVE_TEXT_FAILED',
	EXTRACT_OFFICE_DOCUMENT_FAILED: 'EXTRACT_OFFICE_DOCUMENT_FAILED',
	EXTRACT_SPREADSHEET_FAILED: 'EXTRACT_SPREADSHEET_FAILED',
	EXTRACT_EMAIL_FAILED: 'EXTRACT_EMAIL_FAILED',
	EXTRACT_URL_FAILED: 'EXTRACT_URL_FAILED',
	EXTRACT_STORAGE_FAILED: 'EXTRACT_STORAGE_FAILED',
	/** @reserved Real GCP page rendering failures */
	EXTRACT_PAGE_RENDER_FAILED: 'EXTRACT_PAGE_RENDER_FAILED',
} as const;

export type ExtractErrorCode = (typeof EXTRACT_ERROR_CODES)[keyof typeof EXTRACT_ERROR_CODES];

/** Segment step error codes. */
export const SEGMENT_ERROR_CODES = {
	SEGMENT_SOURCE_NOT_FOUND: 'SEGMENT_SOURCE_NOT_FOUND',
	SEGMENT_INVALID_STATUS: 'SEGMENT_INVALID_STATUS',
	SEGMENT_LAYOUT_NOT_FOUND: 'SEGMENT_LAYOUT_NOT_FOUND',
	SEGMENT_LLM_FAILED: 'SEGMENT_LLM_FAILED',
	SEGMENT_STORAGE_FAILED: 'SEGMENT_STORAGE_FAILED',
	SEGMENT_NO_STORIES_FOUND: 'SEGMENT_NO_STORIES_FOUND',
} as const;

export type SegmentErrorCode = (typeof SEGMENT_ERROR_CODES)[keyof typeof SEGMENT_ERROR_CODES];

/** Enrich step error codes. */
export const ENRICH_ERROR_CODES = {
	ENRICH_STORY_NOT_FOUND: 'ENRICH_STORY_NOT_FOUND',
	ENRICH_INVALID_STATUS: 'ENRICH_INVALID_STATUS',
	ENRICH_MARKDOWN_NOT_FOUND: 'ENRICH_MARKDOWN_NOT_FOUND',
	ENRICH_LLM_FAILED: 'ENRICH_LLM_FAILED',
	/** @reserved Gemini structured output validation */
	ENRICH_VALIDATION_FAILED: 'ENRICH_VALIDATION_FAILED',
	ENRICH_ENTITY_WRITE_FAILED: 'ENRICH_ENTITY_WRITE_FAILED',
} as const;

export type EnrichErrorCode = (typeof ENRICH_ERROR_CODES)[keyof typeof ENRICH_ERROR_CODES];

/** Embed step error codes. */
export const EMBED_ERROR_CODES = {
	EMBED_STORY_NOT_FOUND: 'EMBED_STORY_NOT_FOUND',
	EMBED_INVALID_STATUS: 'EMBED_INVALID_STATUS',
	EMBED_MARKDOWN_NOT_FOUND: 'EMBED_MARKDOWN_NOT_FOUND',
	EMBED_EMBEDDING_FAILED: 'EMBED_EMBEDDING_FAILED',
	EMBED_QUESTION_GENERATION_FAILED: 'EMBED_QUESTION_GENERATION_FAILED',
	EMBED_CHUNK_WRITE_FAILED: 'EMBED_CHUNK_WRITE_FAILED',
} as const;

export type EmbedErrorCode = (typeof EMBED_ERROR_CODES)[keyof typeof EMBED_ERROR_CODES];

/** Ground step error codes. */
export const GROUND_ERROR_CODES = {
	GROUND_ENTITY_NOT_FOUND: 'GROUND_ENTITY_NOT_FOUND',
	GROUND_DISABLED: 'GROUND_DISABLED',
	GROUND_LLM_FAILED: 'GROUND_LLM_FAILED',
	GROUND_VALIDATION_FAILED: 'GROUND_VALIDATION_FAILED',
	GROUND_WRITE_FAILED: 'GROUND_WRITE_FAILED',
} as const;

export type GroundErrorCode = (typeof GROUND_ERROR_CODES)[keyof typeof GROUND_ERROR_CODES];

/** Graph step error codes. */
export const GRAPH_ERROR_CODES = {
	GRAPH_STORY_NOT_FOUND: 'GRAPH_STORY_NOT_FOUND',
	GRAPH_INVALID_STATUS: 'GRAPH_INVALID_STATUS',
	GRAPH_EDGE_WRITE_FAILED: 'GRAPH_EDGE_WRITE_FAILED',
	GRAPH_DEDUP_FAILED: 'GRAPH_DEDUP_FAILED',
	GRAPH_CORROBORATION_FAILED: 'GRAPH_CORROBORATION_FAILED',
	GRAPH_CONTRADICTION_FAILED: 'GRAPH_CONTRADICTION_FAILED',
} as const;

export type GraphErrorCode = (typeof GRAPH_ERROR_CODES)[keyof typeof GRAPH_ERROR_CODES];

/** Analyze step error codes. */
export const ANALYZE_ERROR_CODES = {
	ANALYZE_DISABLED: 'ANALYZE_DISABLED',
	ANALYZE_CONTEXT_MISSING: 'ANALYZE_CONTEXT_MISSING',
	ANALYZE_LLM_FAILED: 'ANALYZE_LLM_FAILED',
	ANALYZE_VALIDATION_FAILED: 'ANALYZE_VALIDATION_FAILED',
	ANALYZE_WRITE_FAILED: 'ANALYZE_WRITE_FAILED',
	ANALYZE_THESIS_INPUT_MISSING: 'ANALYZE_THESIS_INPUT_MISSING',
	ANALYZE_THESIS_UNRESOLVED: 'ANALYZE_THESIS_UNRESOLVED',
	ANALYZE_TRAVERSAL_FAILED: 'ANALYZE_TRAVERSAL_FAILED',
} as const;

export type AnalyzeErrorCode = (typeof ANALYZE_ERROR_CODES)[keyof typeof ANALYZE_ERROR_CODES];

/** Retrieval domain error codes (vector/fulltext/graph search wrappers + fusion + re-ranking + orchestrator). */
export const RETRIEVAL_ERROR_CODES = {
	RETRIEVAL_INVALID_INPUT: 'RETRIEVAL_INVALID_INPUT',
	RETRIEVAL_EMBEDDING_FAILED: 'RETRIEVAL_EMBEDDING_FAILED',
	RETRIEVAL_QUERY_FAILED: 'RETRIEVAL_QUERY_FAILED',
	RETRIEVAL_DIMENSION_MISMATCH: 'RETRIEVAL_DIMENSION_MISMATCH',
	RETRIEVAL_FUSION_INVALID_WEIGHTS: 'RETRIEVAL_FUSION_INVALID_WEIGHTS',
	RETRIEVAL_FUSION_INVALID_K: 'RETRIEVAL_FUSION_INVALID_K',
	RETRIEVAL_RERANK_FAILED: 'RETRIEVAL_RERANK_FAILED',
	RETRIEVAL_RERANK_INVALID_RESPONSE: 'RETRIEVAL_RERANK_INVALID_RESPONSE',
	RETRIEVAL_ORCHESTRATOR_FAILED: 'RETRIEVAL_ORCHESTRATOR_FAILED',
} as const;

export type RetrievalErrorCode = (typeof RETRIEVAL_ERROR_CODES)[keyof typeof RETRIEVAL_ERROR_CODES];

/** Prompt template engine error codes. */
export const PROMPT_ERROR_CODES = {
	TEMPLATE_NOT_FOUND: 'TEMPLATE_NOT_FOUND',
	TEMPLATE_VARIABLE_MISSING: 'TEMPLATE_VARIABLE_MISSING',
	LOCALE_FILE_NOT_FOUND: 'LOCALE_FILE_NOT_FOUND',
	TEMPLATE_PARSE_ERROR: 'TEMPLATE_PARSE_ERROR',
} as const;

export type PromptErrorCode = (typeof PROMPT_ERROR_CODES)[keyof typeof PROMPT_ERROR_CODES];

/** Union of all Mulder error codes. */
export type MulderErrorCode =
	| ConfigErrorCode
	| PipelineErrorCode
	| DatabaseErrorCode
	| ExternalServiceErrorCode
	| TaxonomyErrorCode
	| IngestErrorCode
	| ExtractErrorCode
	| SegmentErrorCode
	| EnrichErrorCode
	| EmbedErrorCode
	| GroundErrorCode
	| GraphErrorCode
	| AnalyzeErrorCode
	| RetrievalErrorCode
	| PromptErrorCode;

// ────────────────────────────────────────────────────────────
// Error classes
// ────────────────────────────────────────────────────────────

/**
 * Base error for the Mulder platform.
 * All domain errors extend this class, enabling a single
 * `instanceof MulderError` check and code-based switching.
 */
export class MulderError extends Error {
	public readonly code: string;
	public readonly context?: Record<string, unknown>;

	constructor(
		message: string,
		code: string,
		options?: {
			context?: Record<string, unknown>;
			cause?: unknown;
		},
	) {
		super(message, { cause: options?.cause });
		this.name = 'MulderError';
		this.code = code;
		this.context = options?.context;
	}
}

/** Configuration errors (file not found, validation failures). */
export class ConfigError extends MulderError {
	constructor(
		message: string,
		code: ConfigErrorCode,
		options?: {
			context?: Record<string, unknown>;
			cause?: unknown;
		},
	) {
		super(message, code, options);
		this.name = 'ConfigError';
	}
}

/** Pipeline step execution errors. */
export class PipelineError extends MulderError {
	constructor(
		message: string,
		code: PipelineErrorCode,
		options?: {
			context?: Record<string, unknown>;
			cause?: unknown;
		},
	) {
		super(message, code, options);
		this.name = 'PipelineError';
	}
}

/** Database connection and migration errors. */
export class DatabaseError extends MulderError {
	constructor(
		message: string,
		code: DatabaseErrorCode,
		options?: {
			context?: Record<string, unknown>;
			cause?: unknown;
		},
	) {
		super(message, code, options);
		this.name = 'DatabaseError';
	}
}

/** External GCP service errors (Document AI, Vertex AI, Cloud Storage). */
export class ExternalServiceError extends MulderError {
	constructor(
		message: string,
		code: ExternalServiceErrorCode,
		options?: {
			context?: Record<string, unknown>;
			cause?: unknown;
		},
	) {
		super(message, code, options);
		this.name = 'ExternalServiceError';
	}
}

/** Ingest step errors (file validation, upload, dedup). */
export class IngestError extends MulderError {
	constructor(
		message: string,
		code: IngestErrorCode,
		options?: {
			context?: Record<string, unknown>;
			cause?: unknown;
		},
	) {
		super(message, code, options);
		this.name = 'IngestError';
	}
}

/** Extract step errors (extraction failures, storage, page rendering). */
export class ExtractError extends MulderError {
	constructor(
		message: string,
		code: ExtractErrorCode,
		options?: {
			context?: Record<string, unknown>;
			cause?: unknown;
		},
	) {
		super(message, code, options);
		this.name = 'ExtractError';
	}
}

/** Segment step errors (segmentation failures, storage, LLM). */
export class SegmentError extends MulderError {
	constructor(
		message: string,
		code: SegmentErrorCode,
		options?: {
			context?: Record<string, unknown>;
			cause?: unknown;
		},
	) {
		super(message, code, options);
		this.name = 'SegmentError';
	}
}

/** Enrich step errors (entity extraction, taxonomy normalization, resolution). */
export class EnrichError extends MulderError {
	constructor(
		message: string,
		code: EnrichErrorCode,
		options?: {
			context?: Record<string, unknown>;
			cause?: unknown;
		},
	) {
		super(message, code, options);
		this.name = 'EnrichError';
	}
}

/** Embed step errors (chunking, embedding, question generation). */
export class EmbedError extends MulderError {
	constructor(
		message: string,
		code: EmbedErrorCode,
		options?: {
			context?: Record<string, unknown>;
			cause?: unknown;
		},
	) {
		super(message, code, options);
		this.name = 'EmbedError';
	}
}

/** Ground step errors (web enrichment, cache handling, persistence). */
export class GroundError extends MulderError {
	constructor(
		message: string,
		code: GroundErrorCode,
		options?: {
			context?: Record<string, unknown>;
			cause?: unknown;
		},
	) {
		super(message, code, options);
		this.name = 'GroundError';
	}
}

/** Graph step errors (dedup, corroboration, contradiction flagging). */
export class GraphError extends MulderError {
	constructor(
		message: string,
		code: GraphErrorCode,
		options?: {
			context?: Record<string, unknown>;
			cause?: unknown;
		},
	) {
		super(message, code, options);
		this.name = 'GraphError';
	}
}

/** Analyze step errors (contradiction resolution and later analysis passes). */
export class AnalyzeError extends MulderError {
	constructor(
		message: string,
		code: AnalyzeErrorCode,
		options?: {
			context?: Record<string, unknown>;
			cause?: unknown;
		},
	) {
		super(message, code, options);
		this.name = 'AnalyzeError';
	}
}

/** Retrieval errors (vector/fulltext/graph search input validation, query, embedding). */
export class RetrievalError extends MulderError {
	constructor(
		message: string,
		code: RetrievalErrorCode,
		options?: {
			context?: Record<string, unknown>;
			cause?: unknown;
		},
	) {
		super(message, code, options);
		this.name = 'RetrievalError';
	}
}

/** Taxonomy domain errors (bootstrap threshold, normalization). */
export class TaxonomyError extends MulderError {
	constructor(
		message: string,
		code: TaxonomyErrorCode,
		options?: {
			context?: Record<string, unknown>;
			cause?: unknown;
		},
	) {
		super(message, code, options);
		this.name = 'TaxonomyError';
	}
}

/** Prompt template engine errors (missing templates, variables, locale files). */
export class PromptError extends MulderError {
	constructor(
		message: string,
		code: PromptErrorCode,
		options?: {
			context?: Record<string, unknown>;
			cause?: unknown;
		},
	) {
		super(message, code, options);
		this.name = 'PromptError';
	}
}

// ────────────────────────────────────────────────────────────
// Type guards
// ────────────────────────────────────────────────────────────

/** Narrows `unknown` to `MulderError`. */
export function isMulderError(error: unknown): error is MulderError {
	return error instanceof MulderError;
}

/**
 * Returns `true` for errors that warrant retry with backoff:
 * all external service errors and pipeline rate-limit errors.
 */
export function isRetryableError(error: unknown): boolean {
	return (
		error instanceof ExternalServiceError ||
		(error instanceof PipelineError && error.code === PIPELINE_ERROR_CODES.PIPELINE_RATE_LIMITED)
	);
}
