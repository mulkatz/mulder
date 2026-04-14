import { performance } from 'node:perf_hooks';
import { createChildLogger, createLogger, type Logger } from '@mulder/core';
import { Hono } from 'hono';
import { registerHealthRoute } from './routes/health.js';

export interface AppOptions {
	logger?: Logger;
}

export function createApp(options: AppOptions = {}): Hono {
	const rootLogger = options.logger ?? createLogger();
	const requestLogger = createChildLogger(rootLogger, { module: 'api' });
	const app = new Hono();

	app.use('*', async (c, next) => {
		const startedAt = performance.now();
		try {
			await next();
		} finally {
			requestLogger.info(
				{
					method: c.req.method,
					path: c.req.path,
					status: c.res.status,
					duration_ms: Math.round(performance.now() - startedAt),
				},
				'request completed',
			);
		}
	});

	registerHealthRoute(app);

	return app;
}
