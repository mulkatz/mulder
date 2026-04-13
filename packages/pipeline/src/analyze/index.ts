/**
 * Analyze pipeline step — resolves contradictions, scores reliability, and
 * computes evidence chains across the full graph.
 *
 * @see docs/specs/61_contradiction_resolution.spec.md
 * @see docs/specs/62_source_reliability_scoring.spec.md
 * @see docs/specs/63_evidence_chains.spec.md
 * @see docs/functional-spec.md §2.8
 */

import { performance } from 'node:perf_hooks';
import type {
	CreateEvidenceChainInput,
	Entity,
	EntityEdge,
	Logger,
	MulderConfig,
	Services,
	Source,
	StepError,
	Story,
} from '@mulder/core';
import {
	ANALYZE_ERROR_CODES,
	AnalyzeError,
	createChildLogger,
	createEvidenceChains,
	deleteEvidenceChainsByThesis,
	findEdgesByType,
	findEntityById,
	findSourceById,
	findStoryById,
	renderPrompt,
	replaceSpatioTemporalClustersSnapshot,
	updateEdge,
	updateSource,
} from '@mulder/core';
import type pg from 'pg';
import { z } from 'zod';
import { z as z3 } from 'zod/v3';
import { zodToJsonSchema } from 'zod-to-json-schema';
import {
	buildEvidenceChainsWarning,
	computeEvidenceChainsForThesis,
	type EvidenceChainThesisComputation,
	loadEvidenceChainsAvailability,
} from './evidence-chains.js';
import { computeSourceReliability } from './reliability.js';
import { computeSpatioTemporalClusters } from './spatio-temporal.js';
import type {
	AnalyzeInput,
	AnalyzePassName,
	AnalyzePassResult,
	AnalyzeResult,
	ContradictionAnalyzeData,
	ContradictionResolutionOutcome,
	ContradictionResolutionResponse,
	EvidenceChainsAnalyzeData,
	EvidenceChainsAvailability,
	EvidenceChainThesisOutcome,
	FullAnalyzeData,
	ReliabilityAnalyzeData,
	SingleAnalyzeData,
	SourceReliabilityOutcome,
	SpatioTemporalAnalyzeData,
} from './types.js';

export type {
	AnalyzeData,
	AnalyzeInput,
	AnalyzePassName,
	AnalyzePassResult,
	AnalyzeResult,
	ContradictionAnalyzeData,
	ContradictionResolutionOutcome,
	ContradictionResolutionResponse,
	ContradictionVerdict,
	EvidenceChainsAnalyzeData,
	EvidenceChainsAvailability,
	EvidenceChainThesisOutcome,
	FullAnalyzeData,
	ReliabilityAnalyzeData,
	SingleAnalyzeData,
	SourceReliabilityOutcome,
	SpatioTemporalAnalyzeData,
	SpatioTemporalCluster,
	SpatioTemporalClusterType,
	SpatioTemporalEvent,
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

function normalizeThesisList(theses?: string[]): string[] {
	if (!Array.isArray(theses)) {
		return [];
	}

	const seen = new Set<string>();
	const normalized: string[] = [];

	for (const thesis of theses) {
		const trimmed = thesis.trim();
		if (trimmed.length === 0 || seen.has(trimmed)) {
			continue;
		}
		seen.add(trimmed);
		normalized.push(trimmed);
	}

	return normalized;
}

function resolveLocale(config: MulderConfig): string {
	const locale = config.project.supported_locales[0];
	return typeof locale === 'string' && locale.trim().length > 0 ? locale : 'en';
}

function toStepError(error: AnalyzeError, subjectId: string): StepError {
	return {
		code: error.code,
		message: `${subjectId}: ${error.message}`,
	};
}

function buildEvidenceChainInputs(
	thesis: string,
	computation: EvidenceChainThesisComputation,
	computedAt: Date,
): CreateEvidenceChainInput[] {
	return [
		...computation.supportingChains.map((chain) => ({
			thesis,
			path: chain.path,
			strength: chain.strength,
			supports: true,
			computedAt,
		})),
		...computation.contradictionChains.map((chain) => ({
			thesis,
			path: chain.path,
			strength: chain.strength,
			supports: false,
			computedAt,
		})),
	];
}

function buildSkippedEvidenceChainOutcomes(theses: string[]): EvidenceChainThesisOutcome[] {
	return theses.map((thesis) => ({
		thesis,
		status: 'skipped',
		seedCount: 0,
		supportingCount: 0,
		contradictionCount: 0,
		writtenCount: 0,
	}));
}

async function replaceEvidenceChainsSnapshot(
	pool: pg.Pool,
	thesis: string,
	rows: CreateEvidenceChainInput[],
): Promise<number> {
	const client = await pool.connect();

	try {
		await client.query('BEGIN');
		await deleteEvidenceChainsByThesis(client, thesis);
		const inserted = rows.length > 0 ? await createEvidenceChains(client, rows) : [];
		await client.query('COMMIT');
		return inserted.length;
	} catch (cause: unknown) {
		try {
			await client.query('ROLLBACK');
		} catch {
			// Ignore rollback failures and rethrow the original issue.
		}

		throw new AnalyzeError(
			`Failed to persist evidence chains for thesis "${thesis}"`,
			ANALYZE_ERROR_CODES.ANALYZE_WRITE_FAILED,
			{
				cause,
				context: { thesis },
			},
		);
	} finally {
		client.release();
	}
}

function makeEvidenceChainsData(
	outcomes: EvidenceChainThesisOutcome[],
	availability: EvidenceChainsAvailability,
): EvidenceChainsAnalyzeData {
	const supportingCount = outcomes.reduce((total, outcome) => total + outcome.supportingCount, 0);
	const contradictionCount = outcomes.reduce((total, outcome) => total + outcome.contradictionCount, 0);
	const successCount = outcomes.filter((outcome) => outcome.status === 'success').length;
	const failedCount = outcomes.filter((outcome) => outcome.status === 'failed').length;
	const skippedCount = outcomes.filter((outcome) => outcome.status === 'skipped').length;

	return {
		mode: 'evidence-chains',
		thesisCount: outcomes.length,
		processedCount: successCount + failedCount,
		successCount,
		skippedCount,
		failedCount,
		supportingCount,
		contradictionCount,
		sourceCount: availability.sourceCount,
		threshold: availability.threshold,
		belowThreshold: availability.belowThreshold,
		warning: availability.warning,
		outcomes,
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

function makeSpatioTemporalData(
	computation: Awaited<ReturnType<typeof computeSpatioTemporalClusters>>,
	persistedCount: number,
): SpatioTemporalAnalyzeData {
	return {
		mode: 'spatio-temporal',
		eventCount: computation.eventCount,
		timestampEventCount: computation.timestampEventCount,
		geometryEventCount: computation.geometryEventCount,
		spatioTemporalEventCount: computation.spatioTemporalEventCount,
		threshold: computation.threshold,
		belowThreshold: computation.belowThreshold,
		nothingToAnalyze: computation.nothingToAnalyze,
		persistedCount,
		temporalClusterCount: computation.temporalClusterCount,
		spatialClusterCount: computation.spatialClusterCount,
		spatioTemporalClusterCount: computation.spatioTemporalClusterCount,
		clusters: computation.clusters,
		warning: computation.warning,
	};
}

const FULL_PASS_ORDER: readonly AnalyzePassName[] = [
	'contradictions',
	'reliability',
	'evidence-chains',
	'spatio-temporal',
] as const;

function getSelectedModes(input: AnalyzeInput): AnalyzePassName[] {
	return [
		input.contradictions ? 'contradictions' : null,
		input.reliability ? 'reliability' : null,
		input.evidenceChains ? 'evidence-chains' : null,
		input.spatioTemporal ? 'spatio-temporal' : null,
	].filter((value): value is AnalyzePassName => value !== null);
}

function summarizeAnalyzeData(data: SingleAnalyzeData): string {
	switch (data.mode) {
		case 'contradictions':
			return data.pendingCount === 0
				? 'no pending contradiction edges'
				: `${data.processedCount} processed, ${data.confirmedCount} confirmed, ${data.dismissedCount} dismissed, ${data.failedCount} failed`;
		case 'reliability':
			return data.outcomes.length === 0
				? 'no graph-connected sources found'
				: `${data.scoredCount} scored, ${data.sourceCount} graph-connected sources`;
		case 'evidence-chains':
			if (data.belowThreshold) {
				return data.skippedCount > 0
					? `${data.skippedCount} theses skipped`
					: (data.warning ?? 'evidence chains not yet available');
			}
			return data.supportingCount === 0 && data.contradictionCount === 0 && data.failedCount === 0
				? 'no evidence chains found'
				: `${data.successCount} successful theses, ${data.failedCount} failed, ${data.supportingCount} supporting, ${data.contradictionCount} contradiction-backed`;
		case 'spatio-temporal':
			if (data.nothingToAnalyze) {
				return 'no clusterable events found';
			}
			if (data.persistedCount === 0 && !data.belowThreshold) {
				return 'no clusters found';
			}
			if (data.belowThreshold) {
				return data.warning ?? `insufficient event density (${data.eventCount}/${data.threshold})`;
			}
			return `${data.persistedCount} clusters persisted (${data.temporalClusterCount} temporal, ${data.spatialClusterCount} spatial, ${data.spatioTemporalClusterCount} spatio-temporal)`;
	}
}

function getPassMetadataTotals(passes: AnalyzePassResult[]): AnalyzeResult['metadata'] {
	return {
		duration_ms: passes.reduce((total, pass) => total + pass.metadata.duration_ms, 0),
		items_processed: passes.reduce((total, pass) => total + pass.metadata.items_processed, 0),
		items_skipped: passes.reduce((total, pass) => total + pass.metadata.items_skipped, 0),
		items_cached: passes.reduce((total, pass) => total + pass.metadata.items_cached, 0),
	};
}

function createSkippedPassResult(pass: AnalyzePassName, summary: string): AnalyzePassResult {
	return {
		pass,
		status: 'skipped',
		summary,
		data: null,
		errors: [],
		metadata: {
			duration_ms: 0,
			items_processed: 0,
			items_skipped: 1,
			items_cached: 0,
		},
	};
}

function createFailedPassResult(pass: AnalyzePassName, error: AnalyzeError): AnalyzePassResult {
	return {
		pass,
		status: 'failed',
		summary: error.message,
		data: null,
		errors: [toStepError(error, pass)],
		metadata: {
			duration_ms: 0,
			items_processed: 0,
			items_skipped: 0,
			items_cached: 0,
		},
	};
}

function toAnalyzePassResult(pass: AnalyzePassName, result: AnalyzeResult): AnalyzePassResult {
	if (result.data.mode === 'full') {
		throw new AnalyzeError(
			'Full analyze results cannot be nested inside full analyze pass results',
			ANALYZE_ERROR_CODES.ANALYZE_VALIDATION_FAILED,
			{
				context: { pass },
			},
		);
	}

	return {
		pass,
		status: result.status,
		summary: summarizeAnalyzeData(result.data),
		data: result.data,
		errors: result.errors,
		metadata: result.metadata,
	};
}

function makeFullAnalyzeData(passes: AnalyzePassResult[]): FullAnalyzeData {
	const attemptedPasses = passes.filter((pass) => pass.status !== 'skipped');
	const successCount = passes.filter((pass) => pass.status === 'success').length;
	const partialCount = passes.filter((pass) => pass.status === 'partial').length;
	const failedCount = passes.filter((pass) => pass.status === 'failed').length;
	const skippedCount = passes.filter((pass) => pass.status === 'skipped').length;

	return {
		mode: 'full',
		passCount: passes.length,
		attemptedCount: attemptedPasses.length,
		successCount,
		partialCount,
		failedCount,
		skippedCount,
		passes,
	};
}

function getFullAnalyzeStatus(data: FullAnalyzeData): AnalyzeResult['status'] {
	if (data.attemptedCount === 0) {
		return 'success';
	}
	if (data.failedCount === data.attemptedCount) {
		return 'failed';
	}
	if (data.failedCount > 0 || data.partialCount > 0) {
		return 'partial';
	}
	return 'success';
}

async function executeContradictionsPass(
	config: MulderConfig,
	services: Services,
	pool: pg.Pool,
	log: Logger,
): Promise<AnalyzeResult> {
	const startTime = performance.now();

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
					: new AnalyzeError(`Unexpected analyze failure for edge ${edge.id}`, ANALYZE_ERROR_CODES.ANALYZE_LLM_FAILED, {
							cause,
							context: { edgeId: edge.id },
						});
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

async function executeEvidenceChainsPass(
	config: MulderConfig,
	pool: pg.Pool,
	log: Logger,
	thesisOverrides: string[],
): Promise<AnalyzeResult> {
	const startTime = performance.now();

	if (!config.analysis.enabled || !config.analysis.evidence_chains) {
		throw new AnalyzeError(
			'Evidence chain analysis is disabled in the active configuration',
			ANALYZE_ERROR_CODES.ANALYZE_DISABLED,
			{
				context: {
					enabled: config.analysis.enabled,
					evidenceChains: config.analysis.evidence_chains,
				},
			},
		);
	}

	const thesisInputs =
		thesisOverrides.length > 0 ? thesisOverrides : normalizeThesisList(config.analysis.evidence_theses);
	if (thesisInputs.length === 0) {
		throw new AnalyzeError(
			'At least one thesis query is required for evidence-chain analysis',
			ANALYZE_ERROR_CODES.ANALYZE_THESIS_INPUT_MISSING,
		);
	}

	const availability = await loadEvidenceChainsAvailability(pool, config.thresholds.corroboration_meaningful);

	if (availability.belowThreshold) {
		log.warn(
			{
				sourceCount: availability.sourceCount,
				threshold: availability.threshold,
				belowThreshold: availability.belowThreshold,
			},
			'Evidence chains not yet available — corpus below meaningful threshold',
		);
	}

	const outcomes: EvidenceChainThesisOutcome[] = availability.belowThreshold
		? buildSkippedEvidenceChainOutcomes(thesisInputs)
		: [];
	const errors: StepError[] = [];

	for (const thesis of thesisInputs) {
		if (availability.belowThreshold) {
			continue;
		}

		try {
			const computation = await computeEvidenceChainsForThesis(pool, config, thesis);
			const computedAt = new Date();
			const snapshotRows = buildEvidenceChainInputs(computation.thesis, computation, computedAt);
			const writtenCount = await replaceEvidenceChainsSnapshot(pool, computation.thesis, snapshotRows);

			outcomes.push({
				thesis: computation.thesis,
				status: 'success',
				seedCount: computation.seedIds.length,
				supportingCount: computation.supportingChains.length,
				contradictionCount: computation.contradictionChains.length,
				writtenCount,
			});
		} catch (cause: unknown) {
			const analyzeError =
				cause instanceof AnalyzeError
					? cause
					: new AnalyzeError(
							`Unexpected analyze failure for thesis "${thesis}"`,
							ANALYZE_ERROR_CODES.ANALYZE_TRAVERSAL_FAILED,
							{
								cause,
								context: { thesis },
							},
						);
			errors.push(toStepError(analyzeError, thesis));
			outcomes.push({
				thesis,
				status: 'failed',
				seedCount: 0,
				supportingCount: 0,
				contradictionCount: 0,
				writtenCount: 0,
			});
			log.warn({ err: cause, thesis }, 'Analyze failed for evidence-chain thesis — continuing');
		}
	}

	const data = makeEvidenceChainsData(outcomes, availability);
	const status =
		errors.length === 0 ? 'success' : outcomes.some((outcome) => outcome.status === 'success') ? 'partial' : 'failed';
	const durationMs = Math.round(performance.now() - startTime);

	log.info(
		{
			mode: data.mode,
			thesisCount: data.thesisCount,
			processedCount: data.processedCount,
			successCount: data.successCount,
			failedCount: data.failedCount,
			supportingCount: data.supportingCount,
			contradictionCount: data.contradictionCount,
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
			items_skipped: data.skippedCount + data.failedCount,
			items_cached: 0,
		},
	};
}

async function executeSpatioTemporalPass(config: MulderConfig, pool: pg.Pool, log: Logger): Promise<AnalyzeResult> {
	const startTime = performance.now();

	if (!config.analysis.enabled || !config.analysis.spatio_temporal) {
		throw new AnalyzeError(
			'Spatio-temporal analysis is disabled in the active configuration',
			ANALYZE_ERROR_CODES.ANALYZE_DISABLED,
			{
				context: {
					enabled: config.analysis.enabled,
					spatioTemporal: config.analysis.spatio_temporal,
				},
			},
		);
	}

	const computation = await computeSpatioTemporalClusters(
		pool,
		config.analysis.cluster_window_days,
		config.thresholds.temporal_clustering,
	);

	const persistedCount = computation.nothingToAnalyze
		? 0
		: (await replaceSpatioTemporalClustersSnapshot(pool, computation.snapshotRows)).length;

	const data = makeSpatioTemporalData(computation, persistedCount);
	const durationMs = Math.round(performance.now() - startTime);

	log.info(
		{
			mode: data.mode,
			eventCount: data.eventCount,
			timestampEventCount: data.timestampEventCount,
			geometryEventCount: data.geometryEventCount,
			spatioTemporalEventCount: data.spatioTemporalEventCount,
			persistedCount: data.persistedCount,
			temporalClusterCount: data.temporalClusterCount,
			spatialClusterCount: data.spatialClusterCount,
			spatioTemporalClusterCount: data.spatioTemporalClusterCount,
			belowThreshold: data.belowThreshold,
			nothingToAnalyze: data.nothingToAnalyze,
			duration_ms: durationMs,
		},
		'Analyze step completed',
	);

	return {
		status: 'success',
		data,
		errors: [],
		metadata: {
			duration_ms: durationMs,
			items_processed: data.persistedCount,
			items_skipped: data.belowThreshold ? data.eventCount : 0,
			items_cached: 0,
		},
	};
}

async function executeReliabilityPass(config: MulderConfig, pool: pg.Pool, log: Logger): Promise<AnalyzeResult> {
	const startTime = performance.now();

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

async function executeSinglePass(
	pass: AnalyzePassName,
	config: MulderConfig,
	services: Services,
	pool: pg.Pool,
	logger: Logger,
	thesisOverrides: string[],
): Promise<AnalyzeResult> {
	const passLog = createChildLogger(logger, {
		step: STEP_NAME,
		pass,
	});

	switch (pass) {
		case 'contradictions':
			return executeContradictionsPass(config, services, pool, passLog);
		case 'reliability':
			return executeReliabilityPass(config, pool, passLog);
		case 'evidence-chains':
			return executeEvidenceChainsPass(config, pool, passLog, thesisOverrides);
		case 'spatio-temporal':
			return executeSpatioTemporalPass(config, pool, passLog);
	}
}

async function executeFullAnalyze(
	config: MulderConfig,
	services: Services,
	pool: pg.Pool,
	logger: Logger,
	thesisOverrides: string[],
): Promise<AnalyzeResult> {
	const log = createChildLogger(logger, {
		step: STEP_NAME,
		full: true,
	});
	const startTime = performance.now();

	if (!config.analysis.enabled) {
		throw new AnalyzeError('Analyze is disabled in the active configuration', ANALYZE_ERROR_CODES.ANALYZE_DISABLED, {
			context: { enabled: config.analysis.enabled },
		});
	}

	const passes: AnalyzePassResult[] = [];

	for (const pass of FULL_PASS_ORDER) {
		if (pass === 'contradictions' && !config.analysis.contradictions) {
			passes.push(createSkippedPassResult(pass, 'disabled by config'));
			continue;
		}
		if (pass === 'reliability' && !config.analysis.reliability) {
			passes.push(createSkippedPassResult(pass, 'disabled by config'));
			continue;
		}
		if (pass === 'evidence-chains') {
			if (!config.analysis.evidence_chains) {
				passes.push(createSkippedPassResult(pass, 'disabled by config'));
				continue;
			}
			const thesisInputs =
				thesisOverrides.length > 0 ? thesisOverrides : normalizeThesisList(config.analysis.evidence_theses);
			if (thesisInputs.length === 0) {
				passes.push(createSkippedPassResult(pass, 'no thesis input configured'));
				continue;
			}
			const availability = await loadEvidenceChainsAvailability(pool, config.thresholds.corroboration_meaningful);
			if (availability.belowThreshold) {
				passes.push(
					createSkippedPassResult(
						pass,
						availability.warning ?? buildEvidenceChainsWarning(availability.sourceCount, availability.threshold),
					),
				);
				continue;
			}
		}
		if (pass === 'spatio-temporal' && !config.analysis.spatio_temporal) {
			passes.push(createSkippedPassResult(pass, 'disabled by config'));
			continue;
		}

		try {
			const passResult = await executeSinglePass(pass, config, services, pool, log, thesisOverrides);
			passes.push(toAnalyzePassResult(pass, passResult));
		} catch (cause: unknown) {
			const analyzeError =
				cause instanceof AnalyzeError
					? cause
					: new AnalyzeError(
							`Unexpected full analyze failure in ${pass}`,
							ANALYZE_ERROR_CODES.ANALYZE_VALIDATION_FAILED,
							{
								cause,
								context: { pass },
							},
						);
			log.warn({ err: cause, pass }, 'Analyze full mode pass failed');
			passes.push(createFailedPassResult(pass, analyzeError));
		}
	}

	const data = makeFullAnalyzeData(passes);
	const status = getFullAnalyzeStatus(data);
	const durationMs = Math.round(performance.now() - startTime);
	const metadataTotals = getPassMetadataTotals(passes);
	const errors = passes.flatMap((pass) => pass.errors);

	log.info(
		{
			mode: data.mode,
			passCount: data.passCount,
			attemptedCount: data.attemptedCount,
			successCount: data.successCount,
			partialCount: data.partialCount,
			failedCount: data.failedCount,
			skippedCount: data.skippedCount,
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
			items_processed: metadataTotals.items_processed,
			items_skipped: metadataTotals.items_skipped,
			items_cached: metadataTotals.items_cached,
		},
	};
}

export async function execute(
	input: AnalyzeInput,
	config: MulderConfig,
	services: Services,
	pool: pg.Pool | undefined,
	logger: Logger,
): Promise<AnalyzeResult> {
	if (!pool) {
		throw new AnalyzeError('Database pool is required for analyze step', ANALYZE_ERROR_CODES.ANALYZE_WRITE_FAILED);
	}

	const hasRawThesisOverrides = Array.isArray(input.theses) && input.theses.length > 0;
	const thesisOverrides = normalizeThesisList(input.theses);
	if (hasRawThesisOverrides && thesisOverrides.length === 0) {
		throw new AnalyzeError(
			'At least one non-empty thesis override is required',
			ANALYZE_ERROR_CODES.ANALYZE_THESIS_INPUT_MISSING,
			{
				context: { thesisCount: input.theses?.length ?? 0 },
			},
		);
	}

	if (hasRawThesisOverrides && !input.evidenceChains && !input.full) {
		throw new AnalyzeError(
			'The --thesis override can only be used with evidence-chain analysis',
			ANALYZE_ERROR_CODES.ANALYZE_VALIDATION_FAILED,
			{
				context: { thesisCount: thesisOverrides.length },
			},
		);
	}

	const selectedModes = getSelectedModes(input);

	if (input.full) {
		if (selectedModes.length > 0) {
			throw new AnalyzeError(
				'Full analyze mode cannot be combined with explicit single-pass selectors',
				ANALYZE_ERROR_CODES.ANALYZE_VALIDATION_FAILED,
				{
					context: { selectedModes },
				},
			);
		}

		return executeFullAnalyze(config, services, pool, logger, thesisOverrides);
	}

	if (selectedModes.length !== 1) {
		throw new AnalyzeError('Exactly one analyze selector must be enabled', ANALYZE_ERROR_CODES.ANALYZE_DISABLED, {
			context: { selectedModes },
		});
	}

	return executeSinglePass(selectedModes[0], config, services, pool, logger, thesisOverrides);
}
