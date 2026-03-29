/**
 * Centralized structured logging module for the Mulder platform.
 *
 * Provides a Pino-based logger factory with project-level defaults,
 * child logger creation with bound context, a custom error serializer
 * for MulderError, and a duration helper for timing pipeline steps.
 *
 * @see docs/specs/05_logger_setup.spec.md
 * @see docs/functional-spec.md §8
 */

import { performance } from 'node:perf_hooks';
import type { default as tty } from 'node:tty';
import pino, { type Logger as PinoLogger } from 'pino';
import { MulderError } from './errors.js';

// ────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────

/** Options accepted by {@link createLogger}. */
export interface LoggerOptions {
	/** Log level override. Defaults to `MULDER_LOG_LEVEL` env var or `"info"`. */
	level?: string;
	/** Additional redact paths beyond the built-in defaults. */
	redactPaths?: string[];
	/** Force pretty-printing regardless of environment detection. */
	pretty?: boolean;
}

/** Typed context fields for child loggers created by {@link createChildLogger}. */
export interface ChildLoggerContext {
	/** Pipeline step name (e.g., `"ingest"`, `"extract"`, `"enrich"`). */
	step?: string;
	/** Current document/source ID. */
	source_id?: string;
	/** Current story ID. */
	story_id?: string;
	/** Arbitrary additional context fields. */
	[key: string]: unknown;
}

/** Re-exported Pino logger type for consumer convenience. */
export type Logger = PinoLogger;

// ────────────────────────────────────────────────────────────
// Redact configuration
// ────────────────────────────────────────────────────────────

const DEFAULT_REDACT_PATHS = ['config.gcp.credentials', '*.api_key', '*.token', '*.secret'];

// ────────────────────────────────────────────────────────────
// Error serializer
// ────────────────────────────────────────────────────────────

interface SerializedError {
	type: string;
	message: string;
	stack?: string;
	code?: string;
	context?: Record<string, unknown>;
	cause?: SerializedError;
}

/**
 * Custom Pino serializer for the `err` key.
 *
 * - If `MulderError`: includes `type`, `message`, `code`, `context`, `stack`
 * - If standard `Error`: includes `type`, `message`, `stack`
 * - Preserves `cause` chain recursively
 */
function errorSerializer(err: unknown): SerializedError {
	if (!(err instanceof Error)) {
		return { type: 'Unknown', message: String(err) };
	}

	const serialized: SerializedError = {
		type: err.name,
		message: err.message,
		stack: err.stack,
	};

	if (err instanceof MulderError) {
		serialized.code = err.code;
		if (err.context) {
			serialized.context = err.context;
		}
	}

	if (err.cause instanceof Error) {
		serialized.cause = errorSerializer(err.cause);
	}

	return serialized;
}

// ────────────────────────────────────────────────────────────
// Transport detection
// ────────────────────────────────────────────────────────────

/**
 * Determines whether pretty-printing should be enabled.
 *
 * Enabled when:
 * - `MULDER_LOG_PRETTY` env var is `"true"`, OR
 * - stderr is a TTY and `NODE_ENV` is not `"production"`
 */
function shouldPrettyPrint(forceOverride?: boolean): boolean {
	if (forceOverride !== undefined) {
		return forceOverride;
	}
	if (process.env.MULDER_LOG_PRETTY === 'true') {
		return true;
	}
	const stderrIsTTY = (process.stderr as tty.WriteStream).isTTY ?? false;
	const isDev = process.env.NODE_ENV !== 'production';
	return stderrIsTTY && isDev;
}

// ────────────────────────────────────────────────────────────
// Logger factory
// ────────────────────────────────────────────────────────────

/**
 * Creates a root Pino logger instance with Mulder project defaults.
 *
 * - Level from `MULDER_LOG_LEVEL` env var (default `"info"`)
 * - ISO 8601 timestamps
 * - Level labels as strings (not numbers)
 * - Custom error serializer for `MulderError`
 * - Sensitive field redaction
 * - Pretty-print to stderr when appropriate
 */
export function createLogger(options?: LoggerOptions): Logger {
	const level = options?.level ?? process.env.MULDER_LOG_LEVEL ?? 'info';
	const redactPaths = [...DEFAULT_REDACT_PATHS, ...(options?.redactPaths ?? [])];

	const pinoOptions: pino.LoggerOptions = {
		level,
		timestamp: pino.stdTimeFunctions.isoTime,
		formatters: {
			level(label: string) {
				return { level: label };
			},
		},
		serializers: {
			err: errorSerializer,
		},
		redact: {
			paths: redactPaths,
			censor: '[Redacted]',
		},
	};

	if (shouldPrettyPrint(options?.pretty)) {
		return pino(
			pinoOptions,
			pino.transport({
				target: 'pino-pretty',
				options: {
					destination: 2, // stderr
					colorize: true,
				},
			}),
		);
	}

	return pino(pinoOptions);
}

// ────────────────────────────────────────────────────────────
// Child logger
// ────────────────────────────────────────────────────────────

/**
 * Creates a child logger with bound context fields.
 *
 * Typical usage in pipeline steps:
 * ```ts
 * const log = createChildLogger(rootLogger, {
 *   step: 'enrich',
 *   source_id: 'abc-123',
 * });
 * log.info('Entity extraction started');
 * ```
 */
export function createChildLogger(parent: Logger, context: ChildLoggerContext): Logger {
	return parent.child(context);
}

// ────────────────────────────────────────────────────────────
// Duration helper
// ────────────────────────────────────────────────────────────

/**
 * Wraps an async function with duration logging.
 *
 * 1. Records start time via `performance.now()`
 * 2. Awaits `fn()`
 * 3. Logs at `info` level with `duration_ms` (rounded to integer)
 * 4. Returns the function's result
 * 5. On error: logs at `error` level with `duration_ms` and re-throws
 */
export async function withDuration<T>(logger: Logger, message: string, fn: () => Promise<T>): Promise<T> {
	const start = performance.now();
	try {
		const result = await fn();
		const durationMs = Math.round(performance.now() - start);
		logger.info({ duration_ms: durationMs }, message);
		return result;
	} catch (error: unknown) {
		const durationMs = Math.round(performance.now() - start);
		logger.error({ err: error, duration_ms: durationMs }, message);
		throw error;
	}
}
