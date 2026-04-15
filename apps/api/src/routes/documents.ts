import type { Context, Hono } from 'hono';
import {
	listDocumentPages,
	listDocuments,
	streamDocumentLayout,
	streamDocumentPage,
	streamDocumentPdf,
} from '../lib/documents.js';
import {
	DocumentListQuerySchema,
	DocumentListResponseSchema,
	DocumentPageParamsSchema,
	DocumentPagesResponseSchema,
	DocumentParamsSchema,
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

export function registerDocumentRoutes(app: Hono): void {
	app.get('/api/documents', async (c) => {
		const query = DocumentListQuerySchema.parse(readDocumentListQuery(c.req.url));
		const response = await listDocuments(query, readRequestLogger(c));
		DocumentListResponseSchema.parse(response);
		return c.json(response, 200);
	});

	app.get('/api/documents/:id/pdf', async (c) => {
		const { id } = DocumentParamsSchema.parse({ id: c.req.param('id') });
		return await streamDocumentPdf(id, readRequestLogger(c));
	});

	app.get('/api/documents/:id/layout', async (c) => {
		const { id } = DocumentParamsSchema.parse({ id: c.req.param('id') });
		return await streamDocumentLayout(id, readRequestLogger(c));
	});

	app.get('/api/documents/:id/pages', async (c) => {
		const { id } = DocumentParamsSchema.parse({ id: c.req.param('id') });
		const response = await listDocumentPages(id, readRequestLogger(c));
		DocumentPagesResponseSchema.parse(response);
		return c.json(response, 200);
	});

	app.get('/api/documents/:id/pages/:num', async (c) => {
		const { id, num } = DocumentPageParamsSchema.parse({
			id: c.req.param('id'),
			num: c.req.param('num'),
		});
		return await streamDocumentPage(id, num, readRequestLogger(c));
	});
}
