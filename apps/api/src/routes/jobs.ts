import type { Hono } from 'hono';
import { getJobStatusById, listRecentJobs } from '../lib/job-status.js';
import {
	JobDetailParamsSchema,
	JobDetailResponseSchema,
	JobListQuerySchema,
	JobListResponseSchema,
} from './jobs.schemas.js';

function readJobListQuery(url: string): Record<string, string | undefined> {
	const searchParams = new URL(url).searchParams;
	return {
		status: searchParams.get('status') ?? undefined,
		type: searchParams.get('type') ?? undefined,
		worker_id: searchParams.get('worker_id') ?? undefined,
		limit: searchParams.get('limit') ?? undefined,
	};
}

export function registerJobRoutes(app: Hono): void {
	app.get('/api/jobs', async (c) => {
		const query = JobListQuerySchema.parse(readJobListQuery(c.req.url));
		const response = await listRecentJobs(query);
		JobListResponseSchema.parse(response);
		return c.json(response, 200);
	});

	app.get('/api/jobs/:id', async (c) => {
		const { id } = JobDetailParamsSchema.parse({ id: c.req.param('id') });
		const response = await getJobStatusById(id);
		JobDetailResponseSchema.parse(response);
		return c.json(response, 200);
	});
}
