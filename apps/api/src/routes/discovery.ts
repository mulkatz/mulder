import type { Context } from 'hono';
import {
	listClassificationMappingLeads,
	listExternalCorrelationLeads,
	listSimilarEntityLeads,
	listTemporalPatternLeads,
} from '../lib/discovery.js';
import {
	ClassificationMappingListResponseSchema,
	ClassificationMappingQuerySchema,
	ExternalCorrelationListResponseSchema,
	ExternalCorrelationQuerySchema,
	SimilarEntityListResponseSchema,
	SimilarEntityQuerySchema,
	TemporalPatternListResponseSchema,
	TemporalPatternQuerySchema,
} from './discovery.schemas.js';
import { type ApiApp, AUTH_SECURITY, COMMON_ERROR_RESPONSES, jsonResponse, registerOpenApiRoute } from './openapi.js';

function readRouteOptions(c: Context) {
	return { authPrincipal: c.get('authPrincipal') };
}

function readQuery(url: string): Record<string, string | undefined> {
	const searchParams = new URL(url).searchParams;
	return Object.fromEntries(searchParams.entries());
}

export function registerDiscoveryRoutes(app: ApiApp): void {
	registerOpenApiRoute(
		app,
		{
			method: 'get',
			path: '/api/discovery/similar-entities',
			operationId: 'listSimilarEntityLeads',
			tags: ['Discovery'],
			security: AUTH_SECURITY,
			request: {
				query: SimilarEntityQuerySchema,
			},
			responses: {
				200: jsonResponse(SimilarEntityListResponseSchema, 'Similar entity research leads'),
				...COMMON_ERROR_RESPONSES,
			},
		},
		async (c) => {
			const query = SimilarEntityQuerySchema.parse(readQuery(c.req.url));
			const response = await listSimilarEntityLeads(query, readRouteOptions(c));
			SimilarEntityListResponseSchema.parse(response);
			return c.json(response, 200);
		},
	);

	registerOpenApiRoute(
		app,
		{
			method: 'get',
			path: '/api/discovery/temporal-patterns',
			operationId: 'listTemporalPatternLeads',
			tags: ['Discovery'],
			security: AUTH_SECURITY,
			request: {
				query: TemporalPatternQuerySchema,
			},
			responses: {
				200: jsonResponse(TemporalPatternListResponseSchema, 'Temporal and spatial research leads'),
				...COMMON_ERROR_RESPONSES,
			},
		},
		async (c) => {
			const query = TemporalPatternQuerySchema.parse(readQuery(c.req.url));
			const response = await listTemporalPatternLeads(query, readRouteOptions(c));
			TemporalPatternListResponseSchema.parse(response);
			return c.json(response, 200);
		},
	);

	registerOpenApiRoute(
		app,
		{
			method: 'get',
			path: '/api/discovery/classification-mappings',
			operationId: 'listClassificationMappingLeads',
			tags: ['Discovery'],
			security: AUTH_SECURITY,
			request: {
				query: ClassificationMappingQuerySchema,
			},
			responses: {
				200: jsonResponse(ClassificationMappingListResponseSchema, 'Classification harmonization research leads'),
				...COMMON_ERROR_RESPONSES,
			},
		},
		async (c) => {
			const query = ClassificationMappingQuerySchema.parse(readQuery(c.req.url));
			const response = await listClassificationMappingLeads(query, readRouteOptions(c));
			ClassificationMappingListResponseSchema.parse(response);
			return c.json(response, 200);
		},
	);

	registerOpenApiRoute(
		app,
		{
			method: 'get',
			path: '/api/discovery/external-correlations',
			operationId: 'listExternalCorrelationLeads',
			tags: ['Discovery'],
			security: AUTH_SECURITY,
			request: {
				query: ExternalCorrelationQuerySchema,
			},
			responses: {
				200: jsonResponse(ExternalCorrelationListResponseSchema, 'External correlation research leads'),
				...COMMON_ERROR_RESPONSES,
			},
		},
		async (c) => {
			const query = ExternalCorrelationQuerySchema.parse(readQuery(c.req.url));
			const response = await listExternalCorrelationLeads(query, readRouteOptions(c));
			ExternalCorrelationListResponseSchema.parse(response);
			return c.json(response, 200);
		},
	);
}
