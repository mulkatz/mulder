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

type Queryable = pg.Pool | pg.PoolClient;
type TranslatedStoryBundleInput = Parameters<typeof createTranslatedStoryBundle>[1];
type PreparedTranslatedStoryBundle = Omit<TranslatedStoryBundleInput, 'translationId'>;

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

function errorField(error: unknown, key: string): unknown {
	return error && typeof error === 'object' ? Reflect.get(error, key) : undefined;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function errorCause(error: unknown): unknown {
	return errorField(error, 'cause');
}

function errorContext(error: unknown): Record<string, unknown> | null {
	const context = errorField(error, 'context');
	return context && typeof context === 'object' && !Array.isArray(context)
		? (context as Record<string, unknown>)
		: null;
}

function errorChain(error: unknown): unknown[] {
	const chain: unknown[] = [];
	let current = error;
	for (let index = 0; current && index < 8; index += 1) {
		chain.push(current);
		current = errorCause(current);
	}
	return chain;
}

function parseApiErrorMessage(message: string): Record<string, unknown> | null {
	try {
		const parsed = JSON.parse(message);
		const apiError = parsed && typeof parsed === 'object' ? Reflect.get(parsed, 'error') : null;
		return apiError && typeof apiError === 'object' && !Array.isArray(apiError)
			? (apiError as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

function describeStructuredGenerationCause(error: unknown): {
	code: unknown;
	httpStatus: unknown;
	message: string;
	originalMessage: string | null;
	status: unknown;
} {
	const chain = errorChain(error);
	const originalMessage =
		chain
			.map((item) => errorContext(item)?.originalMessage)
			.find((value): value is string => typeof value === 'string' && value.length > 0) ?? null;
	const parsedApiError = chain
		.map((item) => parseApiErrorMessage(errorMessage(item)))
		.find((value): value is Record<string, unknown> => value !== null);
	const parsedOriginal = originalMessage ? parseApiErrorMessage(originalMessage) : null;
	const apiError = parsedApiError ?? parsedOriginal;
	const message =
		typeof apiError?.message === 'string' && apiError.message.trim().length > 0
			? apiError.message
			: errorMessage(error);
	return {
		code: chain.map((item) => errorField(item, 'code')).find((value) => value !== undefined),
		httpStatus: apiError?.code,
		message,
		originalMessage,
		status: apiError?.status,
	};
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
	entity_mentions: z.unknown().optional(),
});

export function buildTranslatedStoryJsonSchema(): Record<string, unknown> {
	return {
		type: 'object',
		properties: {
			title: { type: 'string' },
			subtitle: { type: 'string' },
			markdown: { type: 'string' },
			entity_mentions: {
				type: 'array',
				items: {
					type: 'object',
					properties: {
						entity_id: { type: 'string' },
						surface_text: { type: 'string' },
						confidence: { type: 'number' },
					},
					required: ['entity_id', 'surface_text'],
				},
			},
		},
		required: ['title', 'markdown'],
	};
}

const translatedStoryJsonSchema = buildTranslatedStoryJsonSchema();

function translatedStoryMentions(
	rawMentions: unknown,
	story: StoryMaterial,
	markdown: string,
): PreparedTranslatedStoryBundle['mentions'] {
	if (!Array.isArray(rawMentions)) return [];
	return rawMentions
		.map((mention) => {
			if (!mention || typeof mention !== 'object' || Array.isArray(mention)) return null;
			const entityId = Reflect.get(mention, 'entity_id');
			const surfaceText = Reflect.get(mention, 'surface_text');
			if (typeof entityId !== 'string' || typeof surfaceText !== 'string') return null;
			const entity = story.entities.find((candidate) => candidate.id === entityId);
			const offsets = entity ? findUniqueOffset(markdown, surfaceText) : null;
			if (!entity || !offsets) return null;
			const rawConfidence = Reflect.get(mention, 'confidence');
			const confidence =
				typeof rawConfidence === 'number' && rawConfidence >= 0 && rawConfidence <= 1 ? rawConfidence : null;
			return {
				entityId,
				surfaceText: surfaceText.trim(),
				startOffset: offsets.start,
				endOffset: offsets.end,
				confidence,
				method: 'llm_structured_verified' as const,
			};
		})
		.filter((mention): mention is NonNullable<typeof mention> => mention !== null);
}

function translationStoryErrorMessage(causeDetails: ReturnType<typeof describeStructuredGenerationCause>): string {
	const schemaMessage = `${causeDetails.originalMessage ?? ''}\n${causeDetails.message}`;
	if (causeDetails.status === 'INVALID_ARGUMENT' && schemaMessage.includes('response_json_schema')) {
		return 'Vertex rejected translation story schema: INVALID_ARGUMENT';
	}
	return causeDetails.message;
}

async function prepareTranslatedStoryBundles(input: {
	config: MulderConfig;
	services: Services;
	material: ResolvedSourceMaterial;
	targetLanguage: string;
	logger: Logger;
}): Promise<PreparedTranslatedStoryBundle[]> {
	if (input.material.stories.length === 0) return [];
	const bundles: PreparedTranslatedStoryBundle[] = [];
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
		let response: z.infer<typeof translatedStoryResponseSchema>;
		try {
			response = await input.services.llm.generateStructured<z.infer<typeof translatedStoryResponseSchema>>({
				prompt,
				systemInstruction:
					'Translate faithfully. Entity mention offsets will be verified by exact surface matching; omit uncertain mentions.',
				schema: translatedStoryJsonSchema,
				responseValidator: (data) => translatedStoryResponseSchema.parse(data),
			});
		} catch (cause) {
			const causeDetails = describeStructuredGenerationCause(cause);
			const message = translationStoryErrorMessage(causeDetails);
			input.logger.warn(
				{
					sourceId: input.material.source.id,
					storyId: story.storyId,
					targetLanguage: input.targetLanguage,
					err: {
						code: causeDetails.code,
						httpStatus: causeDetails.httpStatus,
						message,
						originalMessage: causeDetails.originalMessage,
						status: causeDetails.status,
					},
				},
				'Translated story generation failed',
			);
			throw new PipelineError(
				`Translated story generation failed for story ${story.storyId}: ${message}`,
				PIPELINE_ERROR_CODES.PIPELINE_STEP_FAILED,
				{
					cause,
					context: {
						sourceId: input.material.source.id,
						storyId: story.storyId,
						targetLanguage: input.targetLanguage,
						causeCode: errorField(cause, 'code'),
						causeStatus: causeDetails.status,
						httpStatus: causeDetails.httpStatus,
					},
				},
			);
		}
		const mentions = translatedStoryMentions(response.entity_mentions, story, response.markdown);
		bundles.push({
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
	}
	return bundles;
}

async function persistTranslatedStoryBundles(
	pool: Queryable,
	translationId: string,
	bundles: PreparedTranslatedStoryBundle[],
): Promise<number> {
	for (const bundle of bundles) {
		await createTranslatedStoryBundle(pool, {
			translationId,
			...bundle,
		});
	}
	return bundles.length;
}

async function persistCurrentTranslationWithStories(
	pool: pg.Pool,
	documentInput: Parameters<typeof createCurrentTranslatedDocument>[1],
	bundles: PreparedTranslatedStoryBundle[],
): Promise<{ document: Awaited<ReturnType<typeof createCurrentTranslatedDocument>>; translatedStoryCount: number }> {
	const client = await pool.connect();
	try {
		await client.query('BEGIN');
		const document = await createCurrentTranslatedDocument(client, documentInput);
		const translatedStoryCount = await persistTranslatedStoryBundles(client, document.id, bundles);
		await client.query('COMMIT');
		return { document, translatedStoryCount };
	} catch (error) {
		await client.query('ROLLBACK').catch(() => undefined);
		throw error;
	} finally {
		client.release();
	}
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
	if (material.sourceLanguage !== DEFAULT_SOURCE_LANGUAGE && material.sourceLanguage === targetLanguage) {
		throw new PipelineError(
			`Source language and target language are both ${targetLanguage}`,
			PIPELINE_ERROR_CODES.PIPELINE_WRONG_STATUS,
			{ context: { sourceId: input.sourceId, sourceLanguage: material.sourceLanguage, targetLanguage } },
		);
	}

	if (config.translation.cache_enabled && input.refresh !== true) {
		const cached = await findCurrentTranslatedDocument(pool, input.sourceId, targetLanguage);
		if (cached && cached.contentHash === material.contentHash && cached.outputFormat === outputFormat) {
			const existingStoryCount = await countTranslatedStoriesForTranslation(pool, cached.id);
			const expectedStoryCount = material.stories.length;
			const translatedStoryCount =
				expectedStoryCount === 0 || existingStoryCount >= expectedStoryCount
					? existingStoryCount
					: await (async () => {
							const bundles = await prepareTranslatedStoryBundles({
								config,
								services,
								material,
								targetLanguage,
								logger,
							});
							const client = await pool.connect();
							try {
								await client.query('BEGIN');
								const count = await persistTranslatedStoryBundles(client, cached.id, bundles);
								await client.query('COMMIT');
								return count;
							} catch (error) {
								await client.query('ROLLBACK').catch(() => undefined);
								throw error;
							} finally {
								client.release();
							}
						})();
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
	const bundles = await prepareTranslatedStoryBundles({
		config,
		services,
		material,
		targetLanguage,
		logger,
	});
	const { document, translatedStoryCount } = await persistCurrentTranslationWithStories(
		pool,
		{
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
		},
		bundles,
	);

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
