/**
 * Token-bucket rate limiter for GCP service quota management.
 *
 * Per-service rate limiter to prevent quota exhaustion.
 * Pure TypeScript implementation — no external dependencies.
 *
 * @see docs/specs/11_service_abstraction.spec.md §4.5
 * @see docs/functional-spec.md §4.5
 */

// ────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────

/** Configuration for a rate limiter instance. */
export interface RateLimiterOptions {
	/** Maximum number of tokens the bucket can hold (capacity). */
	maxTokens: number;
	/** Number of tokens added per second. */
	refillRate: number;
	/** Name for logging (e.g., "document-ai", "gemini"). */
	name: string;
}

// ────────────────────────────────────────────────────────────
// Rate Limiter
// ────────────────────────────────────────────────────────────

/**
 * Token-bucket rate limiter.
 *
 * Starts full. Tokens are consumed on `acquire()` or `tryAcquire()`.
 * Refills continuously at `refillRate` tokens per second.
 *
 * @example
 * ```ts
 * const limiter = new RateLimiter({ maxTokens: 10, refillRate: 2, name: 'gemini' });
 *
 * // Blocking — waits if no tokens available
 * await limiter.acquire();
 *
 * // Non-blocking — returns false if no tokens
 * if (limiter.tryAcquire()) {
 *   // proceed
 * }
 * ```
 */
export class RateLimiter {
	private readonly maxTokens: number;
	private readonly refillRate: number;
	private readonly name: string;
	private tokens: number;
	private lastRefillTime: number;

	constructor(options: RateLimiterOptions) {
		this.maxTokens = options.maxTokens;
		this.refillRate = options.refillRate;
		this.name = options.name;
		this.tokens = options.maxTokens; // Start full
		this.lastRefillTime = Date.now();
	}

	/**
	 * Refills tokens based on elapsed time since last refill.
	 * Called internally before any token check.
	 */
	private refill(): void {
		const now = Date.now();
		const elapsedSeconds = (now - this.lastRefillTime) / 1000;
		const newTokens = elapsedSeconds * this.refillRate;

		if (newTokens > 0) {
			this.tokens = Math.min(this.maxTokens, this.tokens + newTokens);
			this.lastRefillTime = now;
		}
	}

	/**
	 * Waits until the requested number of tokens is available, then consumes them.
	 *
	 * If tokens are available immediately, returns without delay.
	 * Otherwise, waits using setTimeout + Promise until enough tokens have refilled.
	 *
	 * @param tokens Number of tokens to acquire. Default: 1.
	 */
	async acquire(tokens = 1): Promise<void> {
		this.refill();

		if (this.tokens >= tokens) {
			this.tokens -= tokens;
			return;
		}

		// Calculate wait time for enough tokens to refill
		const deficit = tokens - this.tokens;
		const waitMs = (deficit / this.refillRate) * 1000;

		await new Promise<void>((resolve) => {
			setTimeout(resolve, waitMs);
		});

		// Refill again after waiting and consume
		this.refill();
		this.tokens -= tokens;
	}

	/**
	 * Attempts to acquire tokens without waiting.
	 *
	 * @param tokens Number of tokens to acquire. Default: 1.
	 * @returns `true` if tokens were available and consumed, `false` otherwise.
	 */
	tryAcquire(tokens = 1): boolean {
		this.refill();

		if (this.tokens >= tokens) {
			this.tokens -= tokens;
			return true;
		}

		return false;
	}

	/** Returns the number of currently available tokens (after refill). */
	get availableTokens(): number {
		this.refill();
		return this.tokens;
	}

	/** Returns the name of this rate limiter (for logging). */
	get limiterName(): string {
		return this.name;
	}
}
