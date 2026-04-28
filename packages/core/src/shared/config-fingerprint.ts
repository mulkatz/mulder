/**
 * Stable config fingerprints for step-level reprocess planning.
 *
 * Each step hashes only the config subset that materially affects that
 * step's output, so the reprocess planner can estimate the smallest
 * required rerun slice.
 */

import { createHash } from 'node:crypto';
import type { MulderConfig } from '../config/index.js';

export type ReprocessableStep = 'extract' | 'segment' | 'enrich' | 'embed' | 'graph';

const STEP_ORDER: readonly ReprocessableStep[] = ['extract', 'segment', 'enrich', 'embed', 'graph'] as const;

const FORCED_RERUNS: Record<ReprocessableStep, ReprocessableStep[]> = {
	extract: ['extract', 'segment', 'enrich', 'embed', 'graph'],
	segment: ['segment', 'enrich', 'embed', 'graph'],
	enrich: ['enrich', 'graph'],
	embed: ['embed', 'graph'],
	graph: ['graph'],
};

function sortKeys(value: unknown): unknown {
	if (value === null || value === undefined) {
		return value;
	}
	if (Array.isArray(value)) {
		return value.map(sortKeys);
	}
	if (typeof value === 'object') {
		const entries = Object.entries(value);
		entries.sort(([a], [b]) => a.localeCompare(b));
		const sorted: Record<string, unknown> = {};
		for (const [key, val] of entries) {
			sorted[key] = sortKeys(val);
		}
		return sorted;
	}
	return value;
}

function hashProjection(value: unknown): string {
	return createHash('sha256')
		.update(JSON.stringify(sortKeys(value)))
		.digest('hex');
}

function getConfigProjection(config: MulderConfig, step: ReprocessableStep): unknown {
	switch (step) {
		case 'extract':
			return {
				extraction: config.extraction,
			};
		case 'segment':
			return {
				segmentation: config.extraction.segmentation,
			};
		case 'enrich':
			return {
				enrichment: config.enrichment,
				entity_resolution: config.entity_resolution,
				ontology: config.ontology,
				taxonomy: config.taxonomy,
			};
		case 'embed':
			return {
				embedding: config.embedding,
			};
		case 'graph':
			return {
				deduplication: config.deduplication,
				graph: config.graph,
				thresholds: {
					graph_community_detection: config.thresholds.graph_community_detection,
				},
			};
	}
}

export function getStepConfigHash(config: MulderConfig, step: ReprocessableStep): string {
	return hashProjection(getConfigProjection(config, step));
}

export function getAllStepConfigHashes(config: MulderConfig): Record<ReprocessableStep, string> {
	return {
		extract: getStepConfigHash(config, 'extract'),
		segment: getStepConfigHash(config, 'segment'),
		enrich: getStepConfigHash(config, 'enrich'),
		embed: getStepConfigHash(config, 'embed'),
		graph: getStepConfigHash(config, 'graph'),
	};
}

export function getForcedReprocessSteps(step: ReprocessableStep): ReprocessableStep[] {
	return [...FORCED_RERUNS[step]];
}

export function getReprocessPlanForHashes(args: {
	currentHashes: Record<ReprocessableStep, string>;
	storedHashes: Partial<Record<ReprocessableStep, string | null>>;
}): ReprocessableStep[] {
	const planned = new Set<ReprocessableStep>();

	for (const step of STEP_ORDER) {
		const stored = args.storedHashes[step];
		if (stored !== args.currentHashes[step]) {
			for (const nextStep of FORCED_RERUNS[step]) {
				planned.add(nextStep);
			}
		}
	}

	return STEP_ORDER.filter((step) => planned.has(step));
}
