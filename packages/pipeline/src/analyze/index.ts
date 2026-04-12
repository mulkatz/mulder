/**
 * Analyze pipeline step — currently resolves contradiction edges across the
 * full graph using Gemini structured output.
 *
 * @see docs/specs/61_contradiction_resolution.spec.md
 * @see docs/functional-spec.md §2.8
 */

import { performance } from 'node:perf_hooks';
import type { Entity, EntityEdge, Logger, MulderConfig, Services, Source, StepError, Story } from '@mulder/core';
import {
	ANALYZE_ERROR_CODES,
	AnalyzeError,
	createChildLogger,
	findEdgesByType,
	findEntityById,
	findSourceById,
	findStoryById,
	renderPrompt,
	updateEdge,
	updateSource,
} from '@mulder/core';
import type pg from 'pg';
import { z } from 'zod';
import { z as z3 } from 'zod/v3';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { computeSourceReliability } from './reliability.js';
import type {
	AnalyzeInput,
	AnalyzeResult,
	ContradictionAnalyzeData,
	ContradictionResolutionOutcome,
	ContradictionResolutionResponse,
	ReliabilityAnalyzeData,
	SourceReliabilityOutcome,
} from './types.js';

export type {
	AnalyzeData,
	AnalyzeInput,
	AnalyzeResult,
	ContradictionAnalyzeData,
	ContradictionResolutionOutcome,
	ContradictionResolutionResponse,
	ContradictionVerdict,
	ReliabilityAnalyzeData,
	SourceReliabilityOutcome,
	WinningClaim,
} from './types.js';

const STEP_NAME = 'analyze';

const contradictionResolutionSchema = z.object({
	verdict: z.enum(['confirmed', 'dismissed']),
	winning_claim: z.enum(['A', 'B', 'neither']),
	confidence: z.number().min(0).max(1),
	explanation: z.string().min(1),
});

const contradictionResolutionSchemaV3 = z3.object({
	verdict: z3.enum(['confirmed', 'dismissed']),
	winning_claim: z3.enum(['A', 'B', 'neither']),
	confidence: z3.number().min(0).max(1),
	explanation: z3.string().min(1),
});

const contradictionResolutionJsonSchema: Record<string, unknown> = zodToJsonSchema(contradictionResolutionSchemaV3, {
	$refStrategy: 'none',
});

interface ContradictionAttributes {
	attribute: string;
	valueA: string;
	valueB: string;
	storyIdA: string;
	storyIdB: string;
}

interface HydratedContradictionContext extends ContradictionAttributes {
	edge: EntityEdge;
	entity: Entity;
	storyA: Story;
	storyB: Story;
	sourceA: Source;
	sourceB: Source;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function getStringAttribute(record: Record<string, unknown>, key: string): string {
	const value = record[key];
	if (typeof value !== 'string' || value.trim().length === 0) {
		throw new AnalyzeError(`Contradiction edge is missing "${key}"`, ANALYZE_ERROR_CODES.ANALYZE_CONTEXT_MISSING, {
			context: { key },
		});
	}
	return value.trim();
}

function parseContradictionAttributes(edge: EntityEdge): ContradictionAttributes {
	if (!isRecord(edge.attributes)) {
		throw new AnalyzeError(
			`Contradiction edge ${edge.id} has invalid attribute payload`,
			ANALYZE_ERROR_CODES.ANALYZE_CONTEXT_MISSING,
			{ context: { edgeId: edge.id } },
		);
	}

	return {
		attribute: getStringAttribute(edge.attributes, 'attribute'),
		valueA: getStringAttribute(edge.attributes, 'valueA'),
		valueB: getStringAttribute(edge.attributes, 'valueB'),
		storyIdA: getStringAttribute(edge.attributes, 'storyIdA'),
		storyIdB: getStringAttribute(edge.attributes, 'storyIdB'),
	};
}

function formatPageRange(story: Story): string {
	if (typeof story.pageStart === 'number' && typeof story.pageEnd === 'number') {
		return story.pageStart === story.pageEnd ? String(story.pageStart) : `${story.pageStart}-${story.pageEnd}`;
	}
	if (typeof story.pageStart === 'number') {
		return String(story.pageStart);
	}
	if (typeof story.pageEnd === 'number') {
		return String(story.pageEnd);
	}
	return 'unknown';
}

function resolveLocale(config: MulderConfig): string {
	const locale = config.project.supported_locales[0];
	return typeof locale === 'string' && locale.trim().length > 0 ? locale : 'en';
}

function toStepError(error: AnalyzeError, edgeId: string): StepError {
	return {
		code: error.code,
		message: `${edgeId}: ${error.message}`,
	};
}

async function hydrateContext(pool: pg.Pool, edge: EntityEdge): Promise<HydratedContradictionContext> {
	const attributes = parseContradictionAttributes(edge);

	const entity = await findEntityById(pool, edge.sourceEntityId);
	if (!entity) {
		throw new AnalyzeError(
			`Entity not found for contradiction edge ${edge.id}`,
			ANALYZE_ERROR_CODES.ANALYZE_CONTEXT_MISSING,
			{
				context: { edgeId: edge.id, entityId: edge.sourceEntityId },
			},
		);
	}

	const storyA = await findStoryById(pool, attributes.storyIdA);
	if (!storyA) {
		throw new AnalyzeError(`Story not found: ${attributes.storyIdA}`, ANALYZE_ERROR_CODES.ANALYZE_CONTEXT_MISSING, {
			context: { edgeId: edge.id, storyId: attributes.storyIdA },
		});
	}

	const storyB = await findStoryById(pool, attributes.storyIdB);
	if (!storyB) {
		throw new AnalyzeError(`Story not found: ${attributes.storyIdB}`, ANALYZE_ERROR_CODES.ANALYZE_CONTEXT_MISSING, {
			context: { edgeId: edge.id, storyId: attributes.storyIdB },
		});
	}

	const sourceA = await findSourceById(pool, storyA.sourceId);
	if (!sourceA) {
		throw new AnalyzeError(`Source not found: ${storyA.sourceId}`, ANALYZE_ERROR_CODES.ANALYZE_CONTEXT_MISSING, {
			context: { edgeId: edge.id, sourceId: storyA.sourceId },
		});
	}

	const sourceB = await findSourceById(pool, storyB.sourceId);
	if (!sourceB) {
		throw new AnalyzeError(`Source not found: ${storyB.sourceId}`, ANALYZE_ERROR_CODES.ANALYZE_CONTEXT_MISSING, {
			context: { edgeId: edge.id, sourceId: storyB.sourceId },
		});
	}

	return {
		edge,
		entity,
		storyA,
		storyB,
		sourceA,
		sourceB,
		...attributes,
	};
}

function buildPrompt(context: HydratedContradictionContext, locale: string): string {
	return renderPrompt('resolve-contradiction', {
		locale,
		entity: {
			name: context.entity.name,
			type: context.entity.type,
		},
		contradiction: {
			attribute: context.attribute,
			edge_id: context.edge.id,
		},
		claim_a: {
			value: context.valueA,
			story_title: context.storyA.title,
			source_filename: context.sourceA.filename,
			page_range: formatPageRange(context.storyA),
		},
		claim_b: {
			value: context.valueB,
			story_title: context.storyB.title,
			source_filename: context.sourceB.filename,
			page_range: formatPageRange(context.storyB),
		},
	});
}

async function resolveEdge(
	context: HydratedContradictionContext,
	config: MulderConfig,
	services: Services,
	pool: pg.Pool,
): Promise<ContradictionResolutionOutcome> {
	const locale = resolveLocale(config);
	const prompt = buildPrompt(context, locale);

	let resolution: ContradictionResolutionResponse;
	try {
		resolution = await services.llm.generateStructured<ContradictionResolutionResponse>({
			prompt,
			schema: contradictionResolutionJsonSchema,
			responseValidator: (data) => contradictionResolutionSchema.parse(data),
		});
	} catch (cause: unknown) {
		const code =
			cause instanceof z.ZodError
				? ANALYZE_ERROR_CODES.ANALYZE_VALIDATION_FAILED
				: ANALYZE_ERROR_CODES.ANALYZE_LLM_FAILED;
		throw new AnalyzeError(`Failed to resolve contradiction edge ${context.edge.id}`, code, {
			cause,
			context: { edgeId: context.edge.id },
		});
	}

	const nextEdgeType = resolution.verdict === 'confirmed' ? 'CONFIRMED_CONTRADICTION' : 'DISMISSED_CONTRADICTION';
	try {
		await updateEdge(pool, context.edge.id, {
			edgeType: nextEdgeType,
			confidence: resolution.confidence,
			analysis: {
				verdict: resolution.verdict,
				winning_claim: resolution.winning_claim,
				confidence: resolution.confidence,
				explanation: resolution.explanation,
				attribute: context.attribute,
				valueA: context.valueA,
				valueB: context.valueB,
				storyIdA: context.storyA.id,
				storyIdB: context.storyB.id,
				sourceIdA: context.sourceA.id,
				sourceIdB: context.sourceB.id,
				resolvedAt: new Date().toISOString(),
			},
		});
	} catch (cause: unknown) {
		throw new AnalyzeError(
			`Failed to persist contradiction verdict for edge ${context.edge.id}`,
			ANALYZE_ERROR_CODES.ANALYZE_WRITE_FAILED,
			{
				cause,
				context: { edgeId: context.edge.id },
			},
		);
	}

	return {
		edgeId: context.edge.id,
		entityId: context.entity.id,
		attribute: context.attribute,
		verdict: resolution.verdict,
		winningClaim: resolution.winning_claim,
		confidence: resolution.confidence,
	};
}

function makeContradictionData(
	outcomes: ContradictionResolutionOutcome[],
	failedCount: number,
	pendingCount: number,
): ContradictionAnalyzeData {
	const confirmedCount = outcomes.filter((outcome) => outcome.verdict === 'confirmed').length;
	const dismissedCount = outcomes.filter((outcome) => outcome.verdict === 'dismissed').length;

	return {
		mode: 'contradictions',
		pendingCount,
		processedCount: outcomes.length,
		confirmedCount,
		dismissedCount,
		failedCount,
		outcomes,
	};
}

function makeReliabilityData(
	sourceCount: number,
	threshold: number,
	belowThreshold: boolean,
	outcomes: SourceReliabilityOutcome[],
): ReliabilityAnalyzeData {
	return {
		mode: 'reliability',
		sourceCount,
		scoredCount: outcomes.length,
		threshold,
		belowThreshold,
		outcomes,
	};
}

export async function execute(
	input: AnalyzeInput,
	config: MulderConfig,
	services: Services,
	pool: pg.Pool | undefined,
	logger: Logger,
): Promise<AnalyzeResult> {
	const log = createChildLogger(logger, {
		step: STEP_NAME,
		contradictions: input.contradictions ?? false,
		reliability: input.reliability ?? false,
	});
	const startTime = performance.now();

	if (!pool) {
		throw new AnalyzeError('Database pool is required for analyze step', ANALYZE_ERROR_CODES.ANALYZE_WRITE_FAILED);
	}

	const selectedModes = [
		input.contradictions ? 'contradictions' : null,
		input.reliability ? 'reliability' : null,
	].filter((value): value is 'contradictions' | 'reliability' => value !== null);
	if (selectedModes.length !== 1) {
		throw new AnalyzeError('Exactly one analyze selector must be enabled', ANALYZE_ERROR_CODES.ANALYZE_DISABLED, {
			context: { selectedModes },
		});
	}

	if (input.contradictions) {
		if (!config.analysis.enabled || !config.analysis.contradictions) {
			throw new AnalyzeError(
				'Contradiction analysis is disabled in the active configuration',
				ANALYZE_ERROR_CODES.ANALYZE_DISABLED,
				{
					context: {
						enabled: config.analysis.enabled,
						contradictions: config.analysis.contradictions,
					},
				},
			);
		}

		const pendingEdges = await findEdgesByType(pool, 'POTENTIAL_CONTRADICTION');
		const outcomes: ContradictionResolutionOutcome[] = [];
		const errors: StepError[] = [];

		for (const edge of pendingEdges) {
			try {
				const context = await hydrateContext(pool, edge);
				const outcome = await resolveEdge(context, config, services, pool);
				outcomes.push(outcome);
			} catch (cause: unknown) {
				const analyzeError =
					cause instanceof AnalyzeError
						? cause
						: new AnalyzeError(
								`Unexpected analyze failure for edge ${edge.id}`,
								ANALYZE_ERROR_CODES.ANALYZE_LLM_FAILED,
								{
									cause,
									context: { edgeId: edge.id },
								},
							);
				errors.push(toStepError(analyzeError, edge.id));
				log.warn({ err: cause, edgeId: edge.id }, 'Analyze failed for contradiction edge — continuing');
			}
		}

		const data = makeContradictionData(outcomes, errors.length, pendingEdges.length);
		const status = errors.length === 0 ? 'success' : outcomes.length > 0 ? 'partial' : 'failed';
		const durationMs = Math.round(performance.now() - startTime);

		log.info(
			{
				mode: data.mode,
				pendingCount: data.pendingCount,
				processedCount: data.processedCount,
				confirmedCount: data.confirmedCount,
				dismissedCount: data.dismissedCount,
				failedCount: data.failedCount,
				duration_ms: durationMs,
			},
			'Analyze step completed',
		);

		return {
			status,
			data,
			errors,
			metadata: {
				duration_ms: durationMs,
				items_processed: data.processedCount,
				items_skipped: 0,
				items_cached: 0,
			},
		};
	}

	if (!config.analysis.enabled || !config.analysis.reliability) {
		throw new AnalyzeError(
			'Source reliability analysis is disabled in the active configuration',
			ANALYZE_ERROR_CODES.ANALYZE_DISABLED,
			{
				context: {
					enabled: config.analysis.enabled,
					reliability: config.analysis.reliability,
				},
			},
		);
	}

	const computation = await computeSourceReliability(pool, config.thresholds.source_reliability);
	const persistedOutcomes: SourceReliabilityOutcome[] = [];
	const errors: StepError[] = [];
	const computedSourceIds = new Set(computation.outcomes.map((outcome) => outcome.sourceId));
	const staleSourceIds =
		computation.outcomes.length === 0
			? []
			: (
					await pool.query<{ id: string }>('SELECT id FROM sources WHERE reliability_score IS NOT NULL ORDER BY id')
				).rows
					.map((row) => row.id)
					.filter((sourceId) => !computedSourceIds.has(sourceId));

	for (const outcome of computation.outcomes) {
		try {
			await updateSource(pool, outcome.sourceId, {
				reliabilityScore: outcome.reliabilityScore,
			});
			persistedOutcomes.push(outcome);
		} catch (cause: unknown) {
			const analyzeError =
				cause instanceof AnalyzeError
					? cause
					: new AnalyzeError(
							`Failed to persist source reliability for source ${outcome.sourceId}`,
							ANALYZE_ERROR_CODES.ANALYZE_WRITE_FAILED,
							{
								cause,
								context: { sourceId: outcome.sourceId },
							},
						);
			errors.push({
				code: analyzeError.code,
				message: `${outcome.sourceId}: ${analyzeError.message}`,
			});
			log.warn({ err: cause, sourceId: outcome.sourceId }, 'Analyze failed to persist source reliability — continuing');
		}
	}

	for (const sourceId of staleSourceIds) {
		try {
			await updateSource(pool, sourceId, {
				reliabilityScore: null,
			});
		} catch (cause: unknown) {
			const analyzeError =
				cause instanceof AnalyzeError
					? cause
					: new AnalyzeError(
							`Failed to clear stale source reliability for source ${sourceId}`,
							ANALYZE_ERROR_CODES.ANALYZE_WRITE_FAILED,
							{
								cause,
								context: { sourceId },
							},
						);
			errors.push({
				code: analyzeError.code,
				message: `${sourceId}: ${analyzeError.message}`,
			});
			log.warn({ err: cause, sourceId }, 'Analyze failed to clear stale source reliability — continuing');
		}
	}

	const data = makeReliabilityData(
		computation.sourceCount,
		computation.threshold,
		computation.belowThreshold,
		persistedOutcomes,
	);
	const status = errors.length === 0 ? 'success' : persistedOutcomes.length > 0 ? 'partial' : 'failed';
	const durationMs = Math.round(performance.now() - startTime);

	log.info(
		{
			mode: data.mode,
			sourceCount: data.sourceCount,
			scoredCount: data.scoredCount,
			threshold: data.threshold,
			belowThreshold: data.belowThreshold,
			clearedCount: staleSourceIds.length,
			failedCount: errors.length,
			duration_ms: durationMs,
		},
		'Analyze step completed',
	);

	return {
		status,
		data,
		errors,
		metadata: {
			duration_ms: durationMs,
			items_processed: data.scoredCount,
			items_skipped: 0,
			items_cached: 0,
		},
	};
}
