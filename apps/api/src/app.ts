import { OpenAPIHono } from '@hono/zod-openapi';
import { type ApiConfig, CONFIG_DEFAULTS, createLogger, type Logger } from '@mulder/core';
import { createAuthMiddleware } from './middleware/auth.js';
import { createBodyLimitMiddleware } from './middleware/body-limit.js';
import { createCorsMiddleware } from './middleware/cors.js';
import { createErrorHandler } from './middleware/error-handler.js';
import { createRateLimitMiddleware } from './middleware/rate-limit.js';
import { createRequestContextMiddleware } from './middleware/request-context.js';
import { createRequestIdMiddleware } from './middleware/request-id.js';
import { createSecureHeadersMiddleware } from './middleware/secure-headers.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerClaimRoutes } from './routes/claims.js';
import { registerCollectionRoutes } from './routes/collections.js';
import { registerDiscoveryRoutes } from './routes/discovery.js';
import { registerDocumentRoutes } from './routes/documents.js';
import { registerEntityRoutes } from './routes/entities.js';
import { registerEvidenceRoutes } from './routes/evidence.js';
import { registerHealthRoute } from './routes/health.js';
import { registerJobRoutes } from './routes/jobs.js';
import { registerPipelineRoutes } from './routes/pipeline.js';
import { registerReviewRoutes } from './routes/review.js';
import { registerRuntimeConfigRoute } from './routes/runtime-config.js';
import { registerSearchRoute } from './routes/search.js';
import { registerSourceInsightRoutes } from './routes/source-insights.js';
import { registerStatusRoute } from './routes/status.js';
import { registerTaxonomyRoutes } from './routes/taxonomy.js';
import { registerTranslationRoutes } from './routes/translations.js';
import { registerUploadRoutes } from './routes/uploads.js';

export interface AppOptions {
	logger?: Logger;
	config?: ApiConfig;
}

export function createApp(options: AppOptions = {}): OpenAPIHono {
	const rootLogger = options.logger ?? createLogger();
	const apiConfig = options.config ?? CONFIG_DEFAULTS.api;

	const app = new OpenAPIHono({
		defaultHook: (result, c) => {
			if (!result.success) {
				const requestId = c.get('requestId');
				if (requestId) {
					c.header('X-Request-Id', requestId);
				}
				return c.json(
					{
						error: {
							code: 'VALIDATION_ERROR',
							message: 'Invalid request',
							details: result.error.flatten(),
						},
					},
					400,
				);
			}
		},
	});

	app.openAPIRegistry.registerComponent('securitySchemes', 'BearerAuth', {
		type: 'http',
		scheme: 'bearer',
	});
	app.openAPIRegistry.registerComponent('securitySchemes', 'SessionCookie', {
		type: 'apiKey',
		in: 'cookie',
		name: apiConfig.auth.browser.cookie_name,
	});

	app.onError(createErrorHandler(rootLogger));
	app.use('*', createRequestIdMiddleware());
	app.use('*', createRequestContextMiddleware(rootLogger));
	app.use('*', createCorsMiddleware());
	app.use('*', createSecureHeadersMiddleware());
	app.use('*', createBodyLimitMiddleware());
	app.use('*', createAuthMiddleware(apiConfig));
	app.use('*', createRateLimitMiddleware(apiConfig));

	registerHealthRoute(app);
	registerAuthRoutes(app, apiConfig);
	registerEntityRoutes(app);
	registerEvidenceRoutes(app);
	registerDocumentRoutes(app);
	registerSourceInsightRoutes(app);
	registerClaimRoutes(app);
	registerJobRoutes(app);
	registerPipelineRoutes(app);
	registerUploadRoutes(app);
	registerSearchRoute(app);
	registerStatusRoute(app);
	registerRuntimeConfigRoute(app);
	registerTranslationRoutes(app);
	registerReviewRoutes(app);
	registerCollectionRoutes(app);
	registerTaxonomyRoutes(app);
	registerDiscoveryRoutes(app);

	app.doc('/api/openapi.json', {
		openapi: '3.0.0',
		info: {
			title: 'Mulder API',
			version: '0.0.0',
		},
	});

	return app;
}
