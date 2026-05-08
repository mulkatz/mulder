import type { Context, Hono } from 'hono';
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

export function registerDocumentRoutes(app: Hono): void {
	app.get('/api/documents', async (c) => {
		const query = DocumentListQuerySchema.parse(readDocumentListQuery(c.req.url));
		const response = await listDocuments(query, readRequestLogger(c), readRouteOptions(c));
		DocumentListResponseSchema.parse(response);
		return c.json(response, 200);
	});

	app.get('/api/documents/:id', async (c) => {
		const { id } = DocumentParamsSchema.parse({ id: c.req.param('id') });
		const response = await getDocumentDetail(id, readRequestLogger(c), readRouteOptions(c));
		DocumentDetailResponseSchema.parse(response);
		return c.json(response, 200);
	});

	app.get('/api/documents/:id/pdf', async (c) => {
		const { id } = DocumentParamsSchema.parse({ id: c.req.param('id') });
		return await streamDocumentPdf(id, readRequestLogger(c), readRouteOptions(c));
	});

	app.get('/api/documents/:id/layout', async (c) => {
		const { id } = DocumentParamsSchema.parse({ id: c.req.param('id') });
		return await streamDocumentLayout(id, readRequestLogger(c), readRouteOptions(c));
	});

	app.get('/api/documents/:id/pages', async (c) => {
		const { id } = DocumentParamsSchema.parse({ id: c.req.param('id') });
		const response = await listDocumentPages(id, readRequestLogger(c), readRouteOptions(c));
		DocumentPagesResponseSchema.parse(response);
		return c.json(response, 200);
	});

	app.get('/api/documents/:id/stories', async (c) => {
		const { id } = DocumentParamsSchema.parse({ id: c.req.param('id') });
		const response = await getDocumentStories(id, readRequestLogger(c), readRouteOptions(c));
		DocumentStoriesResponseSchema.parse(response);
		return c.json(response, 200);
	});

	app.get('/api/documents/:id/observability', async (c) => {
		const { id } = DocumentParamsSchema.parse({ id: c.req.param('id') });
		const response = await getDocumentObservability(id, readRequestLogger(c), readRouteOptions(c));
		DocumentObservabilityResponseSchema.parse(response);
		return c.json(response, 200);
	});

	app.get('/api/documents/:id/pages/:num', async (c) => {
		const { id, num } = DocumentPageParamsSchema.parse({
			id: c.req.param('id'),
			num: c.req.param('num'),
		});
		return await streamDocumentPage(id, num, readRequestLogger(c), readRouteOptions(c));
	});
}
