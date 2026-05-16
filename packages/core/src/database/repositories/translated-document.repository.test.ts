import { describe, expect, it, vi } from 'vitest';
import { createCurrentTranslatedDocument } from './translated-document.repository.js';

function translatedDocumentRow() {
	return {
		content: 'Translated document',
		content_hash: 'translated-hash',
		created_at: new Date('2026-05-16T12:00:00Z'),
		id: 'translation-1',
		output_format: 'markdown',
		pipeline_path: 'translation_only',
		sensitivity_level: 'internal',
		sensitivity_metadata: null,
		source_document_id: 'source-1',
		source_language: 'en',
		status: 'current',
		target_language: 'de',
		translation_date: new Date('2026-05-16T12:00:00Z'),
		translation_engine: 'vertex',
		updated_at: new Date('2026-05-16T12:00:00Z'),
	};
}

describe('translated document repository', () => {
	it('uses an already checked-out PoolClient without reconnecting it', async () => {
		const client = {
			connect: vi.fn(async () => {
				throw new Error('PoolClient must not be reconnected');
			}),
			query: vi.fn(async (sql: string) => {
				if (sql.includes('INSERT INTO translated_documents')) {
					return { rows: [translatedDocumentRow()] };
				}
				return { rows: [] };
			}),
			release: vi.fn(),
		};

		const result = await createCurrentTranslatedDocument(client as never, {
			content: 'Translated document',
			contentHash: 'translated-hash',
			outputFormat: 'markdown',
			pipelinePath: 'translation_only',
			sourceDocumentId: 'source-1',
			sourceLanguage: 'en',
			targetLanguage: 'de',
			translationEngine: 'vertex',
		});

		expect(result.id).toBe('translation-1');
		expect(client.connect).not.toHaveBeenCalled();
		expect(client.release).not.toHaveBeenCalled();
		expect(client.query).toHaveBeenCalledTimes(2);
	});
});
