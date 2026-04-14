import { randomUUID } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';

export const REQUEST_ID_HEADER = 'X-Request-Id';

function resolveRequestId(headerValue: string | null | undefined): string {
	const trimmed = headerValue?.trim();
	return trimmed && trimmed.length > 0 ? trimmed : randomUUID();
}

declare module 'hono' {
	interface ContextVariableMap {
		requestId: string;
	}
}

export function createRequestIdMiddleware(): MiddlewareHandler {
	return async (c, next) => {
		const requestId = resolveRequestId(
			c.req.header(REQUEST_ID_HEADER) ?? c.req.header(REQUEST_ID_HEADER.toLowerCase()),
		);
		c.set('requestId', requestId);
		c.header(REQUEST_ID_HEADER, requestId);
		await next();
	};
}
