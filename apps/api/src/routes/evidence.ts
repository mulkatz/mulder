import type { Hono } from 'hono';
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

export function registerEvidenceRoutes(app: Hono): void {
	app.get('/api/evidence/summary', async (c) => {
		const response = await getEvidenceSummary(c.get('requestContext')?.logger);
		EvidenceSummaryResponseSchema.parse(response);
		return c.json(response, 200);
	});

	app.get('/api/evidence/contradictions', async (c) => {
		const query = EvidenceContradictionsQuerySchema.parse(readEvidenceContradictionsQuery(c.req.url));
		const response = await listEvidenceContradictions(query, c.get('requestContext')?.logger);
		EvidenceContradictionsResponseSchema.parse(response);
		return c.json(response, 200);
	});

	app.get('/api/evidence/reliability/sources', async (c) => {
		const query = EvidenceReliabilitySourcesQuerySchema.parse(readEvidenceReliabilitySourcesQuery(c.req.url));
		const response = await listSourceReliability(query, c.get('requestContext')?.logger);
		EvidenceReliabilitySourcesResponseSchema.parse(response);
		return c.json(response, 200);
	});

	app.get('/api/evidence/chains', async (c) => {
		const query = EvidenceChainsQuerySchema.parse(readEvidenceChainsQuery(c.req.url));
		const response = await listEvidenceChains(query, c.get('requestContext')?.logger);
		EvidenceChainsResponseSchema.parse(response);
		return c.json(response, 200);
	});

	app.get('/api/evidence/clusters', async (c) => {
		const query = EvidenceClustersQuerySchema.parse(readEvidenceClustersQuery(c.req.url));
		const response = await listSpatioTemporalClusters(query, c.get('requestContext')?.logger);
		EvidenceClustersResponseSchema.parse(response);
		return c.json(response, 200);
	});
}
