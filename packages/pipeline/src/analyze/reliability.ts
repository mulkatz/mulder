/**
 * Source reliability scoring for the Analyze step.
 *
 * Builds a source-to-source graph from shared entities across sources and
 * computes a weighted PageRank-style score that is later normalized to 0..1.
 *
 * @see docs/specs/62_source_reliability_scoring.spec.md §4.1
 * @see docs/functional-spec.md §2.8, §5.3
 */

import { findAllSources } from '@mulder/core';
import type pg from 'pg';
import type { SourceReliabilityOutcome } from './types.js';

const DAMPING_FACTOR = 0.85;
const EPSILON = 1e-8;
const MAX_ITERATIONS = 100;
const SCORE_PRECISION = 6;

interface SourceEdgeRow {
	source_id_a: string;
	source_id_b: string;
	shared_entities: string;
}

export interface ReliabilityComputation {
	sourceCount: number;
	threshold: number;
	belowThreshold: boolean;
	outcomes: SourceReliabilityOutcome[];
}

function roundScore(value: number): number {
	return Number(value.toFixed(SCORE_PRECISION));
}

function buildAdjacency(edges: SourceEdgeRow[]): Map<string, Map<string, number>> {
	const adjacency = new Map<string, Map<string, number>>();

	for (const edge of edges) {
		const weight = Number.parseInt(edge.shared_entities, 10);
		if (!Number.isFinite(weight) || weight <= 0) {
			continue;
		}

		const neighborsA = adjacency.get(edge.source_id_a) ?? new Map<string, number>();
		neighborsA.set(edge.source_id_b, weight);
		adjacency.set(edge.source_id_a, neighborsA);

		const neighborsB = adjacency.get(edge.source_id_b) ?? new Map<string, number>();
		neighborsB.set(edge.source_id_a, weight);
		adjacency.set(edge.source_id_b, neighborsB);
	}

	return adjacency;
}

function runPageRank(nodeIds: string[], adjacency: Map<string, Map<string, number>>): Map<string, number> {
	const nodeCount = nodeIds.length;
	const initialScore = 1 / nodeCount;
	let scores = new Map(nodeIds.map((nodeId) => [nodeId, initialScore]));

	for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
		const nextScores = new Map<string, number>();
		let totalDelta = 0;

		for (const nodeId of nodeIds) {
			let incomingContribution = 0;

			for (const otherNodeId of nodeIds) {
				if (otherNodeId === nodeId) {
					continue;
				}

				const outgoing = adjacency.get(otherNodeId);
				const weightToNode = outgoing?.get(nodeId);
				if (!outgoing || weightToNode === undefined) {
					continue;
				}

				let totalOutgoingWeight = 0;
				for (const weight of outgoing.values()) {
					totalOutgoingWeight += weight;
				}

				if (totalOutgoingWeight > 0) {
					incomingContribution += (scores.get(otherNodeId) ?? 0) * (weightToNode / totalOutgoingWeight);
				}
			}

			const nextScore = (1 - DAMPING_FACTOR) / nodeCount + DAMPING_FACTOR * incomingContribution;
			nextScores.set(nodeId, nextScore);
			totalDelta += Math.abs(nextScore - (scores.get(nodeId) ?? 0));
		}

		scores = nextScores;
		if (totalDelta < EPSILON) {
			break;
		}
	}

	return scores;
}

export async function computeSourceReliability(pool: pg.Pool, threshold: number): Promise<ReliabilityComputation> {
	const result = await pool.query<SourceEdgeRow>(
		`SELECT
		   LEAST(st1.source_id, st2.source_id) AS source_id_a,
		   GREATEST(st1.source_id, st2.source_id) AS source_id_b,
		   COUNT(DISTINCT se1.entity_id)::text AS shared_entities
		 FROM story_entities se1
		 JOIN stories st1 ON st1.id = se1.story_id
		 JOIN story_entities se2
		   ON se2.entity_id = se1.entity_id
		  AND se2.story_id <> se1.story_id
		 JOIN stories st2 ON st2.id = se2.story_id
		 WHERE st1.source_id <> st2.source_id
		 GROUP BY 1, 2
		 ORDER BY 1, 2`,
	);

	const adjacency = buildAdjacency(result.rows);
	const nodeIds = Array.from(adjacency.keys()).sort();

	if (nodeIds.length === 0) {
		return {
			sourceCount: 0,
			threshold,
			belowThreshold: true,
			outcomes: [],
		};
	}

	const allSources = await findAllSources(pool, { limit: 100000 });
	const sourceById = new Map(allSources.map((source) => [source.id, source]));

	const rawScores = runPageRank(nodeIds, adjacency);
	const maxRawScore = Math.max(...Array.from(rawScores.values()));

	const outcomes = nodeIds
		.map((sourceId) => {
			const neighbors = adjacency.get(sourceId) ?? new Map<string, number>();
			let sharedEntityCount = 0;
			for (const weight of neighbors.values()) {
				sharedEntityCount += weight;
			}

			const rawScore = rawScores.get(sourceId) ?? 0;
			const reliabilityScore = maxRawScore > 0 ? rawScore / maxRawScore : 0;
			const source = sourceById.get(sourceId);

			return {
				sourceId,
				filename: source?.filename ?? sourceId,
				rawScore: roundScore(rawScore),
				reliabilityScore: roundScore(reliabilityScore),
				neighborCount: neighbors.size,
				sharedEntityCount,
			};
		})
		.sort((left, right) => {
			if (right.reliabilityScore !== left.reliabilityScore) {
				return right.reliabilityScore - left.reliabilityScore;
			}
			return left.filename.localeCompare(right.filename);
		});

	return {
		sourceCount: nodeIds.length,
		threshold,
		belowThreshold: nodeIds.length < threshold,
		outcomes,
	};
}
