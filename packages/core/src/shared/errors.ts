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
	CONFIG_NOT_FOUND: 'CONFIG_NOT_FOUND',
	CONFIG_INVALID: 'CONFIG_INVALID',
} as const;

export type ConfigErrorCode = (typeof CONFIG_ERROR_CODES)[keyof typeof CONFIG_ERROR_CODES];

/** Pipeline domain error codes. */
export const PIPELINE_ERROR_CODES = {
	PIPELINE_SOURCE_NOT_FOUND: 'PIPELINE_SOURCE_NOT_FOUND',
	PIPELINE_WRONG_STATUS: 'PIPELINE_WRONG_STATUS',
	PIPELINE_STEP_FAILED: 'PIPELINE_STEP_FAILED',
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
	TAXONOMY_BOOTSTRAP_TOO_FEW: 'TAXONOMY_BOOTSTRAP_TOO_FEW',
} as const;

export type TaxonomyErrorCode = (typeof TAXONOMY_ERROR_CODES)[keyof typeof TAXONOMY_ERROR_CODES];

/** Ingest step error codes. */
export const INGEST_ERROR_CODES = {
	INGEST_FILE_NOT_FOUND: 'INGEST_FILE_NOT_FOUND',
	INGEST_NOT_PDF: 'INGEST_NOT_PDF',
	INGEST_FILE_TOO_LARGE: 'INGEST_FILE_TOO_LARGE',
	INGEST_TOO_MANY_PAGES: 'INGEST_TOO_MANY_PAGES',
	INGEST_UPLOAD_FAILED: 'INGEST_UPLOAD_FAILED',
	INGEST_DUPLICATE: 'INGEST_DUPLICATE',
} as const;

export type IngestErrorCode = (typeof INGEST_ERROR_CODES)[keyof typeof INGEST_ERROR_CODES];

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
