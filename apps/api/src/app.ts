import { type ApiConfig, CONFIG_DEFAULTS, createLogger, type Logger } from '@mulder/core';
import { Hono } from 'hono';
import { createAuthMiddleware } from './middleware/auth.js';
import { createBodyLimitMiddleware } from './middleware/body-limit.js';
import { createErrorHandler } from './middleware/error-handler.js';
import { createRateLimitMiddleware } from './middleware/rate-limit.js';
import { createRequestContextMiddleware } from './middleware/request-context.js';
import { createRequestIdMiddleware } from './middleware/request-id.js';
import { createSecureHeadersMiddleware } from './middleware/secure-headers.js';
import { registerDocumentRoutes } from './routes/documents.js';
import { registerEntityRoutes } from './routes/entities.js';
import { registerEvidenceRoutes } from './routes/evidence.js';
import { registerHealthRoute } from './routes/health.js';
import { registerJobRoutes } from './routes/jobs.js';
import { registerPipelineRoutes } from './routes/pipeline.js';
import { registerSearchRoute } from './routes/search.js';
import { registerUploadRoutes } from './routes/uploads.js';

export interface AppOptions {
	logger?: Logger;
	config?: ApiConfig;
}

export function createApp(options: AppOptions = {}): Hono {
	const rootLogger = options.logger ?? createLogger();
	const apiConfig = options.config ?? CONFIG_DEFAULTS.api;

	const app = new Hono();

	app.onError(createErrorHandler(rootLogger));
	app.use('*', createRequestIdMiddleware());
	app.use('*', createRequestContextMiddleware(rootLogger));
	app.use('*', createSecureHeadersMiddleware());
	app.use('*', createBodyLimitMiddleware());
	app.use('*', createAuthMiddleware(apiConfig));
	app.use('*', createRateLimitMiddleware(apiConfig));

	registerHealthRoute(app);
	registerEntityRoutes(app);
	registerEvidenceRoutes(app);
	registerDocumentRoutes(app);
	registerJobRoutes(app);
	registerPipelineRoutes(app);
	registerUploadRoutes(app);
	registerSearchRoute(app);

	return app;
}
