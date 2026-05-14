import { describe, expect, it } from 'vitest';
import { DocumentQualitySummarySchema } from './documents.schemas.js';

describe('documents schemas', () => {
	it('accepts page coverage on document quality summaries', () => {
		const parsed = DocumentQualitySummarySchema.parse({
			id: '00000000-0000-4000-8000-000000000101',
			assessed_at: '2026-05-14T10:00:00.000Z',
			assessment_method: 'fixture',
			overall_quality: 'good',
			page_coverage: {
				pages_total: 10,
				pages_readable: 8,
				ratio: 0.8,
			},
			processable: true,
			recommended_path: 'native_text',
			text_readability_score: 0.91,
			language: 'de',
			language_confidence: 0.99,
		});

		expect(parsed.page_coverage?.pages_readable).toBe(8);
	});

	it('accepts missing page coverage as an explicit null', () => {
		const parsed = DocumentQualitySummarySchema.parse({
			id: '00000000-0000-4000-8000-000000000102',
			assessed_at: '2026-05-14T10:00:00.000Z',
			assessment_method: 'fixture',
			overall_quality: 'unknown',
			page_coverage: null,
			processable: false,
			recommended_path: 'document_ai',
			text_readability_score: null,
			language: null,
			language_confidence: null,
		});

		expect(parsed.page_coverage).toBeNull();
	});
});
