import { describe, expect, it } from 'vitest';
import { sanitizeEnrichmentSuggestion } from './uploads.js';

describe('sanitizeEnrichmentSuggestion', () => {
	it('keeps original-source language and type when no description was suggested', () => {
		const suggestion = sanitizeEnrichmentSuggestion(
			{
				suggested: {
					provenance: {
						original_source: {
							language: 'DE',
							source_type: 'government_document',
						},
					},
				},
			},
			undefined,
		);

		expect(suggestion.provenance?.original_source).toEqual({
			language: 'de',
			source_type: 'government_document',
		});
	});
});
