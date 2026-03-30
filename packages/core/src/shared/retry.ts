/**
 * Generic retry utility with exponential backoff and full jitter.
 *
 * Used by all external service calls. Pipeline steps never implement
 * their own retry logic — they call service interfaces which use
 * this utility internally.
 *
 * @see docs/specs/11_service_abstraction.spec.md §4.4
 * @see docs/functional-spec.md §7.3
 */

import { isRetryableError } from './errors.js';

// ────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────

/** Configuration for the retry utility. */
export interface RetryOptions {
	/** Maximum number of attempts (including the first call). Default: 3. */
	maxAttempts: number;
	/** Base delay in milliseconds for backoff calculation. Default: 1000. */
	backoffBaseMs: number;
	/** Maximum delay in milliseconds (cap). Default: 30000. */
	backoffMaxMs: number;
	/** Multiplier for exponential backoff. Default: 2. */
	multiplier: number;
	/** Predicate to determine if an error warrants retry. Default: `isRetryableError`. */
	isRetryable: (error: unknown) => boolean;
	/** Callback invoked before each retry (for logging). */
	onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

/** Default retry options. */
const DEFAULT_RETRY_OPTIONS: RetryOptions = {
	maxAttempts: 3,
	backoffBaseMs: 1000,
	backoffMaxMs: 30000,
	multiplier: 2,
	isRetryable: isRetryableError,
};

// ────────────────────────────────────────────────────────────
// Delay calculation
// ────────────────────────────────────────────────────────────

/**
 * Calculates the delay for a given attempt using exponential backoff
 * with full jitter: `random(0, min(backoffBaseMs * multiplier^attempt, backoffMaxMs))`.
 *
 * Full jitter prevents thundering herd when multiple clients retry simultaneously.
 */
function calculateDelay(attempt: number, options: RetryOptions): number {
	const exponentialDelay = options.backoffBaseMs * options.multiplier ** attempt;
	const cappedDelay = Math.min(exponentialDelay, options.backoffMaxMs);
	return Math.random() * cappedDelay;
}

/**
 * Delays execution for a given number of milliseconds.
 */
function delay(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

// ────────────────────────────────────────────────────────────
// Retry function
// ────────────────────────────────────────────────────────────

/**
 * Retries an async function with exponential backoff and full jitter.
 *
 * - Only retries when `isRetryable(error)` returns true
 * - Calls `onRetry` callback before each retry (for logging)
 * - After exhausting all attempts, throws the last error (preserving original type)
 * - Non-retryable errors are thrown immediately without consuming additional attempts
 *
 * @example
 * ```ts
 * const result = await withRetry(
 *   () => callExternalService(),
 *   {
 *     maxAttempts: 3,
 *     onRetry: (err, attempt, delayMs) => {
 *       logger.warn({ err, attempt, delayMs }, 'Retrying external call');
 *     },
 *   }
 * );
 * ```
 */
export async function withRetry<T>(fn: () => Promise<T>, options?: Partial<RetryOptions>): Promise<T> {
	const resolved: RetryOptions = { ...DEFAULT_RETRY_OPTIONS, ...options };

	let lastError: unknown;

	for (let attempt = 0; attempt < resolved.maxAttempts; attempt++) {
		try {
			return await fn();
		} catch (error: unknown) {
			lastError = error;

			// Non-retryable errors are thrown immediately
			if (!resolved.isRetryable(error)) {
				throw error;
			}

			// Last attempt exhausted — throw
			if (attempt === resolved.maxAttempts - 1) {
				throw error;
			}

			// Calculate delay and notify
			const delayMs = calculateDelay(attempt, resolved);
			resolved.onRetry?.(error, attempt + 1, delayMs);

			await delay(delayMs);
		}
	}

	// Should never reach here, but satisfies TypeScript
	throw lastError;
}
