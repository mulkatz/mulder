import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { Logger, MulderConfig, Services, Source } from '@mulder/core';
import {
	countTranslatedStoriesForTranslation,
	createCurrentTranslatedDocument,
	createTranslatedStoryBundle,
	findCurrentTranslatedDocument,
	findEntitiesByStoryId,
	findSourceById,
	findStoriesBySourceId,
	PIPELINE_ERROR_CODES,
	PipelineError,
	renderPrompt,
} from '@mulder/core';
import type pg from 'pg';
import { z } from 'zod';
import { z as z3 } from 'zod/v3';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { TranslateData, TranslateInput, TranslateResult } from './types.js';

export type { TranslateData, TranslateInput, TranslateResult, TranslationOutcome } from './types.js';

interface ResolvedSourceMaterial {
	source: Source;
	content: string;
	contentHash: string;
	sourceLanguage: string;
	media?: Array<{ mimeType: string; data: Buffer }>;
	stories: StoryMaterial[];
}

interface StoryMaterial {
	storyId: string;
	title: string;
	subtitle: string | null;
	markdown: string;
	language: string | null;
	sensitivityLevel: Source['sensitivityLevel'];
	sensitivityMetadata: unknown;
	entities: Array<{ id: string; name: string; type: string }>;
}

const DEFAULT_SOURCE_LANGUAGE = 'und';
const TEXT_SOURCE_TYPES = new Set(['text', 'url']);

function normalizeLanguage(value: string): string {
	return value.trim().toLowerCase();
}

function validateLanguage(
	language: string,
	supportedLanguages: readonly string[],
	fieldName: 'sourceLanguage' | 'targetLanguage',
): string {
	const normalized = normalizeLanguage(language);
	if (normalized.length === 0) {
		throw new PipelineError(`${fieldName} is required`, PIPELINE_ERROR_CODES.PIPELINE_WRONG_STATUS, {
			context: { fieldName },
		});
	}
	if (normalized !== DEFAULT_SOURCE_LANGUAGE && !supportedLanguages.includes(normalized)) {
		throw new PipelineError(
			`Unsupported ${fieldName}: ${normalized}. Supported languages: ${supportedLanguages.join(', ')}`,
			PIPELINE_ERROR_CODES.PIPELINE_WRONG_STATUS,
			{ context: { fieldName, language: normalized, supportedLanguages: [...supportedLanguages] } },
		);
	}
	return normalized;
}

function hashText(content: string): string {
	return createHash('sha256').update(content, 'utf8').digest('hex');
}

function hashBuffer(content: Buffer): string {
	return createHash('sha256').update(content).digest('hex');
}

function findUniqueOffset(markdown: string, surface: string): { start: number; end: number } | null {
	const trimmed = surface.trim();
	if (!trimmed) return null;
	const first = markdown.indexOf(trimmed);
	if (first < 0) return null;
	if (markdown.indexOf(trimmed, first + trimmed.length) >= 0) return null;
	return { start: first, end: first + trimmed.length };
}

function metadataString(source: Source, key: string): string | null {
	const metadataValue = source.metadata[key];
	if (typeof metadataValue === 'string' && metadataValue.trim().length > 0) {
		return metadataValue.trim();
	}
	const formatValue = source.formatMetadata[key];
	if (typeof formatValue === 'string' && formatValue.trim().length > 0) {
		return formatValue.trim();
	}
	return null;
}

function guessMediaType(source: Source): string {
	const metadataMediaType = metadataString(source, 'media_type') ?? metadataString(source, 'mime_type');
	if (metadataMediaType) return metadataMediaType;

	const lowerPath = source.storagePath.toLowerCase();
	if (lowerPath.endsWith('.pdf')) return 'application/pdf';
	if (lowerPath.endsWith('.png')) return 'image/png';
	if (lowerPath.endsWith('.jpg') || lowerPath.endsWith('.jpeg')) return 'image/jpeg';
	if (lowerPath.endsWith('.txt')) return 'text/plain';
	if (lowerPath.endsWith('.md') || lowerPath.endsWith('.markdown')) return 'text/markdown';
	return 'application/octet-stream';
}

function isTextBackedSource(source: Source): boolean {
	if (TEXT_SOURCE_TYPES.has(source.sourceType)) return true;
	const mediaType = guessMediaType(source);
	return mediaType.startsWith('text/');
}

async function assembleStoryMarkdown(
	services: Services,
	pool: pg.Pool,
	sourceId: string,
): Promise<{ content: string; language: string | null; stories: StoryMaterial[] } | null> {
	const stories = await findStoriesBySourceId(pool, sourceId);
	if (stories.length === 0) {
		return null;
	}

	const blocks: string[] = [];
	const storyMaterials: StoryMaterial[] = [];
	for (const story of stories) {
		const markdown = await services.storage.download(story.gcsMarkdownUri);
		const content = markdown.toString('utf8');
		const entities = await findEntitiesByStoryId(pool, story.id);
		blocks.push(content);
		storyMaterials.push({
			storyId: story.id,
			title: story.title,
			subtitle: story.subtitle,
			markdown: content,
			language: story.language,
			sensitivityLevel: story.sensitivityLevel,
			sensitivityMetadata: story.sensitivityMetadata,
			entities: entities.map((entity) => ({ id: entity.id, name: entity.name, type: entity.type })),
		});
	}

	const language = stories.find((story) => story.language && story.language.trim().length > 0)?.language ?? null;
	return { content: blocks.join('\n\n---\n\n'), language, stories: storyMaterials };
}

async function resolveSourceMaterial(
	input: TranslateInput,
	config: MulderConfig,
	services: Services,
	pool: pg.Pool,
): Promise<ResolvedSourceMaterial> {
	const source = await findSourceById(pool, input.sourceId);
	if (!source) {
		throw new PipelineError(`Source not found: ${input.sourceId}`, PIPELINE_ERROR_CODES.PIPELINE_SOURCE_NOT_FOUND, {
			context: { sourceId: input.sourceId },
		});
	}

	if (input.content !== undefined) {
		const sourceLanguage = validateLanguage(
			input.sourceLanguage ?? metadataString(source, 'language') ?? DEFAULT_SOURCE_LANGUAGE,
			config.translation.supported_languages,
			'sourceLanguage',
		);
		return {
			source,
			content: input.content,
			contentHash: hashText(input.content),
			sourceLanguage,
			stories: [],
		};
	}

	const storyMaterial = await assembleStoryMarkdown(services, pool, input.sourceId);
	if (storyMaterial) {
		const sourceLanguage = validateLanguage(
			input.sourceLanguage ?? storyMaterial.language ?? metadataString(source, 'language') ?? DEFAULT_SOURCE_LANGUAGE,
			config.translation.supported_languages,
			'sourceLanguage',
		);
		return {
			source,
			content: storyMaterial.content,
			contentHash: hashText(storyMaterial.content),
			sourceLanguage,
			stories: storyMaterial.stories,
		};
	}

	const rawContent = await services.storage.download(source.storagePath);
	const sourceLanguage = validateLanguage(
		input.sourceLanguage ?? metadataString(source, 'language') ?? DEFAULT_SOURCE_LANGUAGE,
		config.translation.supported_languages,
		'sourceLanguage',
	);

	if (isTextBackedSource(source)) {
		const content = rawContent.toString('utf8');
		return {
			source,
			content,
			contentHash: hashText(content),
			sourceLanguage,
			stories: [],
		};
	}

	const mimeType = guessMediaType(source);
	return {
		source,
		content: `[Source document is attached as ${mimeType}. Translate the full document into the requested output format.]`,
		contentHash: source.fileHash || hashBuffer(rawContent),
		sourceLanguage,
		media: [{ mimeType, data: rawContent }],
		stories: [],
	};
}

async function assertTextWithinTokenLimit(
	services: Services,
	content: string,
	maxDocumentLengthTokens: number,
	sourceId: string,
): Promise<void> {
	const tokenCount = await services.llm.countTokens(content);
	if (tokenCount > maxDocumentLengthTokens) {
		throw new PipelineError(
			`Source ${sourceId} is too long to translate in one call (${tokenCount} tokens > ${maxDocumentLengthTokens})`,
			PIPELINE_ERROR_CODES.PIPELINE_WRONG_STATUS,
			{ context: { sourceId, tokenCount, maxDocumentLengthTokens } },
		);
	}
}

const translatedStoryResponseSchema = z.object({
	title: z.string().min(1),
	subtitle: z.string().nullable().optional(),
	markdown: z.string().min(1),
	entity_mentions: z
		.array(
			z.object({
				entity_id: z.string().uuid(),
				surface_text: z.string().min(1),
				confidence: z.number().min(0).max(1).nullable().optional(),
			}),
		)
		.default([]),
});

const translatedStoryResponseSchemaV3 = z3.object({
	title: z3.string().min(1),
	subtitle: z3.string().nullable().optional(),
	markdown: z3.string().min(1),
	entity_mentions: z3
		.array(
			z3.object({
				entity_id: z3.string().uuid(),
				surface_text: z3.string().min(1),
				confidence: z3.number().min(0).max(1).nullable().optional(),
			}),
		)
		.default([]),
});

const translatedStoryJsonSchema = zodToJsonSchema(translatedStoryResponseSchemaV3, {
	name: 'TranslatedStoryResponse',
	$refStrategy: 'none',
}) as Record<string, unknown>;

async function ensureTranslatedStories(input: {
	config: MulderConfig;
	services: Services;
	pool: pg.Pool;
	material: ResolvedSourceMaterial;
	translationId: string;
	targetLanguage: string;
	logger: Logger;
}): Promise<number> {
	if (input.material.stories.length === 0) return 0;
	let count = 0;
	for (const story of input.material.stories) {
		const prompt = [
			'Translate this extracted story. Preserve markdown structure and meaning.',
			'Return entity mentions only when the translated surface text appears exactly once in the translated markdown.',
			`Source language: ${input.material.sourceLanguage}`,
			`Target language: ${input.targetLanguage}`,
			`Entities: ${JSON.stringify(story.entities)}`,
			`Title: ${story.title}`,
			story.subtitle ? `Subtitle: ${story.subtitle}` : null,
			'Markdown:',
			story.markdown,
		]
			.filter(Boolean)
			.join('\n\n');
		const response = await input.services.llm.generateStructured<z.infer<typeof translatedStoryResponseSchema>>({
			prompt,
			systemInstruction:
				'Translate faithfully. Entity mention offsets will be verified by exact surface matching; omit uncertain mentions.',
			schema: translatedStoryJsonSchema,
			responseValidator: (data) => translatedStoryResponseSchema.parse(data),
		});
		const mentions = response.entity_mentions
			.map((mention) => {
				const entity = story.entities.find((candidate) => candidate.id === mention.entity_id);
				const offsets = entity ? findUniqueOffset(response.markdown, mention.surface_text) : null;
				if (!entity || !offsets) return null;
				return {
					entityId: mention.entity_id,
					surfaceText: mention.surface_text,
					startOffset: offsets.start,
					endOffset: offsets.end,
					confidence: mention.confidence ?? null,
					method: 'llm_structured_verified' as const,
				};
			})
			.filter((mention): mention is NonNullable<typeof mention> => mention !== null);
		await createTranslatedStoryBundle(input.pool, {
			translationId: input.translationId,
			storyId: story.storyId,
			sourceDocumentId: input.material.source.id,
			sourceLanguage: input.material.sourceLanguage,
			targetLanguage: input.targetLanguage,
			title: response.title,
			subtitle: response.subtitle ?? null,
			markdown: response.markdown,
			contentHash: hashText(response.markdown),
			sensitivityLevel: story.sensitivityLevel,
			sensitivityMetadata: story.sensitivityMetadata,
			mentions,
		});
		count++;
	}
	input.logger.info({ sourceId: input.material.source.id, count }, 'Translated story records ensured');
	return count;
}

export async function execute(
	input: TranslateInput,
	config: MulderConfig,
	services: Services,
	pool: pg.Pool,
	logger: Logger,
): Promise<TranslateResult> {
	const startedAt = performance.now();
	if (!config.translation.enabled) {
		throw new PipelineError('Translation is disabled by config', PIPELINE_ERROR_CODES.PIPELINE_WRONG_STATUS);
	}

	const targetLanguage = validateLanguage(
		input.targetLanguage ?? config.translation.default_target_language,
		config.translation.supported_languages,
		'targetLanguage',
	);
	const outputFormat = input.outputFormat ?? config.translation.output_format;
	const pipelinePath = input.pipelinePath ?? 'translation_only';
	const material = await resolveSourceMaterial(input, config, services, pool);

	if (config.translation.cache_enabled && input.refresh !== true) {
		const cached = await findCurrentTranslatedDocument(pool, input.sourceId, targetLanguage);
		if (cached && cached.contentHash === material.contentHash && cached.outputFormat === outputFormat) {
			const existingStoryCount = await countTranslatedStoriesForTranslation(pool, cached.id);
			const translatedStoryCount =
				existingStoryCount > 0
					? existingStoryCount
					: await ensureTranslatedStories({
							config,
							services,
							pool,
							material,
							translationId: cached.id,
							targetLanguage,
							logger,
						});
			logger.info({ sourceId: input.sourceId, targetLanguage }, 'Translation cache hit');
			const data: TranslateData = {
				sourceId: input.sourceId,
				translationId: cached.id,
				outcome: 'cached',
				sourceLanguage: cached.sourceLanguage,
				targetLanguage: cached.targetLanguage,
				pipelinePath: cached.pipelinePath,
				outputFormat: cached.outputFormat,
				contentHash: cached.contentHash,
				content: cached.content,
				document: cached,
				translatedStoryCount,
			};
			return {
				status: 'success',
				data,
				errors: [],
				metadata: {
					duration_ms: Math.round(performance.now() - startedAt),
					items_processed: 0,
					items_cached: 1,
				},
			};
		}
	}

	if (!material.media || material.media.length === 0) {
		await assertTextWithinTokenLimit(
			services,
			material.content,
			config.translation.max_document_length_tokens,
			input.sourceId,
		);
	}

	const prompt = renderPrompt('translate-document', {
		source_language: material.sourceLanguage,
		target_language: targetLanguage,
		output_format: outputFormat,
		pipeline_path: pipelinePath,
		content: material.content,
	});
	const translatedContent = await services.llm.generateText({
		prompt,
		systemInstruction: 'Translate faithfully. Preserve structure and do not add commentary.',
		media: material.media,
	});

	const document = await createCurrentTranslatedDocument(pool, {
		sourceDocumentId: input.sourceId,
		sourceLanguage: material.sourceLanguage,
		targetLanguage,
		translationEngine: config.translation.engine,
		content: translatedContent,
		contentHash: material.contentHash,
		pipelinePath,
		outputFormat,
		sensitivityLevel: material.source.sensitivityLevel,
		sensitivityMetadata: material.source.sensitivityMetadata,
	});
	const translatedStoryCount = await ensureTranslatedStories({
		config,
		services,
		pool,
		material,
		translationId: document.id,
		targetLanguage,
		logger,
	});

	const data: TranslateData = {
		sourceId: input.sourceId,
		translationId: document.id,
		outcome: 'translated',
		sourceLanguage: document.sourceLanguage,
		targetLanguage: document.targetLanguage,
		pipelinePath: document.pipelinePath,
		outputFormat: document.outputFormat,
		contentHash: document.contentHash,
		content: document.content,
		document,
		translatedStoryCount,
	};

	logger.info({ sourceId: input.sourceId, targetLanguage, pipelinePath }, 'Translation complete');
	return {
		status: 'success',
		data,
		errors: [],
		metadata: {
			duration_ms: Math.round(performance.now() - startedAt),
			items_processed: 1,
			items_cached: 0,
		},
	};
}
