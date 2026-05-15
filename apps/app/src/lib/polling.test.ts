import { describe, expect, it } from 'vitest';
import { ApiError } from './api-client';
import {
	ACTIVE_POLL_INTERVAL_MS,
	getNextPollDelayMs,
	getRetryAfterDelayMs,
	RATE_LIMIT_POLL_INTERVAL_MS,
	STABLE_POLL_INTERVAL_MS,
} from './polling';

describe('polling backoff helpers', () => {
	it('slows active polling after unchanged responses', () => {
		expect(getNextPollDelayMs({ unchangedCount: 0 })).toBe(ACTIVE_POLL_INTERVAL_MS);
		expect(getNextPollDelayMs({ unchangedCount: 3 })).toBe(STABLE_POLL_INTERVAL_MS);
	});

	it('uses rate-limit retry metadata with a safe fallback floor', () => {
		const error = new ApiError(429, 'RATE_LIMITED', 'Too many requests', undefined, {
			retryAfterMs: 20_000,
		});

		expect(getRetryAfterDelayMs(error)).toBe(20_000);
		expect(getNextPollDelayMs({ error })).toBe(20_000);
		expect(getRetryAfterDelayMs(new ApiError(429, 'RATE_LIMITED', 'Too many requests'))).toBe(
			RATE_LIMIT_POLL_INTERVAL_MS,
		);
	});
});
