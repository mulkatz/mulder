import type { ApiConfig } from '@mulder/core';
import { MulderError } from '@mulder/core';
import type { MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { type BrowserUserRole, validateSessionToken } from '../lib/auth.js';

const PUBLIC_PATHS = new Set([
	'/api/health',
	'/api/auth/login',
	'/api/auth/logout',
	'/api/auth/session',
	'/api/auth/invitations/accept',
]);
const RATE_LIMIT_CLIENT_KEY = 'rateLimitClientKey';

export type AuthPrincipal =
	| {
			type: 'api_key';
			keyName: string;
	  }
	| {
			type: 'session';
			userId: string;
			email: string;
			role: BrowserUserRole;
	  };

declare module 'hono' {
	interface ContextVariableMap {
		rateLimitClientKey: string;
		authPrincipal: AuthPrincipal;
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
	const apiKeys = new Map(apiConfig.auth.api_keys.map((entry) => [entry.key, entry.name]));

	return async (c, next) => {
		if (isPublicRequest(c.req.method, c.req.path)) {
			await next();
			return;
		}

		const bearerToken = parseBearerToken(c.req.header('authorization') ?? null);
		if (bearerToken && apiKeys.has(bearerToken)) {
			c.set(RATE_LIMIT_CLIENT_KEY, bearerToken);
			c.set('authPrincipal', {
				type: 'api_key',
				keyName: apiKeys.get(bearerToken) ?? 'api-key',
			});
			await next();
			return;
		}

		const browser = apiConfig.auth.browser;
		const sessionToken = browser.enabled ? getCookie(c, browser.cookie_name) : undefined;
		if (sessionToken) {
			const session = await validateSessionToken(sessionToken, apiConfig);
			if (session) {
				c.set(RATE_LIMIT_CLIENT_KEY, session.user.id);
				c.set('authPrincipal', {
					type: 'session',
					userId: session.user.id,
					email: session.user.email,
					role: session.user.role,
				});
				await next();
				return;
			}
		}

		throw new MulderError('A valid API key is required', 'AUTH_UNAUTHORIZED');
	};
}
