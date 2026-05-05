/**
 * Source-type aware pipeline step planning.
 *
 * Layout sources keep the full v1.0 path. Pre-structured sources produce
 * story Markdown during extract, so segment remains in the requested range
 * for observability but is omitted from executable work.
 *
 * @see docs/specs/86_pipeline_step_skipping_prestructured_sources.spec.md
 * @see docs/functional-spec.md §3.1, §3.2
 */

import type { PipelineStep } from '../database/repositories/pipeline-reset.js';
import type { SourceType } from '../database/repositories/source.types.js';
import { PIPELINE_ERROR_CODES, PipelineError } from './errors.js';

export type PipelinePlanStep = 'ingest' | PipelineStep;

export const PIPELINE_STEP_ORDER: readonly PipelinePlanStep[] = [
	'ingest',
	'quality',
	'extract',
	'segment',
	'enrich',
	'embed',
	'graph',
] as const;

export const LAYOUT_SOURCE_TYPES: readonly SourceType[] = ['pdf', 'image'] as const;

export const PRESTRUCTURED_SOURCE_TYPES: readonly SourceType[] = [
	'text',
	'docx',
	'spreadsheet',
	'email',
	'url',
] as const;

export interface StepPlanInput {
	sourceType: SourceType;
	from?: PipelinePlanStep;
	upTo?: PipelinePlanStep;
}

export interface StepPlan {
	requestedSteps: PipelinePlanStep[];
	executableSteps: PipelinePlanStep[];
	skippedSteps: PipelinePlanStep[];
}

function isKnownStep(value: string | undefined): value is PipelinePlanStep {
	return value !== undefined && PIPELINE_STEP_ORDER.some((step) => step === value);
}

function stepIndex(step: PipelinePlanStep): number {
	return PIPELINE_STEP_ORDER.indexOf(step);
}

export function isLayoutSourceType(sourceType: SourceType): boolean {
	return LAYOUT_SOURCE_TYPES.some((candidate) => candidate === sourceType);
}

export function isPrestructuredSourceType(sourceType: SourceType): boolean {
	return PRESTRUCTURED_SOURCE_TYPES.some((candidate) => candidate === sourceType);
}

export function computeRequestedSteps(input: Omit<StepPlanInput, 'sourceType'>): PipelinePlanStep[] {
	if (input.from !== undefined && !isKnownStep(input.from)) {
		throw new PipelineError(`Unknown step in --from: ${input.from}`, PIPELINE_ERROR_CODES.PIPELINE_WRONG_STATUS, {
			context: { from: input.from, validSteps: [...PIPELINE_STEP_ORDER] },
		});
	}
	if (input.upTo !== undefined && !isKnownStep(input.upTo)) {
		throw new PipelineError(`Unknown step in --up-to: ${input.upTo}`, PIPELINE_ERROR_CODES.PIPELINE_WRONG_STATUS, {
			context: { upTo: input.upTo, validSteps: [...PIPELINE_STEP_ORDER] },
		});
	}

	const fromIdx = input.from ? stepIndex(input.from) : 0;
	const upToIdx = input.upTo ? stepIndex(input.upTo) : PIPELINE_STEP_ORDER.length - 1;

	if (fromIdx > upToIdx) {
		throw new PipelineError(
			`--from ${input.from} comes after --up-to ${input.upTo} in step order`,
			PIPELINE_ERROR_CODES.PIPELINE_WRONG_STATUS,
			{ context: { from: input.from, upTo: input.upTo } },
		);
	}

	return PIPELINE_STEP_ORDER.slice(fromIdx, upToIdx + 1);
}

export function planPipelineSteps(input: StepPlanInput): StepPlan {
	const requestedSteps = computeRequestedSteps({ from: input.from, upTo: input.upTo });
	const skippedSteps: PipelinePlanStep[] = isPrestructuredSourceType(input.sourceType)
		? requestedSteps.filter((step) => step === 'segment')
		: [];
	const executableSteps = requestedSteps.filter((step) => !skippedSteps.includes(step));

	if (executableSteps.length === 0) {
		throw new PipelineError(
			`Requested pipeline range contains only skipped steps for source type "${input.sourceType}": ${skippedSteps.join(', ')}`,
			PIPELINE_ERROR_CODES.PIPELINE_INVALID_STEP_RANGE,
			{
				context: {
					sourceType: input.sourceType,
					requestedSteps,
					skippedSteps,
				},
			},
		);
	}

	return {
		requestedSteps,
		executableSteps,
		skippedSteps,
	};
}
