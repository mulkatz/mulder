import { MulderError } from '@mulder/core';
import type { Context, Hono } from 'hono';
import { getEntityDetail, getEntityEdges, listEntities, mergeEntities } from '../lib/entities.js';
import {
	EntityDetailResponseSchema,
	EntityEdgesResponseSchema,
	EntityListQuerySchema,
	EntityListResponseSchema,
	EntityMergeRequestSchema,
	EntityMergeResponseSchema,
} from './entities.schemas.js';

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

export function registerEntityRoutes(app: Hono): void {
	app.get('/api/entities', async (c) => {
		const query = EntityListQuerySchema.parse(readEntityListQuery(c.req.url));
		const response = await listEntities(query, c.get('requestContext')?.logger);
		EntityListResponseSchema.parse(response);
		return c.json(response, 200);
	});

	app.get('/api/entities/:id', async (c) => {
		const response = await getEntityDetail(c.req.param('id'), c.get('requestContext')?.logger);
		EntityDetailResponseSchema.parse(response);
		return c.json(response, 200);
	});

	app.get('/api/entities/:id/edges', async (c) => {
		const response = await getEntityEdges(c.req.param('id'), c.get('requestContext')?.logger);
		EntityEdgesResponseSchema.parse(response);
		return c.json(response, 200);
	});

	app.post('/api/entities/merge', async (c) => {
		const body = EntityMergeRequestSchema.parse(await readJsonBody(c));
		const response = await mergeEntities(body.target_id, body.source_id, c.get('requestContext')?.logger);
		EntityMergeResponseSchema.parse(response);
		return c.json(response, 200);
	});
}
