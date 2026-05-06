import type {
	CredibilityConfig,
	CredibilitySourceType,
	Logger,
	Services,
	Source,
	SourceCredibilityProfile,
} from '@mulder/core';
import {
	createChildLogger,
	findSourceById,
	findSourceCredibilityProfileBySourceId,
	renderPrompt,
	upsertSourceCredibilityProfile,
} from '@mulder/core';
import type pg from 'pg';
import { z } from 'zod';

export type CredibilityProfileGenerationStatus = 'created' | 'skipped' | 'failed';

export interface CredibilityProfileGenerationResult {
	status: CredibilityProfileGenerationStatus;
	created: boolean;
	profile: SourceCredibilityProfile | null;
	reason: string | null;
}

interface GenerateCredibilityProfileInput {
	sourceId: string;
	config: CredibilityConfig;
	services: Services;
	pool: pg.Pool;
	logger: Logger;
}

interface CredibilityDraftResponse {
	source_type: CredibilitySourceType;
	dimensions: Array<{
		id: string;
		score: number;
		rationale: string;
		evidence_refs: string[];
		known_factors: string[];
	}>;
}

const SOURCE_TYPES: readonly CredibilitySourceType[] = [
	'government',
	'academic',
	'journalist',
	'witness',
	'organization',
	'anonymous',
	'other',
] as const;

function isCredibilitySourceType(value: string): value is CredibilitySourceType {
	return SOURCE_TYPES.some((sourceType) => sourceType === value);
}

function compactJson(value: unknown): string {
	const serialized = JSON.stringify(value ?? {}, null, 2);
	return serialized.length <= 6000 ? serialized : `${serialized.slice(0, 6000)}\n[truncated]`;
}

function dimensionsPrompt(config: CredibilityConfig): string {
	return config.dimensions.map((dimension) => `- ${dimension.id}: ${dimension.label}`).join('\n');
}

function sourcePromptContext(source: Source): Record<string, unknown> {
	return {
		filename: source.filename,
		source_type: source.sourceType,
		tags: source.tags.join(', '),
		metadata: compactJson({
			source_metadata: source.metadata,
			format_metadata: source.formatMetadata,
			page_count: source.pageCount,
			has_native_text: source.hasNativeText,
			native_text_ratio: source.nativeTextRatio,
			sensitivity_level: source.sensitivityLevel ?? null,
		}),
		provenance_summary: compactJson({
			file_hash: source.fileHash,
			storage_path: source.storagePath,
			parent_source_id: source.parentSourceId,
			created_at: source.createdAt.toISOString(),
		}),
	};
}

function jsonSchema(config: CredibilityConfig): Record<string, unknown> {
	return {
		type: 'object',
		additionalProperties: false,
		required: ['source_type', 'dimensions'],
		properties: {
			source_type: { type: 'string', enum: SOURCE_TYPES },
			dimensions: {
				type: 'array',
				minItems: config.dimensions.length,
				maxItems: config.dimensions.length,
				items: {
					type: 'object',
					additionalProperties: false,
					required: ['id', 'score', 'rationale', 'evidence_refs', 'known_factors'],
					properties: {
						id: { type: 'string', enum: config.dimensions.map((dimension) => dimension.id) },
						score: { type: 'number', minimum: 0, maximum: 1 },
						rationale: { type: 'string', minLength: 1 },
						evidence_refs: { type: 'array', items: { type: 'string' } },
						known_factors: { type: 'array', items: { type: 'string' } },
					},
				},
			},
		},
	};
}

function responseSchema(config: CredibilityConfig) {
	const configuredIds = new Set(config.dimensions.map((dimension) => dimension.id));
	return z
		.object({
			source_type: z.string().refine(isCredibilitySourceType, 'Invalid credibility source type'),
			dimensions: z.array(
				z.object({
					id: z.string().min(1),
					score: z.number().min(0).max(1),
					rationale: z.string().min(1),
					evidence_refs: z.array(z.string()).default([]),
					known_factors: z.array(z.string()).default([]),
				}),
			),
		})
		.refine(
			(value) =>
				value.dimensions.length === configuredIds.size &&
				value.dimensions.every((dimension) => configuredIds.has(dimension.id)) &&
				new Set(value.dimensions.map((dimension) => dimension.id)).size === configuredIds.size,
			'Credibility response must include each configured dimension exactly once',
		);
}

export async function generateSourceCredibilityProfileDraft(
	input: GenerateCredibilityProfileInput,
): Promise<CredibilityProfileGenerationResult> {
	const log = createChildLogger(input.logger, { module: 'source-credibility-draft', sourceId: input.sourceId });
	if (!input.config.enabled)
		return { status: 'skipped', created: false, profile: null, reason: 'credibility_disabled' };
	if (!input.config.auto_profile_on_ingest) {
		return { status: 'skipped', created: false, profile: null, reason: 'auto_profile_disabled' };
	}

	try {
		const existing = await findSourceCredibilityProfileBySourceId(input.pool, input.sourceId);
		if (existing) return { status: 'skipped', created: false, profile: existing, reason: 'profile_exists' };

		const source = await findSourceById(input.pool, input.sourceId);
		if (!source) return { status: 'failed', created: false, profile: null, reason: 'source_not_found' };

		const schema = responseSchema(input.config);
		const response = await input.services.llm.generateStructured<CredibilityDraftResponse>({
			prompt: renderPrompt('source-credibility-profile', {
				source: sourcePromptContext(source),
				dimensions: dimensionsPrompt(input.config),
			}),
			schema: jsonSchema(input.config),
			responseValidator: (data) => schema.parse(data),
		});
		const labels = new Map(input.config.dimensions.map((dimension) => [dimension.id, dimension.label]));
		const profile = await upsertSourceCredibilityProfile(input.pool, {
			sourceId: source.id,
			sourceName: source.filename,
			sourceType: response.source_type,
			profileAuthor: 'llm_auto',
			reviewStatus: 'draft',
			lastReviewed: null,
			dimensions: response.dimensions.map((dimension) => ({
				dimensionId: dimension.id,
				label: labels.get(dimension.id) ?? dimension.id,
				score: dimension.score,
				rationale: dimension.rationale,
				evidenceRefs: dimension.evidence_refs,
				knownFactors: dimension.known_factors,
			})),
		});
		log.info({ profileId: profile.profileId }, 'Created draft source credibility profile');
		return { status: 'created', created: true, profile, reason: null };
	} catch (cause: unknown) {
		const reason = cause instanceof Error ? cause.message : String(cause);
		log.warn({ err: cause }, 'Source credibility draft generation failed');
		return { status: 'failed', created: false, profile: null, reason };
	}
}
