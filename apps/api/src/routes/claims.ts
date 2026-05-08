import type { Context } from 'hono';
import { getClaim, listClaims, listDocumentClaims, listStoryClaims } from '../lib/claims.js';
import {
	ClaimDetailResponseSchema,
	ClaimDocumentParamsSchema,
	ClaimListQuerySchema,
	ClaimListResponseSchema,
	ClaimParamsSchema,
	ClaimStoryParamsSchema,
} from './claims.schemas.js';
import { type ApiApp, AUTH_SECURITY, COMMON_ERROR_RESPONSES, jsonResponse, registerOpenApiRoute } from './openapi.js';

function readRouteOptions(c: Context) {
	return { authPrincipal: c.get('authPrincipal') };
}

function readQuery(url: string): Record<string, string | undefined> {
	const searchParams = new URL(url).searchParams;
	return {
		source_id: searchParams.get('source_id') ?? undefined,
		story_id: searchParams.get('story_id') ?? undefined,
		assertion_type: searchParams.get('assertion_type') ?? undefined,
		limit: searchParams.get('limit') ?? undefined,
		offset: searchParams.get('offset') ?? undefined,
	};
}

export function registerClaimRoutes(app: ApiApp): void {
	registerOpenApiRoute(
		app,
		{
			method: 'get',
			path: '/api/claims',
			operationId: 'listClaims',
			tags: ['Claims'],
			security: AUTH_SECURITY,
			request: {
				query: ClaimListQuerySchema,
			},
			responses: {
				200: jsonResponse(ClaimListResponseSchema, 'Claims'),
				...COMMON_ERROR_RESPONSES,
			},
		},
		async (c) => {
			const query = ClaimListQuerySchema.parse(readQuery(c.req.url));
			const response = await listClaims(query, readRouteOptions(c));
			ClaimListResponseSchema.parse(response);
			return c.json(response, 200);
		},
	);

	registerOpenApiRoute(
		app,
		{
			method: 'get',
			path: '/api/claims/{claimId}',
			operationId: 'getClaim',
			tags: ['Claims'],
			security: AUTH_SECURITY,
			request: {
				params: ClaimParamsSchema,
			},
			responses: {
				200: jsonResponse(ClaimDetailResponseSchema, 'Claim detail'),
				...COMMON_ERROR_RESPONSES,
			},
		},
		async (c) => {
			const { claimId } = ClaimParamsSchema.parse({ claimId: c.req.param('claimId') });
			const response = await getClaim(claimId, readRouteOptions(c));
			ClaimDetailResponseSchema.parse(response);
			return c.json(response, 200);
		},
	);

	registerOpenApiRoute(
		app,
		{
			method: 'get',
			path: '/api/documents/{id}/claims',
			operationId: 'listDocumentClaims',
			tags: ['Claims'],
			security: AUTH_SECURITY,
			request: {
				params: ClaimDocumentParamsSchema,
				query: ClaimListQuerySchema.omit({ source_id: true }),
			},
			responses: {
				200: jsonResponse(ClaimListResponseSchema, 'Document claims'),
				...COMMON_ERROR_RESPONSES,
			},
		},
		async (c) => {
			const { id } = ClaimDocumentParamsSchema.parse({ id: c.req.param('id') });
			const query = ClaimListQuerySchema.omit({ source_id: true }).parse(readQuery(c.req.url));
			const response = await listDocumentClaims(id, query, readRouteOptions(c));
			ClaimListResponseSchema.parse(response);
			return c.json(response, 200);
		},
	);

	registerOpenApiRoute(
		app,
		{
			method: 'get',
			path: '/api/stories/{storyId}/claims',
			operationId: 'listStoryClaims',
			tags: ['Claims'],
			security: AUTH_SECURITY,
			request: {
				params: ClaimStoryParamsSchema,
				query: ClaimListQuerySchema.omit({ story_id: true }),
			},
			responses: {
				200: jsonResponse(ClaimListResponseSchema, 'Story claims'),
				...COMMON_ERROR_RESPONSES,
			},
		},
		async (c) => {
			const { storyId } = ClaimStoryParamsSchema.parse({ storyId: c.req.param('storyId') });
			const query = ClaimListQuerySchema.omit({ story_id: true }).parse(readQuery(c.req.url));
			const response = await listStoryClaims(storyId, query, readRouteOptions(c));
			ClaimListResponseSchema.parse(response);
			return c.json(response, 200);
		},
	);
}
