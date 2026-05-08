import { MulderError } from '@mulder/core';
import type { Context } from 'hono';
import {
	createCollectionFromApi,
	getCollectionDetail,
	listCollectionSummaries,
	patchCollectionFromApi,
} from '../lib/collections.js';
import {
	CollectionDetailResponseSchema,
	CollectionListQuerySchema,
	CollectionListResponseSchema,
	CollectionParamsSchema,
	CreateCollectionRequestSchema,
	PatchCollectionRequestSchema,
} from './collections.schemas.js';
import {
	type ApiApp,
	AUTH_SECURITY,
	COMMON_ERROR_RESPONSES,
	jsonRequestBody,
	jsonResponse,
	registerOpenApiRoute,
} from './openapi.js';

function readRouteOptions(c: Context) {
	return { authPrincipal: c.get('authPrincipal') };
}

function readQuery(url: string): Record<string, string | undefined> {
	const searchParams = new URL(url).searchParams;
	return {
		type: searchParams.get('type') ?? undefined,
		visibility: searchParams.get('visibility') ?? undefined,
		archive_id: searchParams.get('archive_id') ?? undefined,
		tag: searchParams.get('tag') ?? undefined,
		limit: searchParams.get('limit') ?? undefined,
		offset: searchParams.get('offset') ?? undefined,
	};
}

async function readJsonBody(c: Context): Promise<unknown> {
	try {
		return await c.req.json();
	} catch {
		throw new MulderError('Invalid request', 'VALIDATION_ERROR');
	}
}

export function registerCollectionRoutes(app: ApiApp): void {
	registerOpenApiRoute(
		app,
		{
			method: 'get',
			path: '/api/collections',
			operationId: 'listCollections',
			tags: ['Collections'],
			security: AUTH_SECURITY,
			request: {
				query: CollectionListQuerySchema,
			},
			responses: {
				200: jsonResponse(CollectionListResponseSchema, 'Collections'),
				...COMMON_ERROR_RESPONSES,
			},
		},
		async (c) => {
			const query = CollectionListQuerySchema.parse(readQuery(c.req.url));
			const response = await listCollectionSummaries(query, readRouteOptions(c));
			CollectionListResponseSchema.parse(response);
			return c.json(response, 200);
		},
	);

	registerOpenApiRoute(
		app,
		{
			method: 'post',
			path: '/api/collections',
			operationId: 'createCollection',
			tags: ['Collections'],
			security: AUTH_SECURITY,
			request: {
				body: jsonRequestBody(CreateCollectionRequestSchema, 'Collection creation request'),
			},
			responses: {
				201: jsonResponse(CollectionDetailResponseSchema, 'Created collection'),
				...COMMON_ERROR_RESPONSES,
			},
		},
		async (c) => {
			const input = CreateCollectionRequestSchema.parse(await readJsonBody(c));
			const response = await createCollectionFromApi(input, readRouteOptions(c));
			CollectionDetailResponseSchema.parse(response);
			return c.json(response, 201);
		},
	);

	registerOpenApiRoute(
		app,
		{
			method: 'get',
			path: '/api/collections/{collectionId}',
			operationId: 'getCollection',
			tags: ['Collections'],
			security: AUTH_SECURITY,
			request: {
				params: CollectionParamsSchema,
			},
			responses: {
				200: jsonResponse(CollectionDetailResponseSchema, 'Collection detail'),
				...COMMON_ERROR_RESPONSES,
			},
		},
		async (c) => {
			const { collectionId } = CollectionParamsSchema.parse({ collectionId: c.req.param('collectionId') });
			const response = await getCollectionDetail(collectionId, readRouteOptions(c));
			CollectionDetailResponseSchema.parse(response);
			return c.json(response, 200);
		},
	);

	registerOpenApiRoute(
		app,
		{
			method: 'patch',
			path: '/api/collections/{collectionId}',
			operationId: 'patchCollection',
			tags: ['Collections'],
			security: AUTH_SECURITY,
			request: {
				params: CollectionParamsSchema,
				body: jsonRequestBody(PatchCollectionRequestSchema, 'Collection patch request'),
			},
			responses: {
				200: jsonResponse(CollectionDetailResponseSchema, 'Updated collection'),
				...COMMON_ERROR_RESPONSES,
			},
		},
		async (c) => {
			const { collectionId } = CollectionParamsSchema.parse({ collectionId: c.req.param('collectionId') });
			const input = PatchCollectionRequestSchema.parse(await readJsonBody(c));
			const response = await patchCollectionFromApi(collectionId, input, readRouteOptions(c));
			CollectionDetailResponseSchema.parse(response);
			return c.json(response, 200);
		},
	);
}
