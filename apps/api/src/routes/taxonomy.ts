import type { Context } from 'hono';
import { exportTaxonomyYaml, listTaxonomyEntries } from '../lib/taxonomy.js';
import {
	type ApiApp,
	AUTH_SECURITY,
	COMMON_ERROR_RESPONSES,
	jsonResponse,
	registerOpenApiRoute,
	textResponse,
} from './openapi.js';
import { TaxonomyExportQuerySchema, TaxonomyListQuerySchema, TaxonomyListResponseSchema } from './taxonomy.schemas.js';

function readRouteOptions(c: Context) {
	return {
		authPrincipal: c.get('authPrincipal'),
		logger: c.get('requestContext')?.logger,
	};
}

function readListQuery(url: string): Record<string, string | undefined> {
	const searchParams = new URL(url).searchParams;
	return {
		entity_type: searchParams.get('entity_type') ?? undefined,
		status: searchParams.get('status') ?? undefined,
		limit: searchParams.get('limit') ?? undefined,
		offset: searchParams.get('offset') ?? undefined,
	};
}

function readExportQuery(url: string): Record<string, string | undefined> {
	const searchParams = new URL(url).searchParams;
	return {
		entity_type: searchParams.get('entity_type') ?? undefined,
	};
}

export function registerTaxonomyRoutes(app: ApiApp): void {
	registerOpenApiRoute(
		app,
		{
			method: 'get',
			path: '/api/taxonomy',
			operationId: 'listTaxonomyEntries',
			tags: ['Taxonomy'],
			security: AUTH_SECURITY,
			request: {
				query: TaxonomyListQuerySchema,
			},
			responses: {
				200: jsonResponse(TaxonomyListResponseSchema, 'Taxonomy entries'),
				...COMMON_ERROR_RESPONSES,
			},
		},
		async (c) => {
			const query = TaxonomyListQuerySchema.parse(readListQuery(c.req.url));
			const response = await listTaxonomyEntries(query, readRouteOptions(c));
			TaxonomyListResponseSchema.parse(response);
			return c.json(response, 200);
		},
	);

	registerOpenApiRoute(
		app,
		{
			method: 'get',
			path: '/api/taxonomy/export',
			operationId: 'exportTaxonomyYaml',
			tags: ['Taxonomy'],
			security: AUTH_SECURITY,
			request: {
				query: TaxonomyExportQuerySchema,
			},
			responses: {
				200: textResponse('application/yaml', 'Curated taxonomy YAML export'),
				...COMMON_ERROR_RESPONSES,
			},
		},
		async (c) => {
			const query = TaxonomyExportQuerySchema.parse(readExportQuery(c.req.url));
			const yaml = await exportTaxonomyYaml(query, readRouteOptions(c));
			return c.text(yaml, 200, {
				'Content-Type': 'application/yaml; charset=utf-8',
			});
		},
	);
}
