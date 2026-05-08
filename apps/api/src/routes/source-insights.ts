import type { Context } from 'hono';
import { getDocumentCredibility, getDocumentQuality, listSourceCredibility } from '../lib/source-insights.js';
import { type ApiApp, AUTH_SECURITY, COMMON_ERROR_RESPONSES, jsonResponse, registerOpenApiRoute } from './openapi.js';
import {
	DocumentCredibilityResponseSchema,
	DocumentQualityResponseSchema,
	SourceCredibilityListQuerySchema,
	SourceCredibilityListResponseSchema,
	SourceInsightDocumentParamsSchema,
} from './source-insights.schemas.js';

function readRouteOptions(c: Context) {
	return { authPrincipal: c.get('authPrincipal') };
}

function readQuery(url: string): Record<string, string | undefined> {
	const searchParams = new URL(url).searchParams;
	return {
		source_type: searchParams.get('source_type') ?? undefined,
		review_status: searchParams.get('review_status') ?? undefined,
		limit: searchParams.get('limit') ?? undefined,
		offset: searchParams.get('offset') ?? undefined,
	};
}

export function registerSourceInsightRoutes(app: ApiApp): void {
	registerOpenApiRoute(
		app,
		{
			method: 'get',
			path: '/api/documents/{id}/quality',
			operationId: 'getDocumentQuality',
			tags: ['Source Quality'],
			security: AUTH_SECURITY,
			request: {
				params: SourceInsightDocumentParamsSchema,
			},
			responses: {
				200: jsonResponse(DocumentQualityResponseSchema, 'Document quality'),
				...COMMON_ERROR_RESPONSES,
			},
		},
		async (c) => {
			const { id } = SourceInsightDocumentParamsSchema.parse({ id: c.req.param('id') });
			const response = await getDocumentQuality(id, readRouteOptions(c));
			DocumentQualityResponseSchema.parse(response);
			return c.json(response, 200);
		},
	);

	registerOpenApiRoute(
		app,
		{
			method: 'get',
			path: '/api/documents/{id}/credibility',
			operationId: 'getDocumentCredibility',
			tags: ['Source Credibility'],
			security: AUTH_SECURITY,
			request: {
				params: SourceInsightDocumentParamsSchema,
			},
			responses: {
				200: jsonResponse(DocumentCredibilityResponseSchema, 'Document credibility'),
				...COMMON_ERROR_RESPONSES,
			},
		},
		async (c) => {
			const { id } = SourceInsightDocumentParamsSchema.parse({ id: c.req.param('id') });
			const response = await getDocumentCredibility(id, readRouteOptions(c));
			DocumentCredibilityResponseSchema.parse(response);
			return c.json(response, 200);
		},
	);

	registerOpenApiRoute(
		app,
		{
			method: 'get',
			path: '/api/source-credibility',
			operationId: 'listSourceCredibility',
			tags: ['Source Credibility'],
			security: AUTH_SECURITY,
			request: {
				query: SourceCredibilityListQuerySchema,
			},
			responses: {
				200: jsonResponse(SourceCredibilityListResponseSchema, 'Source credibility profiles'),
				...COMMON_ERROR_RESPONSES,
			},
		},
		async (c) => {
			const query = SourceCredibilityListQuerySchema.parse(readQuery(c.req.url));
			const response = await listSourceCredibility(query, readRouteOptions(c));
			SourceCredibilityListResponseSchema.parse(response);
			return c.json(response, 200);
		},
	);
}
