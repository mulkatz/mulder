import type { MiddlewareHandler } from 'hono';

export const SECURE_HEADERS = {
	'Cross-Origin-Resource-Policy': 'same-origin',
	'Referrer-Policy': 'no-referrer',
	'X-Content-Type-Options': 'nosniff',
	'X-DNS-Prefetch-Control': 'off',
	'X-Frame-Options': 'DENY',
} as const;

export function createSecureHeadersMiddleware(): MiddlewareHandler {
	return async (c, next) => {
		for (const [name, value] of Object.entries(SECURE_HEADERS)) {
			c.header(name, value);
		}

		await next();
	};
}
