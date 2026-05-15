import { describe, expect, it } from 'vitest';
import { buildDocumentUploadPayload } from './buildDocumentUploadPayload';

function baseInput() {
	return {
		acquisitionNotes: '',
		authenticityNotes: '',
		authenticityStatus: '',
		channel: '',
		collectionId: '',
		custodian: '',
		custodyNotes: '',
		noCollectionConfirmed: true,
		sensitivityLevel: '',
		sensitivityReason: '',
		sourceDescription: '',
		sourceLanguage: '',
		sourceType: '',
	} as const;
}

describe('buildDocumentUploadPayload', () => {
	it('keeps source language and type even when description is empty', () => {
		const payload = buildDocumentUploadPayload({
			...baseInput(),
			sourceLanguage: 'de',
			sourceType: 'government_document',
		});

		expect(payload.provenance.original_source).toEqual({
			language: 'de',
			source_type: 'government_document',
		});
	});

	it('omits original_source only when all original-source fields are empty', () => {
		const payload = buildDocumentUploadPayload(baseInput());

		expect(payload.provenance.original_source).toBeUndefined();
		expect(payload.provenance.acquisition).toMatchObject({
			collection_id: null,
			metadata: { no_collection_confirmed: true },
		});
	});
});
