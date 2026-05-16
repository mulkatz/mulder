import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	countStories: vi.fn(),
	countTranslatedStoriesForTranslation: vi.fn(),
	enqueueJob: vi.fn(),
	findCurrentTranslatedDocument: vi.fn(),
	findSourceById: vi.fn(),
	findStoriesBySourceId: vi.fn(),
}));

vi.mock('@mulder/core', () => ({
	allowedSensitivityLevelsForMax: vi.fn(() => ['public', 'internal']),
	countProcessedSources: vi.fn(async () => 0),
	countStories: mocks.countStories,
	countTranslatedStoriesForTranslation: mocks.countTranslatedStoriesForTranslation,
	DATABASE_ERROR_CODES: { DB_CONNECTION_FAILED: 'DB_CONNECTION_FAILED', DB_QUERY_FAILED: 'DB_QUERY_FAILED' },
	DatabaseError: class DatabaseError extends Error {
		code: string;
		constructor(message: string, code: string) {
			super(message);
			this.code = code;
		}
	},
	enqueueJob: mocks.enqueueJob,
	findCurrentTranslatedDocument: mocks.findCurrentTranslatedDocument,
	findSourceById: mocks.findSourceById,
	findStoriesBySourceId: mocks.findStoriesBySourceId,
	getWorkerPool: vi.fn(() => ({
		connect: async () => ({
			query: vi.fn(async () => ({ rows: [] })),
			release: vi.fn(),
		}),
	})),
	listTranslatedDocumentsForSource: vi.fn(async () => []),
	listTranslatedStoriesForTranslation: vi.fn(async () => []),
	loadConfig: vi.fn(() => ({
		gcp: { cloud_sql: {} },
		translation: { output_format: 'markdown' },
	})),
	MulderError: class MulderError extends Error {
		code: string;
		context?: unknown;
		constructor(message: string, code: string, options?: { context?: unknown }) {
			super(message);
			this.code = code;
			this.context = options?.context;
		}
	},
	normalizeSensitivityMetadata: vi.fn(() => ({})),
	presentCorroborationScore: vi.fn(() => null),
	resolveAccessPolicy: vi.fn(() => ({ enabled: false, maxSensitivityLevel: undefined, permissions: ['read'] })),
}));

function source() {
	return {
		formatMetadata: {},
		id: '00000000-0000-4000-8000-000000000101',
		metadata: {},
	};
}

function cachedTranslation() {
	return {
		content: 'cached',
		contentHash: 'hash',
		id: '00000000-0000-4000-8000-000000000202',
		outputFormat: 'markdown',
		pipelinePath: 'translation_only',
		sourceDocumentId: '00000000-0000-4000-8000-000000000101',
		sourceLanguage: 'en',
		status: 'current',
		targetLanguage: 'de',
		translationDate: new Date('2026-05-16T12:00:00Z'),
		translationEngine: 'vertex',
	};
}

describe('translation API jobs', () => {
	beforeEach(() => {
		mocks.countStories.mockReset().mockResolvedValue(4);
		mocks.countTranslatedStoriesForTranslation.mockReset().mockResolvedValue(1);
		mocks.enqueueJob.mockReset().mockResolvedValue({ id: '00000000-0000-4000-8000-000000000303' });
		mocks.findCurrentTranslatedDocument.mockReset().mockResolvedValue(cachedTranslation());
		mocks.findSourceById.mockReset().mockResolvedValue(source());
		mocks.findStoriesBySourceId.mockReset().mockResolvedValue([{ language: 'en' }]);
	});

	it('enqueues repair when a cached current translation has only some translated stories', async () => {
		const { requestDocumentTranslation } = await import('./translations.js');

		const result = await requestDocumentTranslation('00000000-0000-4000-8000-000000000101', {
			output_format: 'markdown',
			pipeline_path: 'translation_only',
			refresh: false,
			target_language: 'de',
		});

		expect(result.status).toBe(202);
		expect(mocks.enqueueJob).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				type: 'translate',
				payload: expect.objectContaining({
					sourceId: '00000000-0000-4000-8000-000000000101',
					targetLanguage: 'de',
				}),
			}),
		);
	});
});
