import { createLogger, MulderError } from '@mulder/core';
import type { Context, Hono } from 'hono';
import { runSearch } from '../lib/search.js';
import { SearchRequestSchema, SearchResponseSchema } from './search.schemas.js';

async function readJsonBody(c: Context): Promise<unknown> {
	try {
		return await c.req.json();
	} catch {
		throw new MulderError('Invalid request', 'VALIDATION_ERROR');
	}
}

function readNoRerankToggle(url: string): boolean {
	const searchParams = new URL(url).searchParams;
	return searchParams.get('no_rerank') === 'true' || searchParams.get('rerank') === 'false';
}

export function registerSearchRoute(app: Hono): void {
	app.post('/api/search', async (c) => {
		const body = SearchRequestSchema.parse(await readJsonBody(c));
		const requestContext = c.get('requestContext');
		const response = await runSearch(
			{
				...body,
				no_rerank: readNoRerankToggle(c.req.url),
			},
			requestContext?.logger ?? createLogger(),
		);
		SearchResponseSchema.parse(response);
		return c.json(response, 200);
	});
}
