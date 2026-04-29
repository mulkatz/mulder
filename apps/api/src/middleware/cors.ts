import type { MiddlewareHandler } from 'hono';

const DEFAULT_ALLOWED_METHODS = 'GET,POST,PUT,OPTIONS';
const DEFAULT_ALLOWED_HEADERS = 'Content-Type,Authorization,X-Request-Id';
const DEFAULT_MAX_AGE_SECONDS = '600';

function parseAllowedOrigins(): Set<string> {
	const raw = process.env.MULDER_CORS_ORIGINS ?? '';
	return new Set(
		raw
			.split(',')
			.map((origin) => origin.trim())
			.filter((origin) => origin.length > 0),
	);
}

function setCorsHeaders(c: Parameters<MiddlewareHandler>[0], origin: string): void {
	c.header('Access-Control-Allow-Origin', origin);
	c.header('Access-Control-Allow-Credentials', 'true');
	c.header('Access-Control-Allow-Methods', process.env.MULDER_CORS_METHODS ?? DEFAULT_ALLOWED_METHODS);
	c.header('Access-Control-Allow-Headers', process.env.MULDER_CORS_HEADERS ?? DEFAULT_ALLOWED_HEADERS);
	c.header('Access-Control-Max-Age', process.env.MULDER_CORS_MAX_AGE_SECONDS ?? DEFAULT_MAX_AGE_SECONDS);
	c.header('Vary', 'Origin');
}

export function createCorsMiddleware(): MiddlewareHandler {
	return async (c, next) => {
		const origin = c.req.header('origin')?.trim();
		const allowedOrigins = parseAllowedOrigins();
		const isAllowedOrigin = origin ? allowedOrigins.has(origin) : false;

		if (origin && isAllowedOrigin) {
			setCorsHeaders(c, origin);
		}

		if (c.req.method.toUpperCase() === 'OPTIONS') {
			return c.body(null, isAllowedOrigin ? 204 : 403);
		}

		await next();
	};
}
