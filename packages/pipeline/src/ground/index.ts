/**
 * Ground pipeline step — web-enriches entities with Gemini grounding and
 * persists TTL-aware cache records.
 *
 * @see docs/specs/60_ground_step.spec.md
 * @see docs/functional-spec.md §2.5
 */

import { performance } from 'node:perf_hooks';
import type {
	Entity,
	GroundedGenerateResult,
	GroundingCoordinates,
	Logger,
	MulderConfig,
	Services,
	StepError,
} from '@mulder/core';
import {
	createChildLogger,
	findEntityById,
	findEntityGroundingByEntityId,
	GROUND_ERROR_CODES,
	GroundError,
	persistEntityGroundingResult,
	renderPrompt,
} from '@mulder/core';
import type pg from 'pg';
import { z } from 'zod';
import type { GroundInput, GroundingData, GroundResult } from './types.js';

export type { GroundInput, GroundingData, GroundOutcome, GroundResult } from './types.js';

const STEP_NAME = 'ground';

const groundedPayloadSchema = z.object({
	summary: z.string().min(1).nullable().optional(),
	confidence: z.number().min(0).max(1).nullable().optional(),
	coordinates: z
		.object({
			lat: z.number().min(-90).max(90),
			lng: z.number().min(-180).max(180),
		})
		.nullable()
		.optional(),
	attributes: z.record(z.string(), z.unknown()).default({}),
});

type GroundedPayload = z.infer<typeof groundedPayloadSchema>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function collectSourceUrls(value: unknown, acc: Set<string>): void {
	if (typeof value === 'string') {
		if (value.startsWith('http://') || value.startsWith('https://')) {
			acc.add(value);
		}
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) {
			collectSourceUrls(item, acc);
		}
		return;
	}
	if (!isRecord(value)) {
		return;
	}
	for (const nestedValue of Object.values(value)) {
		collectSourceUrls(nestedValue, acc);
	}
}

function extractSupportConfidence(metadata: Record<string, unknown>): number | null {
	const supports = metadata.groundingSupports;
	if (!Array.isArray(supports)) {
		return null;
	}

	let maxConfidence: number | null = null;
	for (const support of supports) {
		if (!isRecord(support)) continue;
		const scores = support.confidenceScores;
		if (!Array.isArray(scores)) continue;
		for (const score of scores) {
			if (typeof score !== 'number' || Number.isNaN(score)) continue;
			maxConfidence = maxConfidence === null ? score : Math.max(maxConfidence, score);
		}
	}

	return maxConfidence;
}

function parseGroundedPayload(rawText: string): GroundedPayload {
	const trimmed = rawText.trim();
	if (trimmed.length === 0) {
		throw new GroundError('Grounding response was empty', GROUND_ERROR_CODES.GROUND_VALIDATION_FAILED);
	}

	let jsonText = trimmed;
	const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
	if (fencedMatch) {
		jsonText = fencedMatch[1].trim();
	} else {
		const firstBrace = trimmed.indexOf('{');
		const lastBrace = trimmed.lastIndexOf('}');
		if (firstBrace !== -1 && lastBrace > firstBrace) {
			jsonText = trimmed.slice(firstBrace, lastBrace + 1);
		}
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonText);
	} catch (cause: unknown) {
		throw new GroundError('Grounding response was not valid JSON', GROUND_ERROR_CODES.GROUND_VALIDATION_FAILED, {
			cause,
		});
	}

	try {
		return groundedPayloadSchema.parse(parsed);
	} catch (cause: unknown) {
		throw new GroundError(
			'Grounding response did not match the expected schema',
			GROUND_ERROR_CODES.GROUND_VALIDATION_FAILED,
			{ cause },
		);
	}
}

function buildMergedAttributes(entity: Entity, payload: GroundedPayload): Record<string, unknown> {
	const mergedAttributes: Record<string, unknown> = {
		...entity.attributes,
		...payload.attributes,
	};

	if (payload.summary) {
		mergedAttributes.grounding_summary = payload.summary;
	}
	if (typeof payload.confidence === 'number') {
		mergedAttributes.grounding_confidence = payload.confidence;
	}
	if (payload.coordinates) {
		mergedAttributes.geo_point = payload.coordinates;
	}

	const verifiedDate = payload.attributes.verified_date;
	if (typeof verifiedDate === 'string' && verifiedDate.length > 0) {
		mergedAttributes.iso_date = verifiedDate;
	}

	return mergedAttributes;
}

function resolveLocale(config: MulderConfig): string {
	const locale = config.project.supported_locales[0];
	return typeof locale === 'string' && locale.length > 0 ? locale : 'en';
}

function computeExpiryDate(cacheTtlDays: number, groundedAt: Date): Date {
	return new Date(groundedAt.getTime() + cacheTtlDays * 24 * 60 * 60 * 1000);
}

function getGeoBias(entity: Entity): GroundingCoordinates | undefined {
	const geoPoint = entity.attributes.geo_point;
	if (!isRecord(geoPoint)) {
		return undefined;
	}
	const lat = geoPoint.lat;
	const lng = geoPoint.lng;
	if (typeof lat !== 'number' || typeof lng !== 'number') {
		return undefined;
	}
	return { lat, lng };
}

function makeResult(
	startTime: number,
	data: GroundingData,
	metadata: { items_processed: number; items_skipped: number; items_cached: number },
	errors: StepError[] = [],
): GroundResult {
	return {
		status: errors.length === 0 ? 'success' : 'partial',
		data,
		errors,
		metadata: {
			duration_ms: Math.round(performance.now() - startTime),
			items_processed: metadata.items_processed,
			items_skipped: metadata.items_skipped,
			items_cached: metadata.items_cached,
		},
	};
}

export async function execute(
	input: GroundInput,
	config: MulderConfig,
	services: Services,
	pool: pg.Pool | undefined,
	logger: Logger,
): Promise<GroundResult> {
	const log = createChildLogger(logger, { step: STEP_NAME, entityId: input.entityId });
	const startTime = performance.now();

	log.info({ refresh: input.refresh ?? false }, 'Ground step started');

	if (!pool) {
		throw new GroundError('Database pool is required for ground step', GROUND_ERROR_CODES.GROUND_WRITE_FAILED, {
			context: { entityId: input.entityId },
		});
	}

	if (!config.grounding.enabled || config.grounding.mode === 'disabled') {
		throw new GroundError('Grounding is disabled in the active configuration', GROUND_ERROR_CODES.GROUND_DISABLED, {
			context: {
				enabled: config.grounding.enabled,
				mode: config.grounding.mode,
			},
		});
	}

	const entity = await findEntityById(pool, input.entityId);
	if (!entity) {
		throw new GroundError(`Entity not found: ${input.entityId}`, GROUND_ERROR_CODES.GROUND_ENTITY_NOT_FOUND, {
			context: { entityId: input.entityId },
		});
	}

	const allowedTypes = new Set(config.grounding.enrich_types);
	if (!allowedTypes.has(entity.type)) {
		log.info({ entityType: entity.type }, 'Entity type is not configured for grounding — skipping');
		return makeResult(
			startTime,
			{
				entityId: entity.id,
				entityType: entity.type,
				outcome: 'skipped',
				refreshed: false,
				sourceUrlCount: 0,
				coordinatesApplied: false,
			},
			{ items_processed: 0, items_skipped: 1, items_cached: 0 },
		);
	}

	const cached = await findEntityGroundingByEntityId(pool, entity.id);
	const now = new Date();
	if (cached && !input.refresh && cached.expiresAt.getTime() > now.getTime()) {
		log.info({ expiresAt: cached.expiresAt.toISOString() }, 'Grounding cache hit — skipping fresh request');
		return makeResult(
			startTime,
			{
				entityId: entity.id,
				entityType: entity.type,
				outcome: 'cached',
				refreshed: false,
				sourceUrlCount: cached.sourceUrls.length,
				coordinatesApplied: entity.geom !== null,
			},
			{ items_processed: 0, items_skipped: 0, items_cached: 1 },
		);
	}

	const locale = resolveLocale(config);
	const prompt = renderPrompt('ground-entity', {
		locale,
		entity_name: entity.name,
		entity_type: entity.type,
		entity_attributes: entity.attributes,
	});

	let groundedResponse: GroundedGenerateResult;
	try {
		const geoBias = entity.type === 'location' ? getGeoBias(entity) : undefined;
		groundedResponse = await services.llm.groundedGenerate({
			prompt,
			excludeDomains: config.grounding.exclude_domains,
			geoBias: geoBias ? { latitude: geoBias.lat, longitude: geoBias.lng } : undefined,
		});
	} catch (cause: unknown) {
		throw new GroundError('Failed to call grounded Gemini generation', GROUND_ERROR_CODES.GROUND_LLM_FAILED, {
			cause,
			context: { entityId: entity.id, entityType: entity.type },
		});
	}

	const supportConfidence = extractSupportConfidence(groundedResponse.groundingMetadata);
	if (supportConfidence === null || supportConfidence < config.grounding.min_confidence) {
		throw new GroundError(
			`Grounding confidence ${supportConfidence ?? 'n/a'} is below the configured minimum`,
			GROUND_ERROR_CODES.GROUND_VALIDATION_FAILED,
			{
				context: {
					entityId: entity.id,
					minConfidence: config.grounding.min_confidence,
					supportConfidence,
				},
			},
		);
	}

	const payload = parseGroundedPayload(groundedResponse.text);
	const mergedAttributes = buildMergedAttributes(entity, payload);
	const sourceUrlSet = new Set<string>();
	collectSourceUrls(groundedResponse.groundingMetadata, sourceUrlSet);
	const sourceUrls = [...sourceUrlSet];
	const coordinates = payload.coordinates ?? undefined;

	const groundedAt = new Date();
	const expiresAt = computeExpiryDate(config.grounding.cache_ttl_days, groundedAt);
	const groundingRecord: Record<string, unknown> = {
		summary: payload.summary ?? null,
		confidence: payload.confidence ?? null,
		supportConfidence,
		coordinates: payload.coordinates ?? null,
		attributes: payload.attributes,
		groundingMetadata: groundedResponse.groundingMetadata,
	};

	try {
		await persistEntityGroundingResult(pool, {
			entityId: entity.id,
			groundingData: groundingRecord,
			sourceUrls,
			groundedAt,
			expiresAt,
			mergedAttributes,
			coordinates,
		});
	} catch (cause: unknown) {
		throw new GroundError('Failed to persist grounding results', GROUND_ERROR_CODES.GROUND_WRITE_FAILED, {
			cause,
			context: { entityId: entity.id },
		});
	}

	log.info(
		{
			entityType: entity.type,
			sourceUrlCount: sourceUrls.length,
			coordinatesApplied: coordinates !== undefined,
			supportConfidence,
		},
		'Ground step completed',
	);

	return makeResult(
		startTime,
		{
			entityId: entity.id,
			entityType: entity.type,
			outcome: 'grounded',
			refreshed: input.refresh === true && cached !== null,
			sourceUrlCount: sourceUrls.length,
			coordinatesApplied: coordinates !== undefined,
		},
		{ items_processed: 1, items_skipped: 0, items_cached: 0 },
	);
}
