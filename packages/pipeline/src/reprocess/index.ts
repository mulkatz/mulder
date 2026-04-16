/**
 * Reprocess planning utilities for config-hash based selective reruns.
 *
 * This module intentionally stops at planning. Execution is reserved for
 * the later reprocess delivery step.
 */

import type { MulderConfig, ReprocessableStep, Source, SourceStep } from '@mulder/core';
import { getAllStepConfigHashes, getForcedReprocessSteps, getReprocessPlanForHashes } from '@mulder/core';

export interface PlannedReprocessSource {
	source: Source;
	steps: ReprocessableStep[];
}

export interface ReprocessPlan {
	currentHashes: Record<ReprocessableStep, string>;
	sources: PlannedReprocessSource[];
}

function mapStoredHashes(sourceSteps: SourceStep[]): Partial<Record<ReprocessableStep, string | null>> {
	const stored: Partial<Record<ReprocessableStep, string | null>> = {};

	for (const step of sourceSteps) {
		if (
			step.stepName === 'extract' ||
			step.stepName === 'segment' ||
			step.stepName === 'enrich' ||
			step.stepName === 'embed' ||
			step.stepName === 'graph'
		) {
			stored[step.stepName] = step.configHash;
		}
	}

	return stored;
}

export function buildReprocessPlan(args: {
	config: MulderConfig;
	sources: Source[];
	sourceStepsBySourceId: Map<string, SourceStep[]>;
	forcedStep?: ReprocessableStep;
}): ReprocessPlan {
	const currentHashes = getAllStepConfigHashes(args.config);
	const sources: PlannedReprocessSource[] = [];

	for (const source of args.sources) {
		const steps = args.forcedStep
			? getForcedReprocessSteps(args.forcedStep)
			: getReprocessPlanForHashes({
					currentHashes,
					storedHashes: mapStoredHashes(args.sourceStepsBySourceId.get(source.id) ?? []),
				});

		if (steps.length > 0) {
			sources.push({ source, steps });
		}
	}

	return {
		currentHashes,
		sources,
	};
}
