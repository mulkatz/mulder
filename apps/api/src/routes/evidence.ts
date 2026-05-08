import {
	getEvidenceSummary,
	listEvidenceChains,
	listEvidenceContradictions,
	listSourceReliability,
	listSpatioTemporalClusters,
} from '../lib/evidence.js';
import {
	EvidenceChainsQuerySchema,
	EvidenceChainsResponseSchema,
	EvidenceClustersQuerySchema,
	EvidenceClustersResponseSchema,
	EvidenceContradictionsQuerySchema,
	EvidenceContradictionsResponseSchema,
	EvidenceReliabilitySourcesQuerySchema,
	EvidenceReliabilitySourcesResponseSchema,
	EvidenceSummaryResponseSchema,
} from './evidence.schemas.js';
import { type ApiApp, AUTH_SECURITY, COMMON_ERROR_RESPONSES, jsonResponse, registerOpenApiRoute } from './openapi.js';

function readBooleanQuery(value: string | null): string | undefined {
	if (value === null) {
		return undefined;
	}
	return value;
}

function readEvidenceContradictionsQuery(url: string): Record<string, string | undefined> {
	const searchParams = new URL(url).searchParams;
	return {
		status: searchParams.get('status') ?? undefined,
		limit: searchParams.get('limit') ?? undefined,
		offset: searchParams.get('offset') ?? undefined,
	};
}

function readEvidenceReliabilitySourcesQuery(url: string): Record<string, string | undefined> {
	const searchParams = new URL(url).searchParams;
	return {
		scored_only: readBooleanQuery(searchParams.get('scored_only')),
		limit: searchParams.get('limit') ?? undefined,
		offset: searchParams.get('offset') ?? undefined,
	};
}

function readEvidenceChainsQuery(url: string): Record<string, string | undefined> {
	const searchParams = new URL(url).searchParams;
	return {
		thesis: searchParams.get('thesis') ?? undefined,
	};
}

function readEvidenceClustersQuery(url: string): Record<string, string | undefined> {
	const searchParams = new URL(url).searchParams;
	return {
		cluster_type: searchParams.get('cluster_type') ?? undefined,
	};
}

export function registerEvidenceRoutes(app: ApiApp): void {
	registerOpenApiRoute(
		app,
		{
			method: 'get',
			path: '/api/evidence/summary',
			operationId: 'getEvidenceSummary',
			tags: ['Evidence'],
			security: AUTH_SECURITY,
			responses: {
				200: jsonResponse(EvidenceSummaryResponseSchema, 'Evidence summary'),
				...COMMON_ERROR_RESPONSES,
			},
		},
		async (c) => {
			const response = await getEvidenceSummary(c.get('requestContext')?.logger);
			EvidenceSummaryResponseSchema.parse(response);
			return c.json(response, 200);
		},
	);

	registerOpenApiRoute(
		app,
		{
			method: 'get',
			path: '/api/evidence/contradictions',
			operationId: 'listEvidenceContradictions',
			tags: ['Evidence'],
			security: AUTH_SECURITY,
			request: {
				query: EvidenceContradictionsQuerySchema,
			},
			responses: {
				200: jsonResponse(EvidenceContradictionsResponseSchema, 'Evidence contradictions'),
				...COMMON_ERROR_RESPONSES,
			},
		},
		async (c) => {
			const query = EvidenceContradictionsQuerySchema.parse(readEvidenceContradictionsQuery(c.req.url));
			const response = await listEvidenceContradictions(query, c.get('requestContext')?.logger);
			EvidenceContradictionsResponseSchema.parse(response);
			return c.json(response, 200);
		},
	);

	registerOpenApiRoute(
		app,
		{
			method: 'get',
			path: '/api/evidence/reliability/sources',
			operationId: 'listEvidenceReliabilitySources',
			tags: ['Evidence'],
			security: AUTH_SECURITY,
			request: {
				query: EvidenceReliabilitySourcesQuerySchema,
			},
			responses: {
				200: jsonResponse(EvidenceReliabilitySourcesResponseSchema, 'Source reliability evidence'),
				...COMMON_ERROR_RESPONSES,
			},
		},
		async (c) => {
			const query = EvidenceReliabilitySourcesQuerySchema.parse(readEvidenceReliabilitySourcesQuery(c.req.url));
			const response = await listSourceReliability(query, c.get('requestContext')?.logger);
			EvidenceReliabilitySourcesResponseSchema.parse(response);
			return c.json(response, 200);
		},
	);

	registerOpenApiRoute(
		app,
		{
			method: 'get',
			path: '/api/evidence/chains',
			operationId: 'listEvidenceChains',
			tags: ['Evidence'],
			security: AUTH_SECURITY,
			request: {
				query: EvidenceChainsQuerySchema,
			},
			responses: {
				200: jsonResponse(EvidenceChainsResponseSchema, 'Evidence chains'),
				...COMMON_ERROR_RESPONSES,
			},
		},
		async (c) => {
			const query = EvidenceChainsQuerySchema.parse(readEvidenceChainsQuery(c.req.url));
			const response = await listEvidenceChains(query, c.get('requestContext')?.logger);
			EvidenceChainsResponseSchema.parse(response);
			return c.json(response, 200);
		},
	);

	registerOpenApiRoute(
		app,
		{
			method: 'get',
			path: '/api/evidence/clusters',
			operationId: 'listEvidenceClusters',
			tags: ['Evidence'],
			security: AUTH_SECURITY,
			request: {
				query: EvidenceClustersQuerySchema,
			},
			responses: {
				200: jsonResponse(EvidenceClustersResponseSchema, 'Evidence clusters'),
				...COMMON_ERROR_RESPONSES,
			},
		},
		async (c) => {
			const query = EvidenceClustersQuerySchema.parse(readEvidenceClustersQuery(c.req.url));
			const response = await listSpatioTemporalClusters(query, c.get('requestContext')?.logger);
			EvidenceClustersResponseSchema.parse(response);
			return c.json(response, 200);
		},
	);
}
