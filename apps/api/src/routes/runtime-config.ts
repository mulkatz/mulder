import { getRuntimeConfig } from '../lib/runtime-config.js';
import { type ApiApp, AUTH_SECURITY, COMMON_ERROR_RESPONSES, jsonResponse, registerOpenApiRoute } from './openapi.js';
import { RuntimeConfigResponseSchema } from './runtime-config.schemas.js';

export function registerRuntimeConfigRoute(app: ApiApp): void {
	registerOpenApiRoute(
		app,
		{
			method: 'get',
			path: '/api/runtime-config',
			operationId: 'getRuntimeConfig',
			tags: ['Status'],
			security: AUTH_SECURITY,
			responses: {
				200: jsonResponse(RuntimeConfigResponseSchema, 'Runtime UI configuration'),
				...COMMON_ERROR_RESPONSES,
			},
		},
		(c) => {
			const response = getRuntimeConfig();
			RuntimeConfigResponseSchema.parse(response);
			return c.json(response, 200);
		},
	);
}
