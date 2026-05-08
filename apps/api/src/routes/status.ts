import { getApiStatus } from '../lib/status.js';
import { type ApiApp, AUTH_SECURITY, COMMON_ERROR_RESPONSES, jsonResponse, registerOpenApiRoute } from './openapi.js';
import { StatusResponseSchema } from './status.schemas.js';

export function registerStatusRoute(app: ApiApp): void {
	registerOpenApiRoute(
		app,
		{
			method: 'get',
			path: '/api/status',
			operationId: 'getStatus',
			tags: ['Status'],
			security: AUTH_SECURITY,
			responses: {
				200: jsonResponse(StatusResponseSchema, 'API and queue status'),
				...COMMON_ERROR_RESPONSES,
			},
		},
		async (c) => {
			const response = await getApiStatus();
			StatusResponseSchema.parse(response);
			return c.json(response, 200);
		},
	);
}
