import type { Context } from 'hono';
import { getJobStatusById, listRecentJobs } from '../lib/job-status.js';
import {
	JobDetailParamsSchema,
	JobDetailResponseSchema,
	JobListQuerySchema,
	JobListResponseSchema,
} from './jobs.schemas.js';
import { type ApiApp, AUTH_SECURITY, COMMON_ERROR_RESPONSES, jsonResponse, registerOpenApiRoute } from './openapi.js';

function readJobListQuery(url: string): Record<string, string | undefined> {
	const searchParams = new URL(url).searchParams;
	return {
		status: searchParams.get('status') ?? undefined,
		type: searchParams.get('type') ?? undefined,
		worker_id: searchParams.get('worker_id') ?? undefined,
		limit: searchParams.get('limit') ?? undefined,
	};
}

function readRouteOptions(c: Context) {
	return { authPrincipal: c.get('authPrincipal') };
}

export function registerJobRoutes(app: ApiApp): void {
	registerOpenApiRoute(
		app,
		{
			method: 'get',
			path: '/api/jobs',
			operationId: 'listJobs',
			tags: ['Jobs'],
			security: AUTH_SECURITY,
			request: {
				query: JobListQuerySchema,
			},
			responses: {
				200: jsonResponse(JobListResponseSchema, 'Recent jobs'),
				...COMMON_ERROR_RESPONSES,
			},
		},
		async (c) => {
			const query = JobListQuerySchema.parse(readJobListQuery(c.req.url));
			const response = await listRecentJobs(query, readRouteOptions(c));
			JobListResponseSchema.parse(response);
			return c.json(response, 200);
		},
	);

	registerOpenApiRoute(
		app,
		{
			method: 'get',
			path: '/api/jobs/{id}',
			operationId: 'getJob',
			tags: ['Jobs'],
			security: AUTH_SECURITY,
			request: {
				params: JobDetailParamsSchema,
			},
			responses: {
				200: jsonResponse(JobDetailResponseSchema, 'Job detail'),
				...COMMON_ERROR_RESPONSES,
			},
		},
		async (c) => {
			const { id } = JobDetailParamsSchema.parse({ id: c.req.param('id') });
			const response = await getJobStatusById(id, readRouteOptions(c));
			JobDetailResponseSchema.parse(response);
			return c.json(response, 200);
		},
	);
}
