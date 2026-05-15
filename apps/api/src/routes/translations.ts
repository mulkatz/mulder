import type { Context } from 'hono';
import {
	getTranslation,
	listDocumentTranslations,
	listTranslationStories,
	requestDocumentTranslation,
} from '../lib/translations.js';
import {
	type ApiApp,
	AUTH_SECURITY,
	COMMON_ERROR_RESPONSES,
	jsonRequestBody,
	jsonResponse,
	registerOpenApiRoute,
} from './openapi.js';
import {
	CreateTranslationRequestSchema,
	TranslationAcceptedResponseSchema,
	TranslationDetailResponseSchema,
	TranslationIdParamsSchema,
	TranslationListQuerySchema,
	TranslationListResponseSchema,
	TranslationParamsSchema,
	TranslationStoriesResponseSchema,
} from './translations.schemas.js';

function readTranslationListQuery(url: string): Record<string, string | undefined> {
	const searchParams = new URL(url).searchParams;
	return {
		target_language: searchParams.get('target_language') ?? undefined,
		status: searchParams.get('status') ?? undefined,
		limit: searchParams.get('limit') ?? undefined,
		offset: searchParams.get('offset') ?? undefined,
	};
}

function readRouteOptions(c: Context) {
	return { authPrincipal: c.get('authPrincipal') };
}

async function readJsonBody(c: Context): Promise<unknown> {
	try {
		return await c.req.json();
	} catch {
		return {};
	}
}

export function registerTranslationRoutes(app: ApiApp): void {
	registerOpenApiRoute(
		app,
		{
			method: 'get',
			path: '/api/documents/{id}/translations',
			operationId: 'listDocumentTranslations',
			tags: ['Translations'],
			security: AUTH_SECURITY,
			request: {
				params: TranslationParamsSchema,
				query: TranslationListQuerySchema,
			},
			responses: {
				200: jsonResponse(TranslationListResponseSchema, 'Document translations'),
				...COMMON_ERROR_RESPONSES,
			},
		},
		async (c) => {
			const { id } = TranslationParamsSchema.parse({ id: c.req.param('id') });
			const query = TranslationListQuerySchema.parse(readTranslationListQuery(c.req.url));
			const response = await listDocumentTranslations(id, query, readRouteOptions(c));
			TranslationListResponseSchema.parse(response);
			return c.json(response, 200);
		},
	);

	registerOpenApiRoute(
		app,
		{
			method: 'post',
			path: '/api/documents/{id}/translations',
			operationId: 'requestDocumentTranslation',
			tags: ['Translations'],
			security: AUTH_SECURITY,
			request: {
				params: TranslationParamsSchema,
				body: jsonRequestBody(CreateTranslationRequestSchema, 'Translation request'),
			},
			responses: {
				200: jsonResponse(TranslationDetailResponseSchema, 'Cached translation'),
				202: jsonResponse(TranslationAcceptedResponseSchema, 'Translation job accepted'),
				...COMMON_ERROR_RESPONSES,
			},
		},
		async (c) => {
			const { id } = TranslationParamsSchema.parse({ id: c.req.param('id') });
			const input = CreateTranslationRequestSchema.parse(await readJsonBody(c));
			const response = await requestDocumentTranslation(id, input, readRouteOptions(c));
			if (response.status === 200) {
				TranslationDetailResponseSchema.parse(response.body);
				return c.json(response.body, 200);
			}
			TranslationAcceptedResponseSchema.parse(response.body);
			return c.json(response.body, 202);
		},
	);

	registerOpenApiRoute(
		app,
		{
			method: 'get',
			path: '/api/translations/{translationId}',
			operationId: 'getTranslation',
			tags: ['Translations'],
			security: AUTH_SECURITY,
			request: {
				params: TranslationIdParamsSchema,
			},
			responses: {
				200: jsonResponse(TranslationDetailResponseSchema, 'Translation detail'),
				...COMMON_ERROR_RESPONSES,
			},
		},
		async (c) => {
			const { translationId } = TranslationIdParamsSchema.parse({ translationId: c.req.param('translationId') });
			const response = await getTranslation(translationId, readRouteOptions(c));
			TranslationDetailResponseSchema.parse(response);
			return c.json(response, 200);
		},
	);

	registerOpenApiRoute(
		app,
		{
			method: 'get',
			path: '/api/translations/{translationId}/stories',
			operationId: 'listTranslationStories',
			tags: ['Translations'],
			security: AUTH_SECURITY,
			request: {
				params: TranslationIdParamsSchema,
			},
			responses: {
				200: jsonResponse(TranslationStoriesResponseSchema, 'Translated stories'),
				...COMMON_ERROR_RESPONSES,
			},
		},
		async (c) => {
			const { translationId } = TranslationIdParamsSchema.parse({ translationId: c.req.param('translationId') });
			const response = await listTranslationStories(translationId, readRouteOptions(c));
			TranslationStoriesResponseSchema.parse(response);
			return c.json(response, 200);
		},
	);
}
