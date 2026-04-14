import { MulderError } from '@mulder/core';
import type { Context, Hono } from 'hono';
import { buildPipelineAcceptedResponse, createPipelineRetryJob, createPipelineRunJob } from '../lib/pipeline-jobs.js';
import { PipelineAcceptedJobSchema, PipelineRetryRequestSchema, PipelineRunRequestSchema } from './pipeline.schemas.js';

async function readJsonBody(c: Context): Promise<unknown> {
	try {
		return await c.req.json();
	} catch {
		throw new MulderError('Invalid request', 'VALIDATION_ERROR');
	}
}

export function registerPipelineRoutes(app: Hono): void {
	app.post('/api/pipeline/run', async (c) => {
		const body = PipelineRunRequestSchema.parse(await readJsonBody(c));
		const { run, job } = await createPipelineRunJob(body);
		const response = buildPipelineAcceptedResponse(run, job);
		PipelineAcceptedJobSchema.parse(response);
		return c.json(response, 202);
	});

	app.post('/api/pipeline/retry', async (c) => {
		const body = PipelineRetryRequestSchema.parse(await readJsonBody(c));
		const { run, job } = await createPipelineRetryJob(body);
		const response = buildPipelineAcceptedResponse(run, job);
		PipelineAcceptedJobSchema.parse(response);
		return c.json(response, 202);
	});
}
