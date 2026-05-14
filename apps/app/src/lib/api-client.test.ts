import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ApiError, apiFetch } from './api-client';

describe('apiFetch', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('carries retry and request metadata from API errors', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(
				JSON.stringify({
					error: {
						code: 'RATE_LIMITED',
						message: 'Too many requests',
					},
				}),
				{
					headers: {
						'Retry-After': '7',
						'X-Request-Id': 'req-test-1',
					},
					status: 429,
					statusText: 'Too Many Requests',
				},
			),
		);

		await expect(apiFetch('/api/test')).rejects.toMatchObject({
			code: 'RATE_LIMITED',
			message: 'Too many requests',
			requestId: 'req-test-1',
			retryAfterMs: 7_000,
			status: 429,
			statusText: 'Too Many Requests',
		} satisfies Partial<ApiError>);
	});
});
