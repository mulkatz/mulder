import { MulderError } from '@mulder/core';
import type { Context } from 'hono';
import { z } from 'zod';
import { getEntityDetail, getEntityEdges, listEntities, mergeEntities } from '../lib/entities.js';
import {
	EntityDetailResponseSchema,
	EntityEdgesResponseSchema,
	EntityListQuerySchema,
	EntityListResponseSchema,
	EntityMergeRequestSchema,
	EntityMergeResponseSchema,
} from './entities.schemas.js';
import {
	type ApiApp,
	AUTH_SECURITY,
	COMMON_ERROR_RESPONSES,
	jsonRequestBody,
	jsonResponse,
	registerOpenApiRoute,
} from './openapi.js';

async function readJsonBody(c: Context): Promise<unknown> {
	try {
		return await c.req.json();
	} catch {
		throw new MulderError('Invalid request', 'VALIDATION_ERROR');
	}
}

function readEntityListQuery(url: string): Record<string, string | undefined> {
	const searchParams = new URL(url).searchParams;

	return {
		type: searchParams.get('type') ?? undefined,
		search: searchParams.get('search') ?? undefined,
		taxonomy_status: searchParams.get('taxonomy_status') ?? undefined,
		limit: searchParams.get('limit') ?? undefined,
		offset: searchParams.get('offset') ?? undefined,
	};
}

function readRouteOptions(c: Context) {
	return { authPrincipal: c.get('authPrincipal') };
}

const EntityIdParamsSchema = z.object({
	id: z.string().uuid(),
});

export function registerEntityRoutes(app: ApiApp): void {
	registerOpenApiRoute(
		app,
		{
			method: 'get',
			path: '/api/entities',
			operationId: 'listEntities',
			tags: ['Entities'],
			security: AUTH_SECURITY,
			request: {
				query: EntityListQuerySchema,
			},
			responses: {
				200: jsonResponse(EntityListResponseSchema, 'Entities'),
				...COMMON_ERROR_RESPONSES,
			},
		},
		async (c) => {
			const query = EntityListQuerySchema.parse(readEntityListQuery(c.req.url));
			const response = await listEntities(query, c.get('requestContext')?.logger, readRouteOptions(c));
			EntityListResponseSchema.parse(response);
			return c.json(response, 200);
		},
	);

	registerOpenApiRoute(
		app,
		{
			method: 'get',
			path: '/api/entities/{id}',
			operationId: 'getEntity',
			tags: ['Entities'],
			security: AUTH_SECURITY,
			request: {
				params: EntityIdParamsSchema,
			},
			responses: {
				200: jsonResponse(EntityDetailResponseSchema, 'Entity detail'),
				...COMMON_ERROR_RESPONSES,
			},
		},
		async (c) => {
			const { id } = EntityIdParamsSchema.parse({ id: c.req.param('id') });
			const response = await getEntityDetail(id, c.get('requestContext')?.logger, readRouteOptions(c));
			EntityDetailResponseSchema.parse(response);
			return c.json(response, 200);
		},
	);

	registerOpenApiRoute(
		app,
		{
			method: 'get',
			path: '/api/entities/{id}/edges',
			operationId: 'getEntityEdges',
			tags: ['Entities'],
			security: AUTH_SECURITY,
			request: {
				params: EntityIdParamsSchema,
			},
			responses: {
				200: jsonResponse(EntityEdgesResponseSchema, 'Entity edges'),
				...COMMON_ERROR_RESPONSES,
			},
		},
		async (c) => {
			const { id } = EntityIdParamsSchema.parse({ id: c.req.param('id') });
			const response = await getEntityEdges(id, c.get('requestContext')?.logger, readRouteOptions(c));
			EntityEdgesResponseSchema.parse(response);
			return c.json(response, 200);
		},
	);

	registerOpenApiRoute(
		app,
		{
			method: 'post',
			path: '/api/entities/merge',
			operationId: 'mergeEntities',
			tags: ['Entities'],
			security: AUTH_SECURITY,
			request: {
				body: jsonRequestBody(EntityMergeRequestSchema, 'Entity merge request'),
			},
			responses: {
				200: jsonResponse(EntityMergeResponseSchema, 'Entity merge result'),
				...COMMON_ERROR_RESPONSES,
			},
		},
		async (c) => {
			const body = EntityMergeRequestSchema.parse(await readJsonBody(c));
			const response = await mergeEntities(body.target_id, body.source_id, c.get('requestContext')?.logger);
			EntityMergeResponseSchema.parse(response);
			return c.json(response, 200);
		},
	);
}
