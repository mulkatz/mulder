import { ApiError } from './api-client';

export const INITIAL_POLL_INTERVAL_MS = 2_000;
export const ACTIVE_POLL_INTERVAL_MS = 5_000;
export const STABLE_POLL_INTERVAL_MS = 10_000;
export const CONTENT_POLL_INTERVAL_MS = 15_000;
export const RATE_LIMIT_POLL_INTERVAL_MS = 15_000;

export function jitterDelay(ms: number): number {
	if (typeof window === 'undefined') return ms;
	const jitter = Math.round(ms * 0.15 * Math.random());
	return ms + jitter;
}

export function getRetryAfterDelayMs(error: unknown, fallbackMs = RATE_LIMIT_POLL_INTERVAL_MS): number {
	if (error instanceof ApiError && error.status === 429) {
		return jitterDelay(Math.max(error.retryAfterMs ?? fallbackMs, fallbackMs));
	}
	return jitterDelay(fallbackMs);
}

export function getNextPollDelayMs(options: { error?: unknown; unchangedCount?: number }): number {
	if (options.error instanceof ApiError && options.error.status === 429) {
		return getRetryAfterDelayMs(options.error);
	}
	return jitterDelay((options.unchangedCount ?? 0) >= 3 ? STABLE_POLL_INTERVAL_MS : ACTIVE_POLL_INTERVAL_MS);
}

export function isRateLimited(error: unknown): boolean {
	return error instanceof ApiError && error.status === 429;
}
