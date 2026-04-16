/**
 * Deterministic config-hash helpers for selective reprocessing.
 *
 * Each tracked pipeline step hashes only the config subset that can change
 * that step's output. Hashes are SHA-256 over canonical JSON with sorted keys.
 */

import { createHash } from 'node:crypto';
import type { MulderConfig } from './types.js';

export type ReprocessHashStepName = 'extract' | 'segment' | 'enrich' | 'embed' | 'graph' | 'ground' | 'analyze';

type ReprocessHashSubset =
	| { extraction: MulderConfig['extraction'] }
	| { extraction: { segmentation: MulderConfig['extraction']['segmentation'] } }
	| {
			ontology: MulderConfig['ontology'];
			enrichment: MulderConfig['enrichment'];
			taxonomy: MulderConfig['taxonomy'];
			entity_resolution: MulderConfig['entity_resolution'];
	  }
	| { embedding: MulderConfig['embedding'] }
	| {
			deduplication: MulderConfig['deduplication'];
			graph: MulderConfig['graph'];
			thresholds: {
				graph_community_detection: MulderConfig['thresholds']['graph_community_detection'];
			};
	  }
	| { grounding: MulderConfig['grounding'] }
	| {
			analysis: MulderConfig['analysis'];
			thresholds: {
				corroboration_meaningful: MulderConfig['thresholds']['corroboration_meaningful'];
				temporal_clustering: MulderConfig['thresholds']['temporal_clustering'];
				source_reliability: MulderConfig['thresholds']['source_reliability'];
			};
	  };

function sortKeys(value: unknown): unknown {
	if (value === null || value === undefined) {
		return value;
	}
	if (Array.isArray(value)) {
		return value.map(sortKeys);
	}
	if (typeof value === 'object') {
		const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
		const sorted: Record<string, unknown> = {};
		for (const [key, entryValue] of entries) {
			sorted[key] = sortKeys(entryValue);
		}
		return sorted;
	}
	return value;
}

/**
 * Returns the exact config subset that contributes to a step's hash.
 */
export function getReprocessConfigSubset(config: MulderConfig, step: ReprocessHashStepName): ReprocessHashSubset {
	switch (step) {
		case 'extract':
			return { extraction: config.extraction };
		case 'segment':
			return { extraction: { segmentation: config.extraction.segmentation } };
		case 'enrich':
			return {
				ontology: config.ontology,
				enrichment: config.enrichment,
				taxonomy: config.taxonomy,
				entity_resolution: config.entity_resolution,
			};
		case 'embed':
			return { embedding: config.embedding };
		case 'graph':
			return {
				deduplication: config.deduplication,
				graph: config.graph,
				thresholds: {
					graph_community_detection: config.thresholds.graph_community_detection,
				},
			};
		case 'ground':
			return { grounding: config.grounding };
		case 'analyze':
			return {
				analysis: config.analysis,
				thresholds: {
					corroboration_meaningful: config.thresholds.corroboration_meaningful,
					temporal_clustering: config.thresholds.temporal_clustering,
					source_reliability: config.thresholds.source_reliability,
				},
			};
	}
}

/**
 * Computes a deterministic SHA-256 hash for the relevant config subset.
 */
export function computeReprocessConfigHash(config: MulderConfig, step: ReprocessHashStepName): string {
	const subset = getReprocessConfigSubset(config, step);
	return createHash('sha256')
		.update(JSON.stringify(sortKeys(subset)))
		.digest('hex');
}
