import { MulderError } from '@mulder/core';
import type { Context } from 'hono';
import { buildPipelineAcceptedResponse, createPipelineRetryJob, createPipelineRunJob } from '../lib/pipeline-jobs.js';
import {
	type ApiApp,
	AUTH_SECURITY,
	COMMON_ERROR_RESPONSES,
	jsonRequestBody,
	jsonResponse,
	registerOpenApiRoute,
} from './openapi.js';
import { PipelineAcceptedJobSchema, PipelineRetryRequestSchema, PipelineRunRequestSchema } from './pipeline.schemas.js';

async function readJsonBody(c: Context): Promise<unknown> {
	try {
		return await c.req.json();
	} catch {
		throw new MulderError('Invalid request', 'VALIDATION_ERROR');
	}
}

export function registerPipelineRoutes(app: ApiApp): void {
	registerOpenApiRoute(
		app,
		{
			method: 'post',
			path: '/api/pipeline/run',
			operationId: 'runPipeline',
			tags: ['Pipeline'],
			security: AUTH_SECURITY,
			request: {
				body: jsonRequestBody(PipelineRunRequestSchema, 'Pipeline run request'),
			},
			responses: {
				202: jsonResponse(PipelineAcceptedJobSchema, 'Pipeline job accepted'),
				...COMMON_ERROR_RESPONSES,
			},
		},
		async (c) => {
			const body = PipelineRunRequestSchema.parse(await readJsonBody(c));
			const { run, job } = await createPipelineRunJob(body);
			const response = buildPipelineAcceptedResponse(run, job);
			PipelineAcceptedJobSchema.parse(response);
			return c.json(response, 202);
		},
	);

	registerOpenApiRoute(
		app,
		{
			method: 'post',
			path: '/api/pipeline/retry',
			operationId: 'retryPipeline',
			tags: ['Pipeline'],
			security: AUTH_SECURITY,
			request: {
				body: jsonRequestBody(PipelineRetryRequestSchema, 'Pipeline retry request'),
			},
			responses: {
				202: jsonResponse(PipelineAcceptedJobSchema, 'Retry job accepted'),
				...COMMON_ERROR_RESPONSES,
			},
		},
		async (c) => {
			const body = PipelineRetryRequestSchema.parse(await readJsonBody(c));
			const { run, job } = await createPipelineRetryJob(body);
			const response = buildPipelineAcceptedResponse(run, job);
			PipelineAcceptedJobSchema.parse(response);
			return c.json(response, 202);
		},
	);
}
