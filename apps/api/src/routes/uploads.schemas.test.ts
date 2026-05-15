import { describe, expect, it } from 'vitest';
import { CompleteDocumentUploadRequestSchema } from './uploads.schemas.js';

describe('upload schemas', () => {
	it('accepts original source language and type without a description', () => {
		const parsed = CompleteDocumentUploadRequestSchema.parse({
			source_id: '00000000-0000-4000-8000-000000000201',
			filename: 'source.pdf',
			storage_path: 'raw/00000000-0000-4000-8000-000000000201/original.pdf',
			provenance: {
				original_source: {
					language: 'de',
					source_type: 'government_document',
				},
			},
		});

		expect(parsed.provenance?.original_source?.description).toBeUndefined();
		expect(parsed.provenance?.original_source?.language).toBe('de');
	});
});
