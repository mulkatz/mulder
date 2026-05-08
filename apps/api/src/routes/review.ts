import type { Context } from 'hono';
import {
	getReviewArtifact,
	listReviewArtifactEvents,
	listReviewArtifactsForQueue,
	listReviewQueueSummaries,
	recordReviewAction,
} from '../lib/review.js';
import {
	type ApiApp,
	AUTH_SECURITY,
	COMMON_ERROR_RESPONSES,
	jsonRequestBody,
	jsonResponse,
	registerOpenApiRoute,
} from './openapi.js';
import {
	ReviewActionRequestSchema,
	ReviewActionResponseSchema,
	ReviewArtifactDetailResponseSchema,
	ReviewArtifactListResponseSchema,
	ReviewArtifactParamsSchema,
	ReviewEventListResponseSchema,
	ReviewEventsQuerySchema,
	ReviewListQuerySchema,
	ReviewQueueKeyParamsSchema,
	ReviewQueueListResponseSchema,
} from './review.schemas.js';

function readRouteOptions(c: Context) {
	return { authPrincipal: c.get('authPrincipal') };
}

function readQuery(url: string): Record<string, string | undefined> {
	const searchParams = new URL(url).searchParams;
	return {
		review_status: searchParams.get('review_status') ?? undefined,
		limit: searchParams.get('limit') ?? undefined,
		offset: searchParams.get('offset') ?? undefined,
	};
}

async function readJsonBody(c: Context): Promise<unknown> {
	try {
		return await c.req.json();
	} catch {
		return {};
	}
}

export function registerReviewRoutes(app: ApiApp): void {
	registerOpenApiRoute(
		app,
		{
			method: 'get',
			path: '/api/review/queues',
			operationId: 'listReviewQueues',
			tags: ['Review'],
			security: AUTH_SECURITY,
			responses: {
				200: jsonResponse(ReviewQueueListResponseSchema, 'Review queues'),
				...COMMON_ERROR_RESPONSES,
			},
		},
		async (c) => {
			const response = await listReviewQueueSummaries(readRouteOptions(c));
			ReviewQueueListResponseSchema.parse(response);
			return c.json(response, 200);
		},
	);

	registerOpenApiRoute(
		app,
		{
			method: 'get',
			path: '/api/review/queues/{queueKey}/artifacts',
			operationId: 'listReviewQueueArtifacts',
			tags: ['Review'],
			security: AUTH_SECURITY,
			request: {
				params: ReviewQueueKeyParamsSchema,
				query: ReviewListQuerySchema,
			},
			responses: {
				200: jsonResponse(ReviewArtifactListResponseSchema, 'Review queue artifacts'),
				...COMMON_ERROR_RESPONSES,
			},
		},
		async (c) => {
			const { queueKey } = ReviewQueueKeyParamsSchema.parse({ queueKey: c.req.param('queueKey') });
			const query = ReviewListQuerySchema.parse(readQuery(c.req.url));
			const response = await listReviewArtifactsForQueue(queueKey, query, readRouteOptions(c));
			ReviewArtifactListResponseSchema.parse(response);
			return c.json(response, 200);
		},
	);

	registerOpenApiRoute(
		app,
		{
			method: 'get',
			path: '/api/review/artifacts/{artifactId}',
			operationId: 'getReviewArtifact',
			tags: ['Review'],
			security: AUTH_SECURITY,
			request: {
				params: ReviewArtifactParamsSchema,
			},
			responses: {
				200: jsonResponse(ReviewArtifactDetailResponseSchema, 'Review artifact'),
				...COMMON_ERROR_RESPONSES,
			},
		},
		async (c) => {
			const { artifactId } = ReviewArtifactParamsSchema.parse({ artifactId: c.req.param('artifactId') });
			const response = await getReviewArtifact(artifactId, readRouteOptions(c));
			ReviewArtifactDetailResponseSchema.parse(response);
			return c.json(response, 200);
		},
	);

	registerOpenApiRoute(
		app,
		{
			method: 'get',
			path: '/api/review/artifacts/{artifactId}/events',
			operationId: 'listReviewArtifactEvents',
			tags: ['Review'],
			security: AUTH_SECURITY,
			request: {
				params: ReviewArtifactParamsSchema,
				query: ReviewEventsQuerySchema,
			},
			responses: {
				200: jsonResponse(ReviewEventListResponseSchema, 'Review artifact events'),
				...COMMON_ERROR_RESPONSES,
			},
		},
		async (c) => {
			const { artifactId } = ReviewArtifactParamsSchema.parse({ artifactId: c.req.param('artifactId') });
			const query = ReviewEventsQuerySchema.parse(readQuery(c.req.url));
			const response = await listReviewArtifactEvents(artifactId, query, readRouteOptions(c));
			ReviewEventListResponseSchema.parse(response);
			return c.json(response, 200);
		},
	);

	registerOpenApiRoute(
		app,
		{
			method: 'post',
			path: '/api/review/artifacts/{artifactId}/actions',
			operationId: 'recordReviewAction',
			tags: ['Review'],
			security: AUTH_SECURITY,
			request: {
				params: ReviewArtifactParamsSchema,
				body: jsonRequestBody(ReviewActionRequestSchema, 'Review action'),
			},
			responses: {
				200: jsonResponse(ReviewActionResponseSchema, 'Recorded review action'),
				...COMMON_ERROR_RESPONSES,
			},
		},
		async (c) => {
			const { artifactId } = ReviewArtifactParamsSchema.parse({ artifactId: c.req.param('artifactId') });
			const input = ReviewActionRequestSchema.parse(await readJsonBody(c));
			const response = await recordReviewAction(artifactId, input, readRouteOptions(c));
			ReviewActionResponseSchema.parse(response);
			return c.json(response, 200);
		},
	);
}
