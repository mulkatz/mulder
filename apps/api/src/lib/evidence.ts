import { performance } from 'node:perf_hooks';
import {
	countEdges,
	countEdgesByTypes,
	countEntities,
	countEvidenceChains,
	countEvidenceTheses,
	countScoredSources,
	countSources,
	countSpatioTemporalClusters,
	createChildLogger,
	createLogger,
	DATABASE_ERROR_CODES,
	DatabaseError,
	type EdgeType,
	type EntityEdge,
	type EvidenceChain,
	findAllEdges,
	findAllEdgesByTypes,
	findAllEvidenceChains,
	findAllSources,
	findAllSpatioTemporalClusters,
	findEvidenceChainsByThesis,
	findScoredSources,
	getEntityCorroborationStats,
	getQueryPool,
	type Logger,
	loadConfig,
	type MulderConfig,
} from '@mulder/core';
import type pg from 'pg';
import type {
	EvidenceChainGroupResponse,
	EvidenceChainSnapshotResponse,
	EvidenceChainsQuery,
	EvidenceChainsResponse,
	EvidenceClustersQuery,
	EvidenceClustersResponse,
	EvidenceContradictionResponse,
	EvidenceContradictionsQuery,
	EvidenceContradictionsResponse,
	EvidenceReliabilitySourcesQuery,
	EvidenceReliabilitySourcesResponse,
	EvidenceSummaryResponse,
} from '../routes/evidence.schemas.js';

type CoreEvidenceChain = EvidenceChain;
type EvidenceContradictionEdgeType = Extract<
	EdgeType,
	'POTENTIAL_CONTRADICTION' | 'CONFIRMED_CONTRADICTION' | 'DISMISSED_CONTRADICTION'
>;

interface EvidenceContradictionEdge extends EntityEdge {
	edgeType: EvidenceContradictionEdgeType;
}

interface EvidenceContext {
	config: MulderConfig;
	pool: pg.Pool;
}

const logger = createLogger();

let cachedContext: EvidenceContext | null = null;
let cachedConfigPath: string | null = null;

function resolveConfigPath(): string {
	return process.env.MULDER_CONFIG ?? 'mulder.config.yaml';
}

function resolveContext(): EvidenceContext {
	const configPath = resolveConfigPath();
	if (cachedContext && cachedConfigPath === configPath) {
		return cachedContext;
	}

	const config = loadConfig(configPath);
	if (!config.gcp?.cloud_sql) {
		throw new DatabaseError(
			'GCP cloud_sql configuration is required for evidence routes',
			DATABASE_ERROR_CODES.DB_CONNECTION_FAILED,
			{
				context: {
					configPath,
				},
			},
		);
	}

	cachedContext = {
		config,
		pool: getQueryPool(config.gcp.cloud_sql),
	};
	cachedConfigPath = configPath;
	return cachedContext;
}

function createRouteLogger(rootLogger: Logger, metadata: Record<string, string | number | boolean | null | undefined>) {
	return createChildLogger(rootLogger, {
		module: 'api',
		route: 'evidence',
		...metadata,
	});
}

function computeDataReliability(sourceCount: number, threshold: number): 'insufficient' | 'low' | 'moderate' | 'high' {
	const ratio = sourceCount / threshold;
	if (ratio < 0.25) return 'insufficient';
	if (ratio < 0.5) return 'low';
	if (ratio < 1.0) return 'moderate';
	return 'high';
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toIsoString(value: Date): string {
	return value.toISOString();
}

function mapEvidenceChain(chain: CoreEvidenceChain): EvidenceChainSnapshotResponse {
	return {
		id: chain.id,
		path: chain.path,
		strength: chain.strength,
		supports: chain.supports,
		computed_at: toIsoString(chain.computedAt),
	};
}

function mapContradictionAnalysis(analysis: unknown): EvidenceContradictionResponse['analysis'] {
	if (!isRecord(analysis)) {
		return null;
	}

	const verdict = analysis.verdict;
	const winningClaim = analysis.winning_claim;
	const confidence = analysis.confidence;
	const explanation = analysis.explanation;

	if (
		(verdict !== 'confirmed' && verdict !== 'dismissed') ||
		(winningClaim !== 'A' && winningClaim !== 'B' && winningClaim !== 'neither') ||
		typeof confidence !== 'number' ||
		typeof explanation !== 'string'
	) {
		return null;
	}

	return {
		verdict,
		winning_claim: winningClaim,
		confidence,
		explanation,
	};
}

function isEvidenceContradictionEdge(edge: EntityEdge): edge is EvidenceContradictionEdge {
	return (
		edge.edgeType === 'POTENTIAL_CONTRADICTION' ||
		edge.edgeType === 'CONFIRMED_CONTRADICTION' ||
		edge.edgeType === 'DISMISSED_CONTRADICTION'
	);
}

function mapContradictionEdge(edge: EvidenceContradictionEdge): EvidenceContradictionResponse {
	const attributes = isRecord(edge.attributes)
		? {
				attribute: String(edge.attributes.attribute ?? ''),
				valueA: String(edge.attributes.valueA ?? ''),
				valueB: String(edge.attributes.valueB ?? ''),
			}
		: {
				attribute: '',
				valueA: '',
				valueB: '',
			};

	return {
		id: edge.id,
		source_entity_id: edge.sourceEntityId,
		target_entity_id: edge.targetEntityId,
		relationship: edge.relationship,
		edge_type: edge.edgeType,
		story_id: edge.storyId,
		confidence: edge.confidence,
		attributes,
		analysis: mapContradictionAnalysis(edge.analysis),
	};
}

function mapSourceReliability(source: Awaited<ReturnType<typeof findAllSources>>[number]) {
	return {
		id: source.id,
		filename: source.filename,
		status: source.status,
		reliability_score: source.reliabilityScore,
		created_at: toIsoString(source.createdAt),
		updated_at: toIsoString(source.updatedAt),
	};
}

function groupEvidenceChains(chains: CoreEvidenceChain[]): EvidenceChainGroupResponse[] {
	const byThesis = new Map<string, CoreEvidenceChain[]>();

	for (const chain of chains) {
		const existing = byThesis.get(chain.thesis);
		if (existing) {
			existing.push(chain);
		} else {
			byThesis.set(chain.thesis, [chain]);
		}
	}

	return [...byThesis.entries()].map(([thesis, groupedChains]) => ({
		thesis,
		chains: groupedChains.map(mapEvidenceChain),
	}));
}

function mapCluster(cluster: Awaited<ReturnType<typeof findAllSpatioTemporalClusters>>[number]) {
	return {
		id: cluster.id,
		cluster_type: cluster.clusterType ?? 'spatio-temporal',
		center_lat: cluster.centerLat,
		center_lng: cluster.centerLng,
		time_start: cluster.timeStart ? toIsoString(cluster.timeStart) : null,
		time_end: cluster.timeEnd ? toIsoString(cluster.timeEnd) : null,
		event_count: cluster.eventCount,
		event_ids: cluster.eventIds,
		computed_at: toIsoString(cluster.computedAt),
	};
}

export async function getEvidenceSummary(loggerOverride?: Logger): Promise<EvidenceSummaryResponse> {
	const rootLogger = loggerOverride ?? logger;
	const requestLogger = createRouteLogger(rootLogger, { action: 'summary' });
	const startedAt = performance.now();
	const { config, pool } = resolveContext();

	const [
		totalEntities,
		entityStats,
		totalSources,
		scoredSources,
		potentialCount,
		confirmedCount,
		dismissedCount,
		duplicateCount,
		thesisCount,
		chainCount,
		clusterCount,
	] = await Promise.all([
		countEntities(pool),
		getEntityCorroborationStats(pool),
		countSources(pool),
		countScoredSources(pool),
		countEdges(pool, { edgeType: 'POTENTIAL_CONTRADICTION' }),
		countEdges(pool, { edgeType: 'CONFIRMED_CONTRADICTION' }),
		countEdges(pool, { edgeType: 'DISMISSED_CONTRADICTION' }),
		countEdges(pool, { edgeType: 'DUPLICATE_OF' }),
		countEvidenceTheses(pool),
		countEvidenceChains(pool),
		countSpatioTemporalClusters(pool),
	]);
	const dataReliability = computeDataReliability(totalSources, config.thresholds?.corroboration_meaningful ?? 50);

	const response: EvidenceSummaryResponse = {
		data: {
			entities: {
				total: totalEntities,
				scored: entityStats.scoredCount,
				avg_corroboration: entityStats.avgCorroboration,
			},
			contradictions: {
				potential: potentialCount,
				confirmed: confirmedCount,
				dismissed: dismissedCount,
			},
			duplicates: {
				count: duplicateCount,
			},
			sources: {
				total: totalSources,
				scored: scoredSources,
				data_reliability: dataReliability,
			},
			evidence_chains: {
				thesis_count: thesisCount,
				record_count: chainCount,
			},
			clusters: {
				count: clusterCount,
			},
		},
	};

	requestLogger.info(
		{
			total_entities: totalEntities,
			scored_entities: entityStats.scoredCount,
			total_sources: totalSources,
			scored_sources: scoredSources,
			contradictions: potentialCount + confirmedCount + dismissedCount,
			duplicate_count: duplicateCount,
			thesis_count: thesisCount,
			cluster_count: clusterCount,
			duration_ms: Math.round(performance.now() - startedAt),
		},
		'evidence summary request completed',
	);

	return response;
}

export async function listEvidenceContradictions(
	input: EvidenceContradictionsQuery,
	loggerOverride?: Logger,
): Promise<EvidenceContradictionsResponse> {
	const rootLogger = loggerOverride ?? logger;
	const requestLogger = createRouteLogger(rootLogger, {
		action: 'contradictions',
		status: input.status,
		limit: input.limit,
		offset: input.offset,
	});
	const startedAt = performance.now();
	const { pool } = resolveContext();

	const edgeTypes: EvidenceContradictionEdgeType[] =
		input.status === 'all'
			? ['POTENTIAL_CONTRADICTION', 'CONFIRMED_CONTRADICTION', 'DISMISSED_CONTRADICTION']
			: [
					input.status === 'potential'
						? 'POTENTIAL_CONTRADICTION'
						: input.status === 'confirmed'
							? 'CONFIRMED_CONTRADICTION'
							: 'DISMISSED_CONTRADICTION',
				];

	const [count, edges] =
		input.status === 'all'
			? await Promise.all([
					countEdgesByTypes(pool, edgeTypes),
					findAllEdgesByTypes(pool, {
						edgeTypes,
						limit: input.limit,
						offset: input.offset,
					}),
				])
			: await Promise.all([
					countEdges(pool, { edgeType: edgeTypes[0] }),
					findAllEdges(pool, {
						edgeType: edgeTypes[0],
						limit: input.limit,
						offset: input.offset,
					}),
				]);

	const pagedEdges = edges.filter(isEvidenceContradictionEdge).map(mapContradictionEdge);

	const response: EvidenceContradictionsResponse = {
		data: pagedEdges,
		meta: {
			count,
			limit: input.limit,
			offset: input.offset,
			status: input.status,
		},
	};

	requestLogger.info(
		{
			count,
			result_count: response.data.length,
			status: input.status,
			duration_ms: Math.round(performance.now() - startedAt),
		},
		'evidence contradictions request completed',
	);

	return response;
}

export async function listSourceReliability(
	input: EvidenceReliabilitySourcesQuery,
	loggerOverride?: Logger,
): Promise<EvidenceReliabilitySourcesResponse> {
	const rootLogger = loggerOverride ?? logger;
	const requestLogger = createRouteLogger(rootLogger, {
		action: 'sources',
		scored_only: input.scored_only,
		limit: input.limit,
		offset: input.offset,
	});
	const startedAt = performance.now();
	const { pool } = resolveContext();

	const [count, sources] = input.scored_only
		? await Promise.all([
				countScoredSources(pool),
				findScoredSources(pool, { limit: input.limit, offset: input.offset }),
			])
		: await Promise.all([countSources(pool), findAllSources(pool, { limit: input.limit, offset: input.offset })]);

	const response: EvidenceReliabilitySourcesResponse = {
		data: sources.map(mapSourceReliability),
		meta: {
			count,
			limit: input.limit,
			offset: input.offset,
			scored_only: input.scored_only,
		},
	};

	requestLogger.info(
		{
			count,
			result_count: response.data.length,
			scored_only: input.scored_only,
			duration_ms: Math.round(performance.now() - startedAt),
		},
		'evidence source reliability request completed',
	);

	return response;
}

export async function listEvidenceChains(
	input: EvidenceChainsQuery,
	loggerOverride?: Logger,
): Promise<EvidenceChainsResponse> {
	const rootLogger = loggerOverride ?? logger;
	const requestLogger = createRouteLogger(rootLogger, {
		action: 'chains',
		thesis: input.thesis ?? null,
	});
	const startedAt = performance.now();
	const { pool } = resolveContext();

	const groupedChains = input.thesis
		? groupEvidenceChains(await findEvidenceChainsByThesis(pool, input.thesis))
		: groupEvidenceChains(await findAllEvidenceChains(pool));

	const recordCount = groupedChains.reduce((total, group) => total + group.chains.length, 0);
	const thesisCount = groupedChains.length;

	const response: EvidenceChainsResponse = {
		data: groupedChains,
		meta: {
			thesis_count: thesisCount,
			record_count: recordCount,
		},
	};

	requestLogger.info(
		{
			thesis_count: thesisCount,
			record_count: recordCount,
			duration_ms: Math.round(performance.now() - startedAt),
		},
		'evidence chains request completed',
	);

	return response;
}

export async function listSpatioTemporalClusters(
	input: EvidenceClustersQuery,
	loggerOverride?: Logger,
): Promise<EvidenceClustersResponse> {
	const rootLogger = loggerOverride ?? logger;
	const requestLogger = createRouteLogger(rootLogger, {
		action: 'clusters',
		cluster_type: input.cluster_type ?? null,
	});
	const startedAt = performance.now();
	const { pool } = resolveContext();

	const [count, clusters] = await Promise.all([
		countSpatioTemporalClusters(pool, input.cluster_type ? { clusterType: input.cluster_type } : undefined),
		findAllSpatioTemporalClusters(pool, input.cluster_type ? { clusterType: input.cluster_type } : undefined),
	]);

	const response: EvidenceClustersResponse = {
		data: clusters.map(mapCluster),
		meta: input.cluster_type
			? {
					count,
					cluster_type: input.cluster_type,
				}
			: {
					count,
				},
	};

	requestLogger.info(
		{
			count,
			result_count: response.data.length,
			cluster_type: input.cluster_type ?? null,
			duration_ms: Math.round(performance.now() - startedAt),
		},
		'evidence clusters request completed',
	);

	return response;
}

export function resetEvidenceContextForTests(): void {
	cachedContext = null;
	cachedConfigPath = null;
}
