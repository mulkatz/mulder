import { type Logger, MulderError } from '@mulder/core';
import type { Context } from 'hono';
import {
	completeDocumentUpload,
	getDocumentUploadFinalizationStatus,
	handleDevUploadProxy,
	initiateDocumentUpload,
} from '../lib/uploads.js';
import {
	type ApiApp,
	AUTH_SECURITY,
	COMMON_ERROR_RESPONSES,
	emptyResponse,
	jsonRequestBody,
	jsonResponse,
	registerOpenApiRoute,
} from './openapi.js';
import {
	CompleteDocumentUploadRequestSchema,
	CompleteDocumentUploadResponseSchema,
	DevUploadQuerySchema,
	InitiateDocumentUploadRequestSchema,
	InitiateDocumentUploadResponseSchema,
	UploadFinalizationParamsSchema,
	UploadFinalizationStatusResponseSchema,
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

function readRouteOptions(c: Context) {
	return { authPrincipal: c.get('authPrincipal') };
}

export function registerUploadRoutes(app: ApiApp): void {
	registerOpenApiRoute(
		app,
		{
			method: 'post',
			path: '/api/uploads/documents/initiate',
			operationId: 'initiateDocumentUpload',
			tags: ['Uploads'],
			security: AUTH_SECURITY,
			request: {
				body: jsonRequestBody(InitiateDocumentUploadRequestSchema, 'Document upload initiation request'),
			},
			responses: {
				201: jsonResponse(InitiateDocumentUploadResponseSchema, 'Upload target'),
				...COMMON_ERROR_RESPONSES,
			},
		},
		async (c) => {
			const body = InitiateDocumentUploadRequestSchema.parse(await readJsonBody(c));
			const response = await initiateDocumentUpload(body, readRequestLogger(c));
			InitiateDocumentUploadResponseSchema.parse(response);
			return c.json(response, 201);
		},
	);

	registerOpenApiRoute(
		app,
		{
			method: 'get',
			path: '/api/uploads/documents/finalizations/{jobId}',
			operationId: 'getDocumentUploadFinalizationStatus',
			tags: ['Uploads'],
			security: AUTH_SECURITY,
			request: {
				params: UploadFinalizationParamsSchema,
			},
			responses: {
				200: jsonResponse(UploadFinalizationStatusResponseSchema, 'Document upload finalization status'),
				...COMMON_ERROR_RESPONSES,
			},
		},
		async (c) => {
			const { jobId } = UploadFinalizationParamsSchema.parse({ jobId: c.req.param('jobId') });
			const response = await getDocumentUploadFinalizationStatus(jobId, readRouteOptions(c));
			UploadFinalizationStatusResponseSchema.parse(response);
			return c.json(response, 200);
		},
	);

	registerOpenApiRoute(
		app,
		{
			method: 'post',
			path: '/api/uploads/documents/complete',
			operationId: 'completeDocumentUpload',
			tags: ['Uploads'],
			security: AUTH_SECURITY,
			request: {
				body: jsonRequestBody(CompleteDocumentUploadRequestSchema, 'Completed upload metadata'),
			},
			responses: {
				202: jsonResponse(CompleteDocumentUploadResponseSchema, 'Upload completed and processing accepted'),
				...COMMON_ERROR_RESPONSES,
			},
		},
		async (c) => {
			const body = CompleteDocumentUploadRequestSchema.parse(await readJsonBody(c));
			const response = await completeDocumentUpload(body, readRequestLogger(c), readRouteOptions(c));
			CompleteDocumentUploadResponseSchema.parse(response);
			return c.json(response, 202);
		},
	);

	registerOpenApiRoute(
		app,
		{
			method: 'put',
			path: '/api/uploads/documents/dev-upload',
			operationId: 'devUploadDocumentBytes',
			tags: ['Uploads'],
			security: AUTH_SECURITY,
			request: {
				query: DevUploadQuerySchema,
			},
			responses: {
				204: emptyResponse('Upload bytes accepted'),
				...COMMON_ERROR_RESPONSES,
			},
		},
		async (c) => {
			const { storage_path } = DevUploadQuerySchema.parse({
				storage_path: new URL(c.req.url).searchParams.get('storage_path') ?? '',
			});
			const contentType = c.req.header('content-type') ?? 'application/octet-stream';
			const body = Buffer.from(await c.req.arrayBuffer());
			await handleDevUploadProxy(storage_path, body, contentType, readRequestLogger(c));
			return c.body(null, 204);
		},
	);
}
