import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	countTranslatedStoriesForTranslation: vi.fn(),
	createCurrentTranslatedDocument: vi.fn(),
	createTranslatedStoryBundle: vi.fn(),
	findCurrentTranslatedDocument: vi.fn(),
	findEntitiesByStoryId: vi.fn(),
	findSourceById: vi.fn(),
	findStoriesBySourceId: vi.fn(),
}));

vi.mock('@mulder/core', () => ({
	countTranslatedStoriesForTranslation: mocks.countTranslatedStoriesForTranslation,
	createCurrentTranslatedDocument: mocks.createCurrentTranslatedDocument,
	createTranslatedStoryBundle: mocks.createTranslatedStoryBundle,
	findCurrentTranslatedDocument: mocks.findCurrentTranslatedDocument,
	findEntitiesByStoryId: mocks.findEntitiesByStoryId,
	findSourceById: mocks.findSourceById,
	findStoriesBySourceId: mocks.findStoriesBySourceId,
	PIPELINE_ERROR_CODES: {
		PIPELINE_SOURCE_NOT_FOUND: 'PIPELINE_SOURCE_NOT_FOUND',
		PIPELINE_STEP_FAILED: 'PIPELINE_STEP_FAILED',
		PIPELINE_WRONG_STATUS: 'PIPELINE_WRONG_STATUS',
	},
	PipelineError: class PipelineError extends Error {
		code: string;
		constructor(message: string, code: string) {
			super(message);
			this.code = code;
		}
	},
	renderPrompt: (_name: string, input: Record<string, unknown>) => JSON.stringify(input),
}));

function config() {
	return {
		translation: {
			cache_enabled: true,
			default_target_language: 'de',
			enabled: true,
			engine: 'vertex',
			max_document_length_tokens: 100_000,
			output_format: 'markdown',
			supported_languages: ['de', 'en'],
		},
	};
}

function source() {
	return {
		fileHash: 'source-hash',
		formatMetadata: {},
		id: 'source-1',
		metadata: {},
		sensitivityLevel: 'internal',
		sensitivityMetadata: null,
		sourceType: 'pdf',
		storagePath: 'raw/source-1/original.pdf',
	};
}

function story(language = 'en') {
	return {
		gcsMarkdownUri: 'stories/story-1.md',
		id: 'story-1',
		language,
		sensitivityLevel: 'internal',
		sensitivityMetadata: null,
		subtitle: null,
		title: 'Story one',
	};
}

function cachedTranslation() {
	return {
		content: 'Cached translated document',
		contentHash: createHash('sha256').update('Story markdown\n\n---\n\nStory markdown', 'utf8').digest('hex'),
		id: 'cached-translation-1',
		outputFormat: 'markdown',
		pipelinePath: 'translation_only',
		sourceLanguage: 'en',
		targetLanguage: 'de',
	};
}

function services(overrides: Partial<Record<'generateStructured', unknown>> = {}) {
	return {
		llm: {
			countTokens: vi.fn(async () => 10),
			generateStructured:
				overrides.generateStructured ??
				vi.fn(async () => ({
					entity_mentions: [],
					markdown: 'Übersetzter Text',
					title: 'Übersetzte Story',
				})),
			generateText: vi.fn(async () => 'Übersetztes Dokument'),
		},
		storage: {
			download: vi.fn(async () => Buffer.from('Story markdown')),
		},
	};
}

function pool() {
	const client = {
		query: vi.fn(async () => ({ rows: [] })),
		release: vi.fn(),
	};
	return {
		connect: vi.fn(async () => client),
	};
}

describe('translate pipeline', () => {
	beforeEach(() => {
		mocks.createCurrentTranslatedDocument.mockReset();
		mocks.createTranslatedStoryBundle.mockReset();
		mocks.countTranslatedStoriesForTranslation.mockReset().mockResolvedValue(0);
		mocks.findCurrentTranslatedDocument.mockReset().mockResolvedValue(null);
		mocks.findEntitiesByStoryId.mockReset().mockResolvedValue([]);
		mocks.findSourceById.mockReset().mockResolvedValue(source());
		mocks.findStoriesBySourceId.mockReset().mockResolvedValue([story('en')]);
		mocks.createCurrentTranslatedDocument.mockResolvedValue({
			content: 'Übersetztes Dokument',
			contentHash: 'source-hash',
			id: 'translation-1',
			outputFormat: 'markdown',
			pipelinePath: 'translation_only',
			sourceLanguage: 'en',
			targetLanguage: 'de',
		});
		mocks.createTranslatedStoryBundle.mockResolvedValue({});
	});

	it('rejects same-language translation after resolving story language', async () => {
		const { execute } = await import('./index.js');

		await expect(
			execute(
				{ sourceId: 'source-1', targetLanguage: 'en' },
				config() as never,
				services() as never,
				pool() as never,
				{ warn: vi.fn(), info: vi.fn() } as never,
			),
		).rejects.toThrow('Source language and target language are both en');

		expect(mocks.createCurrentTranslatedDocument).not.toHaveBeenCalled();
	});

	it('does not mark a translation current when story translation fails', async () => {
		const { execute } = await import('./index.js');
		const failingServices = services({
			generateStructured: vi.fn(async () => {
				throw Object.assign(new Error('structured output failed'), { code: 'EXT_VERTEX_AI_FAILED' });
			}),
		});

		await expect(
			execute(
				{ sourceId: 'source-1', targetLanguage: 'de' },
				config() as never,
				failingServices as never,
				pool() as never,
				{ warn: vi.fn(), info: vi.fn() } as never,
			),
		).rejects.toThrow('Translated story generation failed');

		expect(mocks.createCurrentTranslatedDocument).not.toHaveBeenCalled();
		expect(mocks.createTranslatedStoryBundle).not.toHaveBeenCalled();
	});

	it('repairs cached translations when only some source stories are translated', async () => {
		const { execute } = await import('./index.js');
		mocks.findCurrentTranslatedDocument.mockResolvedValue(cachedTranslation());
		mocks.countTranslatedStoriesForTranslation.mockResolvedValue(1);
		mocks.findStoriesBySourceId.mockResolvedValue([
			{ ...story('en'), id: 'story-1', gcsMarkdownUri: 'stories/story-1.md', title: 'Story one' },
			{ ...story('en'), id: 'story-2', gcsMarkdownUri: 'stories/story-2.md', title: 'Story two' },
		]);

		const result = await execute(
			{ sourceId: 'source-1', targetLanguage: 'de' },
			config() as never,
			services() as never,
			pool() as never,
			{ warn: vi.fn(), info: vi.fn() } as never,
		);

		expect(result.status).toBe('success');
		expect(result.data.outcome).toBe('cached');
		expect(result.data.translatedStoryCount).toBe(2);
		expect(mocks.createCurrentTranslatedDocument).not.toHaveBeenCalled();
		expect(mocks.createTranslatedStoryBundle).toHaveBeenCalledTimes(2);
	});
});
