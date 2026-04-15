import { type Logger, MulderError } from '@mulder/core';
import type { Context, Hono } from 'hono';
import { completeDocumentUpload, handleDevUploadProxy, initiateDocumentUpload } from '../lib/uploads.js';
import {
	CompleteDocumentUploadRequestSchema,
	CompleteDocumentUploadResponseSchema,
	DevUploadQuerySchema,
	InitiateDocumentUploadRequestSchema,
	InitiateDocumentUploadResponseSchema,
} from './uploads.schemas.js';

async function readJsonBody(c: Context): Promise<unknown> {
	try {
		return await c.req.json();
	} catch {
		throw new MulderError('Invalid request', 'VALIDATION_ERROR');
	}
}

function readRequestLogger(c: Context): Logger | undefined {
	return c.get('requestContext')?.logger;
}

export function registerUploadRoutes(app: Hono): void {
	app.post('/api/uploads/documents/initiate', async (c) => {
		const body = InitiateDocumentUploadRequestSchema.parse(await readJsonBody(c));
		const response = await initiateDocumentUpload(body, readRequestLogger(c));
		InitiateDocumentUploadResponseSchema.parse(response);
		return c.json(response, 201);
	});

	app.post('/api/uploads/documents/complete', async (c) => {
		const body = CompleteDocumentUploadRequestSchema.parse(await readJsonBody(c));
		const response = await completeDocumentUpload(body, readRequestLogger(c));
		CompleteDocumentUploadResponseSchema.parse(response);
		return c.json(response, 202);
	});

	app.put('/api/uploads/documents/dev-upload', async (c) => {
		const { storage_path } = DevUploadQuerySchema.parse({
			storage_path: new URL(c.req.url).searchParams.get('storage_path') ?? '',
		});
		const contentType = c.req.header('content-type') ?? 'application/octet-stream';
		const body = Buffer.from(await c.req.arrayBuffer());
		await handleDevUploadProxy(storage_path, body, contentType, readRequestLogger(c));
		return c.body(null, 204);
	});
}
