import { performance } from 'node:perf_hooks';
import { createChildLogger, type Logger } from '@mulder/core';
import type { MiddlewareHandler } from 'hono';
import { REQUEST_ID_HEADER } from './request-id.js';

export interface RequestContext {
	requestId: string;
	logger: Logger;
}

declare module 'hono' {
	interface ContextVariableMap {
		requestContext: RequestContext;
	}
}

export function createRequestContextMiddleware(rootLogger: Logger): MiddlewareHandler {
	return async (c, next) => {
		const requestId =
			c.get('requestId') ??
			c.req.header(REQUEST_ID_HEADER) ??
			c.req.header(REQUEST_ID_HEADER.toLowerCase()) ??
			'unknown';
		const logger = createChildLogger(rootLogger, {
			module: 'api',
			request_id: requestId,
			method: c.req.method,
			path: c.req.path,
		});

		c.set('requestContext', { requestId, logger });

		const startedAt = performance.now();
		try {
			await next();
		} finally {
			logger.info(
				{
					status: c.res.status,
					duration_ms: Math.round(performance.now() - startedAt),
				},
				'request completed',
			);
		}
	};
}
