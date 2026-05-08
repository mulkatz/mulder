import type { Context } from 'hono';
import {
	getDocumentDetail,
	getDocumentObservability,
	getDocumentStories,
	listDocumentPages,
	listDocuments,
	streamDocumentLayout,
	streamDocumentPage,
	streamDocumentPdf,
} from '../lib/documents.js';
import {
	DocumentDetailResponseSchema,
	DocumentListQuerySchema,
	DocumentListResponseSchema,
	DocumentObservabilityResponseSchema,
	DocumentPageParamsSchema,
	DocumentPagesResponseSchema,
	DocumentParamsSchema,
	DocumentStoriesResponseSchema,
} from './documents.schemas.js';
import {
	type ApiApp,
	AUTH_SECURITY,
	binaryResponse,
	COMMON_ERROR_RESPONSES,
	jsonResponse,
	registerOpenApiRoute,
	textResponse,
} from './openapi.js';

function readDocumentListQuery(url: string): Record<string, string | undefined> {
	const searchParams = new URL(url).searchParams;

	return {
		status: searchParams.get('status') ?? undefined,
		search: searchParams.get('search') ?? undefined,
		limit: searchParams.get('limit') ?? undefined,
		offset: searchParams.get('offset') ?? undefined,
	};
}

function readRequestLogger(c: Context) {
	return c.get('requestContext')?.logger;
}

function readRouteOptions(c: Context) {
	return { authPrincipal: c.get('authPrincipal') };
}

export function registerDocumentRoutes(app: ApiApp): void {
	registerOpenApiRoute(
		app,
		{
			method: 'get',
			path: '/api/documents',
			operationId: 'listDocuments',
			tags: ['Documents'],
			security: AUTH_SECURITY,
			request: {
				query: DocumentListQuerySchema,
			},
			responses: {
				200: jsonResponse(DocumentListResponseSchema, 'Documents'),
				...COMMON_ERROR_RESPONSES,
			},
		},
		async (c) => {
			const query = DocumentListQuerySchema.parse(readDocumentListQuery(c.req.url));
			const response = await listDocuments(query, readRequestLogger(c), readRouteOptions(c));
			DocumentListResponseSchema.parse(response);
			return c.json(response, 200);
		},
	);

	registerOpenApiRoute(
		app,
		{
			method: 'get',
			path: '/api/documents/{id}',
			operationId: 'getDocument',
			tags: ['Documents'],
			security: AUTH_SECURITY,
			request: {
				params: DocumentParamsSchema,
			},
			responses: {
				200: jsonResponse(DocumentDetailResponseSchema, 'Document detail'),
				...COMMON_ERROR_RESPONSES,
			},
		},
		async (c) => {
			const { id } = DocumentParamsSchema.parse({ id: c.req.param('id') });
			const response = await getDocumentDetail(id, readRequestLogger(c), readRouteOptions(c));
			DocumentDetailResponseSchema.parse(response);
			return c.json(response, 200);
		},
	);

	registerOpenApiRoute(
		app,
		{
			method: 'get',
			path: '/api/documents/{id}/pdf',
			operationId: 'getDocumentPdf',
			tags: ['Documents'],
			security: AUTH_SECURITY,
			request: {
				params: DocumentParamsSchema,
			},
			responses: {
				200: binaryResponse('application/pdf', 'Original PDF'),
				...COMMON_ERROR_RESPONSES,
			},
		},
		async (c) => {
			const { id } = DocumentParamsSchema.parse({ id: c.req.param('id') });
			return await streamDocumentPdf(id, readRequestLogger(c), readRouteOptions(c));
		},
	);

	registerOpenApiRoute(
		app,
		{
			method: 'get',
			path: '/api/documents/{id}/layout',
			operationId: 'getDocumentLayout',
			tags: ['Documents'],
			security: AUTH_SECURITY,
			request: {
				params: DocumentParamsSchema,
			},
			responses: {
				200: textResponse('text/markdown', 'Extracted layout Markdown'),
				...COMMON_ERROR_RESPONSES,
			},
		},
		async (c) => {
			const { id } = DocumentParamsSchema.parse({ id: c.req.param('id') });
			return await streamDocumentLayout(id, readRequestLogger(c), readRouteOptions(c));
		},
	);

	registerOpenApiRoute(
		app,
		{
			method: 'get',
			path: '/api/documents/{id}/pages',
			operationId: 'listDocumentPages',
			tags: ['Documents'],
			security: AUTH_SECURITY,
			request: {
				params: DocumentParamsSchema,
			},
			responses: {
				200: jsonResponse(DocumentPagesResponseSchema, 'Document pages'),
				...COMMON_ERROR_RESPONSES,
			},
		},
		async (c) => {
			const { id } = DocumentParamsSchema.parse({ id: c.req.param('id') });
			const response = await listDocumentPages(id, readRequestLogger(c), readRouteOptions(c));
			DocumentPagesResponseSchema.parse(response);
			return c.json(response, 200);
		},
	);

	registerOpenApiRoute(
		app,
		{
			method: 'get',
			path: '/api/documents/{id}/stories',
			operationId: 'listDocumentStories',
			tags: ['Documents'],
			security: AUTH_SECURITY,
			request: {
				params: DocumentParamsSchema,
			},
			responses: {
				200: jsonResponse(DocumentStoriesResponseSchema, 'Document stories'),
				...COMMON_ERROR_RESPONSES,
			},
		},
		async (c) => {
			const { id } = DocumentParamsSchema.parse({ id: c.req.param('id') });
			const response = await getDocumentStories(id, readRequestLogger(c), readRouteOptions(c));
			DocumentStoriesResponseSchema.parse(response);
			return c.json(response, 200);
		},
	);

	registerOpenApiRoute(
		app,
		{
			method: 'get',
			path: '/api/documents/{id}/observability',
			operationId: 'getDocumentObservability',
			tags: ['Documents'],
			security: AUTH_SECURITY,
			request: {
				params: DocumentParamsSchema,
			},
			responses: {
				200: jsonResponse(DocumentObservabilityResponseSchema, 'Document processing background'),
				...COMMON_ERROR_RESPONSES,
			},
		},
		async (c) => {
			const { id } = DocumentParamsSchema.parse({ id: c.req.param('id') });
			const response = await getDocumentObservability(id, readRequestLogger(c), readRouteOptions(c));
			DocumentObservabilityResponseSchema.parse(response);
			return c.json(response, 200);
		},
	);

	registerOpenApiRoute(
		app,
		{
			method: 'get',
			path: '/api/documents/{id}/pages/{num}',
			operationId: 'getDocumentPageImage',
			tags: ['Documents'],
			security: AUTH_SECURITY,
			request: {
				params: DocumentPageParamsSchema,
			},
			responses: {
				200: binaryResponse('image/png', 'Document page image'),
				...COMMON_ERROR_RESPONSES,
			},
		},
		async (c) => {
			const { id, num } = DocumentPageParamsSchema.parse({
				id: c.req.param('id'),
				num: c.req.param('num'),
			});
			return await streamDocumentPage(id, num, readRequestLogger(c), readRouteOptions(c));
		},
	);
}
