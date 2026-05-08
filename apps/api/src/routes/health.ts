import { z } from 'zod';
import { type ApiApp, jsonResponse, registerOpenApiRoute } from './openapi.js';

export const API_VERSION = '0.0.0';

export type HealthResponse = {
	status: 'ok';
	version: string;
};

export function getHealthResponse(): HealthResponse {
	return {
		status: 'ok',
		version: API_VERSION,
	};
}

const HealthResponseSchema = z.object({
	status: z.literal('ok'),
	version: z.string(),
});

export function registerHealthRoute(app: ApiApp): void {
	registerOpenApiRoute(
		app,
		{
			method: 'get',
			path: '/api/health',
			operationId: 'getHealth',
			tags: ['Health'],
			responses: {
				200: jsonResponse(HealthResponseSchema, 'Service health'),
			},
		},
		(c) => c.json(getHealthResponse(), 200),
	);
}
