import { createRoute, type OpenAPIHono, type RouteConfig, z } from '@hono/zod-openapi';
import type { Handler } from 'hono';
import type { ZodType } from 'zod';

export type ApiApp = OpenAPIHono;

export const ErrorResponseSchema = z.object({
	error: z.object({
		code: z.string(),
		message: z.string(),
		details: z.unknown().optional(),
	}),
});

export const EmptyResponseSchema = z.object({});

export const AUTH_SECURITY: Array<Record<string, string[]>> = [{ BearerAuth: [] }, { SessionCookie: [] }];

export function jsonContent(schema: ZodType) {
	return {
		'application/json': {
			schema,
		},
	};
}

export function jsonRequestBody(schema: ZodType, description = 'JSON request body') {
	return {
		content: jsonContent(schema),
		description,
		required: true,
	};
}

export function jsonResponse(schema: ZodType, description: string) {
	return {
		content: jsonContent(schema),
		description,
	};
}

export function textResponse(contentType: string, description: string) {
	return {
		content: {
			[contentType]: {
				schema: z.string(),
			},
		},
		description,
	};
}

export function binaryResponse(contentType: string, description: string) {
	return {
		content: {
			[contentType]: {
				schema: z.string().openapi({ format: 'binary' }),
			},
		},
		description,
	};
}

export function emptyResponse(description: string) {
	return {
		description,
	};
}

export const COMMON_ERROR_RESPONSES = {
	400: jsonResponse(ErrorResponseSchema, 'Invalid request'),
	401: jsonResponse(ErrorResponseSchema, 'Authentication required'),
	403: jsonResponse(ErrorResponseSchema, 'Forbidden'),
	404: jsonResponse(ErrorResponseSchema, 'Resource not found'),
	409: jsonResponse(ErrorResponseSchema, 'Conflict'),
	413: jsonResponse(ErrorResponseSchema, 'Request too large'),
	429: jsonResponse(ErrorResponseSchema, 'Rate limit exceeded'),
	500: jsonResponse(ErrorResponseSchema, 'Internal server error'),
	503: jsonResponse(ErrorResponseSchema, 'Service unavailable'),
} as const;

export function registerOpenApiRoute(app: ApiApp, routeConfig: RouteConfig, handler: Handler): void {
	app.openapi(createRoute(routeConfig), handler as never);
}
