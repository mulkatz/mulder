import type { ApiConfig } from '@mulder/core';
import { MulderError } from '@mulder/core';
import type { Context, MiddlewareHandler } from 'hono';

type RateLimitTier = 'strict' | 'standard' | 'relaxed';

interface RateLimitBucket {
	tokens: number;
	updatedAt: number;
}

interface RateLimitTierConfig {
	limitPerMinute: number;
}

const RATE_LIMIT_TIERS: Record<RateLimitTier, RateLimitTierConfig> = {
	strict: {
		limitPerMinute: 10,
	},
	standard: {
		limitPerMinute: 60,
	},
	relaxed: {
		limitPerMinute: 120,
	},
};

const NON_RATE_LIMITED_PATHS = new Set(['/doc', '/reference']);
const ANONYMOUS_CLIENT_KEY = 'anonymous';

function isPublicDocsPath(path: string): boolean {
	return NON_RATE_LIMITED_PATHS.has(path);
}

function isHealthPath(path: string): boolean {
	return path === '/api/health';
}

function resolveRateLimitTier(method: string, path: string, query: URLSearchParams): RateLimitTier | undefined {
	const normalizedMethod = method.toUpperCase();

	if (normalizedMethod === 'OPTIONS' || isPublicDocsPath(path)) {
		return undefined;
	}

	if (isHealthPath(path)) {
		return 'relaxed';
	}

	if (normalizedMethod === 'GET' && (path === '/api/jobs' || path.startsWith('/api/jobs/'))) {
		return 'relaxed';
	}

	if (normalizedMethod === 'POST' && path === '/api/search') {
		const noRerank = query.get('no_rerank') === 'true' || query.get('rerank') === 'false';
		return noRerank ? 'standard' : 'strict';
	}

	if (
		normalizedMethod === 'GET' &&
		(path.startsWith('/api/entities') || path.startsWith('/api/stories') || path.startsWith('/api/evidence'))
	) {
		return 'standard';
	}

	return undefined;
}

function computeRetryAfterSeconds(bucket: RateLimitBucket, limitPerMinute: number, now: number): number {
	const refillPerMs = limitPerMinute / 60_000;
	const tokensAfterRefill = Math.min(limitPerMinute, bucket.tokens + (now - bucket.updatedAt) * refillPerMs);
	const missingTokens = Math.max(0, 1 - tokensAfterRefill);
	return Math.max(1, Math.ceil(missingTokens / refillPerMs / 1000));
}

function getClientKey(c: Context): string {
	return c.get('rateLimitClientKey') ?? ANONYMOUS_CLIENT_KEY;
}

export function createRateLimitMiddleware(apiConfig: ApiConfig): MiddlewareHandler {
	const buckets = new Map<string, RateLimitBucket>();
	const enabled = apiConfig.rate_limiting.enabled;

	return async (c, next) => {
		if (!enabled) {
			await next();
			return;
		}

		const tier = resolveRateLimitTier(c.req.method, c.req.path, new URL(c.req.url).searchParams);
		if (!tier) {
			await next();
			return;
		}

		const now = Date.now();
		const { limitPerMinute } = RATE_LIMIT_TIERS[tier];
		const clientKey = `${tier}:${getClientKey(c)}`;
		const bucket = buckets.get(clientKey) ?? {
			tokens: limitPerMinute,
			updatedAt: now,
		};

		const refillPerMs = limitPerMinute / 60_000;
		const replenishedTokens = Math.min(limitPerMinute, bucket.tokens + (now - bucket.updatedAt) * refillPerMs);

		if (replenishedTokens < 1) {
			const retryAfterSeconds = computeRetryAfterSeconds(bucket, limitPerMinute, now);
			const requestContext = c.get('requestContext');
			requestContext.logger.warn(
				{
					tier,
					client: clientKey,
					retry_after_seconds: retryAfterSeconds,
				},
				'API request rate limited',
			);

			throw new MulderError('Too many requests', 'RATE_LIMIT_EXCEEDED', {
				context: {
					retry_after_seconds: retryAfterSeconds,
					tier,
				},
			});
		}

		buckets.set(clientKey, {
			tokens: replenishedTokens - 1,
			updatedAt: now,
		});

		await next();
	};
}
