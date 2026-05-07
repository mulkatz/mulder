import type {
	CoreSimilarityDimensions,
	DomainSimilarityDimension,
	Entity,
	EntityEdge,
	MulderConfig,
	SensitivityLevel,
	SimilarityDimensionScore,
	SimilarityDomainDimensionConfig,
} from '@mulder/core';
import {
	allowedSensitivityLevelsForMax,
	createEdge,
	findAllEntities,
	findEdgesBetweenEntities,
	findEdgesByEntityId,
	findEntityById,
	listSimilarEntities,
	mergeSensitivityMetadata,
	mostRestrictiveSensitivityLevel,
	updateEdge,
	upsertReviewableArtifact,
	upsertSimilarityResult,
} from '@mulder/core';
import type pg from 'pg';
import type { SimilarEntityDiscoveryOptions, SimilarEntityDiscoveryResult, SimilarEntityScore } from './types.js';

const DAYS_PER_YEAR = 365.25;
const DEFAULT_GEO_RADIUS_KM = 100;
const DEFAULT_TEMPORAL_WINDOW_YEARS = 10;
const SCORE_PRECISION = 6;

interface CandidateSupplementRow {
	candidate_id: string;
	semantic_score: number | null;
	distance_meters: number | null;
}

interface GeoPoint {
	lat: number;
	lng: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function roundScore(value: number): number {
	return Number(Math.min(1, Math.max(0, value)).toFixed(SCORE_PRECISION));
}

function scored(score: number): SimilarityDimensionScore {
	return { status: 'scored', score: roundScore(score), reason: null };
}

function insufficientData(reason: string): SimilarityDimensionScore {
	return { status: 'insufficient_data', score: null, reason };
}

function emptyCoreScores(): CoreSimilarityDimensions {
	return {
		semantic: insufficientData('missing_embedding'),
		structural: insufficientData('sparse_graph_topology'),
		geospatial: insufficientData('missing_geometry'),
		temporal: insufficientData('missing_iso_date'),
	};
}

function parseIsoDate(value: unknown): Date | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	if (!/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return null;
	const normalized = /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? `${trimmed}T00:00:00.000Z` : trimmed;
	const timestamp = Date.parse(normalized);
	return Number.isNaN(timestamp) ? null : new Date(timestamp);
}

function readIsoDate(attributes: Record<string, unknown>): Date | null {
	const preferredKeys = ['iso_date', 'date', 'occurred_at', 'timestamp', 'publication_date'];
	for (const key of preferredKeys) {
		const parsed = parseIsoDate(attributes[key]);
		if (parsed) return parsed;
	}
	for (const [key, value] of Object.entries(attributes)) {
		if (!/date|time/i.test(key)) continue;
		const parsed = parseIsoDate(value);
		if (parsed) return parsed;
	}
	return null;
}

function readGeoPoint(attributes: Record<string, unknown>): GeoPoint | null {
	const value = attributes.geo_point ?? attributes.coordinates;
	if (!isRecord(value)) return null;
	const lat = value.lat;
	const lng = value.lng ?? value.lon ?? value.longitude;
	return typeof lat === 'number' && typeof lng === 'number' ? { lat, lng } : null;
}

function haversineMeters(left: GeoPoint, right: GeoPoint): number {
	const radiusMeters = 6_371_000;
	const toRadians = (value: number) => (value * Math.PI) / 180;
	const deltaLat = toRadians(right.lat - left.lat);
	const deltaLng = toRadians(right.lng - left.lng);
	const leftLat = toRadians(left.lat);
	const rightLat = toRadians(right.lat);
	const a = Math.sin(deltaLat / 2) ** 2 + Math.cos(leftLat) * Math.cos(rightLat) * Math.sin(deltaLng / 2) ** 2;
	return 2 * radiusMeters * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function primitiveDifference(left: unknown, right: unknown): string | null {
	if (left === right) return null;
	if (typeof left === 'string' || typeof left === 'number' || typeof left === 'boolean') {
		if (typeof right === 'string' || typeof right === 'number' || typeof right === 'boolean') {
			return `${String(left)} vs ${String(right)}`;
		}
	}
	return null;
}

function buildKeyDifferences(source: Entity, candidate: Entity): string[] {
	const differences: string[] = [];
	if (source.type !== candidate.type) differences.push(`type: ${source.type} vs ${candidate.type}`);
	for (const key of Object.keys(source.attributes).sort()) {
		const diff = primitiveDifference(source.attributes[key], candidate.attributes[key]);
		if (diff) differences.push(`${key}: ${diff}`);
		if (differences.length >= 3) break;
	}
	return differences;
}

async function loadCandidateSupplements(
	pool: pg.Pool,
	entityId: string,
	limit: number,
	maxSensitivityLevel?: SensitivityLevel,
): Promise<CandidateSupplementRow[]> {
	const sensitivityClause = maxSensitivityLevel ? 'AND e.sensitivity_level = ANY($3)' : '';
	const params: unknown[] = [entityId, limit];
	if (maxSensitivityLevel) params.push(allowedSensitivityLevelsForMax(maxSensitivityLevel));
	const result = await pool.query<CandidateSupplementRow>(
		`
			SELECT
				e.id AS candidate_id,
				CASE
					WHEN source_entity.name_embedding IS NOT NULL AND e.name_embedding IS NOT NULL
					THEN 1 - (source_entity.name_embedding <=> e.name_embedding)
					ELSE NULL
				END AS semantic_score,
				CASE
					WHEN source_entity.geom IS NOT NULL AND e.geom IS NOT NULL
					THEN ST_Distance(source_entity.geom::geography, e.geom::geography)
					ELSE NULL
				END AS distance_meters
			FROM entities source_entity
			JOIN entities e ON e.type = source_entity.type
			WHERE source_entity.id = $1
			  AND e.id <> source_entity.id
			  AND e.canonical_id IS NULL
			  ${sensitivityClause}
			ORDER BY semantic_score DESC NULLS LAST, e.name ASC
			LIMIT $2
		`,
		params,
	);
	return result.rows;
}

async function resolveCandidates(
	pool: pg.Pool,
	source: Entity,
	options: SimilarEntityDiscoveryOptions,
	config: MulderConfig,
): Promise<Array<{ entity: Entity; semanticScore: number | null; distanceMeters: number | null }>> {
	const limit = Math.max(
		options.maxResults ?? config.similar_case_discovery.max_results,
		config.similar_case_discovery.candidate_retrieval.vector_top_k,
	);
	if (options.candidateIds && options.candidateIds.length > 0) {
		const uniqueIds = [...new Set(options.candidateIds)].filter((id) => id !== source.id).slice(0, limit);
		const entities = await Promise.all(
			uniqueIds.map((id) => findEntityById(pool, id, { maxSensitivityLevel: options.maxSensitivityLevel })),
		);
		return entities
			.filter((entity): entity is Entity => entity !== null)
			.map((entity) => ({ entity, semanticScore: null, distanceMeters: null }));
	}

	const supplements = await loadCandidateSupplements(pool, source.id, limit, options.maxSensitivityLevel);
	const supplementById = new Map(supplements.map((row) => [row.candidate_id, row]));
	const fallbackEntities =
		supplements.length === 0
			? await findAllEntities(pool, {
					type: source.type,
					limit,
					maxSensitivityLevel: options.maxSensitivityLevel,
				})
			: [];
	const ids =
		supplements.length > 0 ? supplements.map((row) => row.candidate_id) : fallbackEntities.map((entity) => entity.id);
	const entities = await Promise.all(ids.filter((id) => id !== source.id).map((id) => findEntityById(pool, id)));
	return entities
		.filter((entity): entity is Entity => entity !== null)
		.map((entity) => {
			const supplement = supplementById.get(entity.id);
			return {
				entity,
				semanticScore: supplement?.semantic_score === null ? null : (supplement?.semantic_score ?? null),
				distanceMeters: supplement?.distance_meters === null ? null : (supplement?.distance_meters ?? null),
			};
		});
}

async function scoreStructural(
	pool: pg.Pool,
	source: Entity,
	candidate: Entity,
): Promise<{ score: SimilarityDimensionScore; sharedEntityIds: string[] }> {
	const [sourceEdges, candidateEdges, directEdges]: [EntityEdge[], EntityEdge[], EntityEdge[]] = await Promise.all([
		findEdgesByEntityId(pool, source.id),
		findEdgesByEntityId(pool, candidate.id),
		findEdgesBetweenEntities(pool, source.id, candidate.id),
	]);
	const sourceNeighbors = new Set<string>(
		sourceEdges.map((edge) => (edge.sourceEntityId === source.id ? edge.targetEntityId : edge.sourceEntityId)),
	);
	const candidateNeighbors = new Set<string>(
		candidateEdges.map((edge) => (edge.sourceEntityId === candidate.id ? edge.targetEntityId : edge.sourceEntityId)),
	);
	if (sourceNeighbors.size === 0 && candidateNeighbors.size === 0 && directEdges.length === 0) {
		return { score: insufficientData('sparse_graph_topology'), sharedEntityIds: [] };
	}
	const sharedEntityIds = [...sourceNeighbors].filter((id) => candidateNeighbors.has(id)).sort();
	if (directEdges.length > 0) return { score: scored(1), sharedEntityIds };
	const denominator = Math.max(sourceNeighbors.size, candidateNeighbors.size, 1);
	return { score: scored(sharedEntityIds.length / denominator), sharedEntityIds };
}

function scoreGeospatial(
	source: Entity,
	candidate: Entity,
	distanceMeters: number | null,
	radiusKm: number | null,
): SimilarityDimensionScore {
	let distance = distanceMeters;
	if (distance === null) {
		const sourcePoint = readGeoPoint(source.attributes);
		const candidatePoint = readGeoPoint(candidate.attributes);
		if (sourcePoint && candidatePoint) distance = haversineMeters(sourcePoint, candidatePoint);
	}
	if (distance === null) return insufficientData('missing_geometry');
	const radiusMeters = (radiusKm ?? DEFAULT_GEO_RADIUS_KM) * 1000;
	return scored(1 - Math.min(distance, radiusMeters) / radiusMeters);
}

function scoreTemporal(source: Entity, candidate: Entity, windowYears: number | null): SimilarityDimensionScore {
	const sourceDate = readIsoDate(source.attributes);
	const candidateDate = readIsoDate(candidate.attributes);
	if (!sourceDate || !candidateDate) return insufficientData('missing_iso_date');
	const diffYears = Math.abs(sourceDate.getTime() - candidateDate.getTime()) / (1000 * 60 * 60 * 24 * DAYS_PER_YEAR);
	const denominator = windowYears ?? DEFAULT_TEMPORAL_WINDOW_YEARS;
	return scored(1 - Math.min(diffYears, denominator) / denominator);
}

function scoreDomainDimension(
	source: Entity,
	candidate: Entity,
	dimension: SimilarityDomainDimensionConfig,
): DomainSimilarityDimension {
	const left = source.attributes[dimension.config_ref];
	const right = candidate.attributes[dimension.config_ref];
	if (dimension.source !== 'attribute_comparison') {
		return {
			id: dimension.id,
			label: dimension.label,
			source: dimension.source,
			configRef: dimension.config_ref,
			score: null,
			status: 'insufficient_data',
			reason: 'dimension_source_not_available',
			metadata: dimension.metadata,
		};
	}
	if (left === undefined || right === undefined) {
		return {
			id: dimension.id,
			label: dimension.label,
			source: dimension.source,
			configRef: dimension.config_ref,
			score: null,
			status: 'insufficient_data',
			reason: 'missing_attribute',
			metadata: dimension.metadata,
		};
	}
	const score = Array.isArray(left) && Array.isArray(right) ? scoreArrayOverlap(left, right) : left === right ? 1 : 0;
	return {
		id: dimension.id,
		label: dimension.label,
		source: dimension.source,
		configRef: dimension.config_ref,
		score: roundScore(score),
		status: 'scored',
		reason: null,
		metadata: dimension.metadata,
	};
}

function scoreArrayOverlap(left: unknown[], right: unknown[]): number {
	const leftValues = new Set(left.map((value) => JSON.stringify(value)));
	const rightValues = new Set(right.map((value) => JSON.stringify(value)));
	if (leftValues.size === 0 && rightValues.size === 0) return 1;
	const shared = [...leftValues].filter((value) => rightValues.has(value)).length;
	return shared / Math.max(leftValues.size, rightValues.size);
}

function weightedRankScore(
	core: CoreSimilarityDimensions,
	domain: DomainSimilarityDimension[],
	config: MulderConfig,
): number {
	let totalWeight = 0;
	let weightedScore = 0;
	for (const dimension of config.similar_case_discovery.scoring.core_dimensions) {
		const score = core[dimension];
		const weight = config.similar_case_discovery.scoring.weights[dimension];
		if (score.status === 'scored' && score.score !== null && weight > 0) {
			totalWeight += weight;
			weightedScore += score.score * weight;
		}
	}
	for (const dimension of domain) {
		const configured = config.similar_case_discovery.scoring.domain_dimensions.find((item) => item.id === dimension.id);
		const weight = configured?.weight ?? 0;
		if (dimension.status === 'scored' && dimension.score !== null && weight > 0) {
			totalWeight += weight;
			weightedScore += dimension.score * weight;
		}
	}
	return totalWeight > 0 ? roundScore(weightedScore / totalWeight) : 0;
}

function deterministicExplanation(source: Entity, candidate: Entity, core: CoreSimilarityDimensions): string {
	const scoredDimensions = Object.entries(core)
		.filter(([, score]) => score.status === 'scored' && score.score !== null)
		.sort(([, left], [, right]) => (right.score ?? 0) - (left.score ?? 0))
		.slice(0, 2)
		.map(([dimension]) => dimension);
	if (scoredDimensions.length === 0) {
		return `${candidate.name} has too little comparable data for a reliable similarity explanation to ${source.name}.`;
	}
	return `${candidate.name} is similar to ${source.name} on ${scoredDimensions.join(' and ')} dimensions. Missing dimensions are preserved as insufficient data rather than inferred.`;
}

async function persistAutoEdge(pool: pg.Pool, source: Entity, result: SimilarEntityScore): Promise<string> {
	const attributes = {
		generatedBy: 'analyze.similar_case_discovery',
		rankPosition: result.overallRank,
		core: result.core,
		domain: result.domain,
	};
	const analysis = { explanation: result.explanation, sharedEntityIds: result.sharedEntityIds };
	const existing = (await findEdgesBetweenEntities(pool, source.id, result.entityId)).find(
		(edge) => edge.relationship === 'SIMILAR_TO' && edge.edgeType === 'RELATIONSHIP' && edge.storyId === null,
	);
	if (existing) {
		const updated = await updateEdge(pool, existing.id, {
			attributes,
			analysis,
			confidence: result.weightedRankScore,
			sensitivityLevel: result.sensitivityLevel,
			sensitivityMetadata: result.sensitivityMetadata,
		});
		return updated.id;
	}
	const edge = await createEdge(pool, {
		sourceEntityId: source.id,
		targetEntityId: result.entityId,
		relationship: 'SIMILAR_TO',
		edgeType: 'RELATIONSHIP',
		attributes,
		analysis,
		confidence: result.weightedRankScore,
		sensitivityLevel: result.sensitivityLevel,
		sensitivityMetadata: result.sensitivityMetadata,
	});
	return edge.id;
}

async function registerReviewArtifact(
	pool: pg.Pool,
	cacheRecordId: string,
	result: SimilarEntityScore,
	config: MulderConfig,
): Promise<string | null> {
	if (!config.review_workflow.enabled) return null;
	const artifact = await upsertReviewableArtifact(pool, {
		artifactType: 'similar_case_link',
		subjectId: cacheRecordId,
		subjectTable: 'similarity_cache',
		createdBy: 'agent',
		currentValue: {
			entity_id: result.entityId,
			core: result.core,
			domain: result.domain,
			explanation: result.explanation,
		},
		context: {
			shared_entity_ids: result.sharedEntityIds,
			key_differences: result.keyDifferences,
			sensitivity_level: result.sensitivityLevel,
			sensitivity_metadata: result.sensitivityMetadata,
		},
	});
	return artifact.artifactId;
}

export async function discoverSimilarEntities(
	pool: pg.Pool,
	config: MulderConfig,
	options: SimilarEntityDiscoveryOptions,
): Promise<SimilarEntityDiscoveryResult> {
	if (!config.similar_case_discovery.enabled) {
		return {
			entityId: options.entityId,
			candidatesScored: 0,
			persistedCount: 0,
			autoLinkCount: 0,
			results: [],
			cachedResults: [],
		};
	}

	const source = await findEntityById(pool, options.entityId, { maxSensitivityLevel: options.maxSensitivityLevel });
	if (!source) {
		return {
			entityId: options.entityId,
			candidatesScored: 0,
			persistedCount: 0,
			autoLinkCount: 0,
			results: [],
			cachedResults: [],
		};
	}

	const candidates = await resolveCandidates(pool, source, options, config);
	const results: SimilarEntityScore[] = [];
	for (const candidate of candidates) {
		const core = emptyCoreScores();
		if (candidate.semanticScore !== null) core.semantic = scored(candidate.semanticScore);
		core.geospatial = scoreGeospatial(
			source,
			candidate.entity,
			candidate.distanceMeters,
			config.similar_case_discovery.candidate_retrieval.geo_radius_km,
		);
		core.temporal = scoreTemporal(
			source,
			candidate.entity,
			config.similar_case_discovery.candidate_retrieval.temporal_window_years,
		);
		const structural = await scoreStructural(pool, source, candidate.entity);
		core.structural = structural.score;
		const domain = config.similar_case_discovery.scoring.domain_dimensions.map((dimension) =>
			scoreDomainDimension(source, candidate.entity, dimension),
		);
		const sensitivityLevel = mostRestrictiveSensitivityLevel([
			source.sensitivityLevel,
			candidate.entity.sensitivityLevel,
		]);
		const sensitivityMetadata = mergeSensitivityMetadata(
			[source.sensitivityMetadata, candidate.entity.sensitivityMetadata],
			sensitivityLevel,
		);
		const weightedScore = weightedRankScore(core, domain, config);
		results.push({
			entityId: candidate.entity.id,
			entityTitle: candidate.entity.name,
			overallRank: 0,
			core,
			domain,
			explanation: options.explanation ?? deterministicExplanation(source, candidate.entity, core),
			sharedEntityIds: structural.sharedEntityIds,
			keyDifferences: buildKeyDifferences(source, candidate.entity),
			weightedRankScore: weightedScore,
			sensitivityLevel,
			sensitivityMetadata,
			cacheRecord: null,
			graphEdgeId: null,
			reviewArtifactId: null,
		});
	}

	results.sort((left, right) => {
		if (right.weightedRankScore !== left.weightedRankScore) return right.weightedRankScore - left.weightedRankScore;
		return left.entityTitle.localeCompare(right.entityTitle);
	});
	const maxResults = options.maxResults ?? config.similar_case_discovery.max_results;
	const topResults = results.slice(0, maxResults).map((result, index) => ({ ...result, overallRank: index + 1 }));
	const shouldAutoDiscover = options.autoDiscover ?? false;
	const shouldPersistQueryResults = options.persistResults === true;
	let persistedCount = 0;
	let autoLinkCount = 0;

	if (shouldPersistQueryResults) {
		for (const result of topResults) {
			result.cacheRecord = await upsertSimilarityResult(pool, {
				sourceEntityId: source.id,
				targetEntityId: result.entityId,
				core: result.core,
				domain: result.domain,
				explanation: result.explanation,
				sharedEntityIds: result.sharedEntityIds,
				keyDifferences: result.keyDifferences,
				rankPosition: result.overallRank,
				autoDiscovered: shouldAutoDiscover,
				autoDiscoveryMetadata: shouldAutoDiscover ? { weighted_rank_score: result.weightedRankScore } : {},
				sensitivityLevel: result.sensitivityLevel,
				sensitivityMetadata: result.sensitivityMetadata,
			});
			persistedCount++;
		}
	}

	const autoConfig = config.similar_case_discovery.auto_discovery;
	const autoResults =
		shouldAutoDiscover && autoConfig.enabled
			? topResults
					.filter((result) => result.weightedRankScore >= autoConfig.threshold)
					.slice(0, autoConfig.max_auto_links)
			: [];
	if (shouldAutoDiscover && autoConfig.enabled && !shouldPersistQueryResults) {
		for (const result of autoResults) {
			result.cacheRecord = await upsertSimilarityResult(pool, {
				sourceEntityId: source.id,
				targetEntityId: result.entityId,
				core: result.core,
				domain: result.domain,
				explanation: result.explanation,
				sharedEntityIds: result.sharedEntityIds,
				keyDifferences: result.keyDifferences,
				rankPosition: result.overallRank,
				autoDiscovered: true,
				autoDiscoveryMetadata: { weighted_rank_score: result.weightedRankScore },
				sensitivityLevel: result.sensitivityLevel,
				sensitivityMetadata: result.sensitivityMetadata,
			});
			persistedCount++;
		}
	}

	if (shouldAutoDiscover && autoConfig.enabled && autoConfig.create_graph_edge) {
		for (const result of autoResults) {
			result.graphEdgeId = await persistAutoEdge(pool, source, result);
			autoLinkCount++;
			if (result.cacheRecord) {
				result.reviewArtifactId = await registerReviewArtifact(pool, result.cacheRecord.id, result, config);
			}
		}
	}

	const cachedResults =
		shouldPersistQueryResults || autoResults.length > 0
			? await listSimilarEntities(pool, { entityId: source.id, limit: maxResults })
			: [];
	return {
		entityId: source.id,
		candidatesScored: candidates.length,
		persistedCount,
		autoLinkCount,
		results: topResults,
		cachedResults,
	};
}
