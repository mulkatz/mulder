import type { MulderConfig } from '@mulder/core';
import { describe, expect, it } from 'vitest';
import { pdfNativeTextMeetsSkipThreshold } from './index.js';

describe('PDF native text Document AI skip routing', () => {
	const config = {
		document_quality: {
			extraction_routing: {
				pdf_skip_document_ai_min_native_text_ratio: 0.85,
				pdf_skip_document_ai_min_pages_with_text_ratio: 0.95,
				pdf_skip_document_ai_min_language_confidence: 0.75,
			},
		},
	} as MulderConfig;

	it('does not skip Document AI when language confidence is zero despite high text coverage', () => {
		expect(
			pdfNativeTextMeetsSkipThreshold({
				config,
				nativeTextRatio: 0.97,
				pagesWithTextRatio: 1,
				languageConfidence: 0,
			}),
		).toBe(false);
	});

	it('skips Document AI only when all configured quality thresholds pass', () => {
		expect(
			pdfNativeTextMeetsSkipThreshold({
				config,
				nativeTextRatio: 0.97,
				pagesWithTextRatio: 1,
				languageConfidence: 0.9,
			}),
		).toBe(true);
	});
});
