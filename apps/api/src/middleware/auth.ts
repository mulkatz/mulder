import type { ApiConfig } from '@mulder/core';
import { MulderError } from '@mulder/core';
import type { MiddlewareHandler } from 'hono';

const PUBLIC_PATHS = new Set(['/api/health', '/doc', '/reference']);
const RATE_LIMIT_CLIENT_KEY = 'rateLimitClientKey';

declare module 'hono' {
	interface ContextVariableMap {
		rateLimitClientKey: string;
	}
}

function isPublicRequest(method: string, path: string): boolean {
	return method.toUpperCase() === 'OPTIONS' || PUBLIC_PATHS.has(path);
}

function parseBearerToken(headerValue: string | null): string | undefined {
	if (headerValue === null) {
		return undefined;
	}

	const match = /^Bearer\s+(.+)$/i.exec(headerValue.trim());
	return match?.[1]?.trim();
}

export function createAuthMiddleware(apiConfig: ApiConfig): MiddlewareHandler {
	const apiKeys = new Set(apiConfig.auth.api_keys.map((entry) => entry.key));

	return async (c, next) => {
		if (isPublicRequest(c.req.method, c.req.path)) {
			await next();
			return;
		}

		const bearerToken = parseBearerToken(c.req.header('authorization') ?? null);
		if (!bearerToken || !apiKeys.has(bearerToken)) {
			throw new MulderError('A valid API key is required', 'AUTH_UNAUTHORIZED');
		}

		c.set(RATE_LIMIT_CLIENT_KEY, bearerToken);
		await next();
	};
}
