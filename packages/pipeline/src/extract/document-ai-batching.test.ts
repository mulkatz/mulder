import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import {
	buildPageBatches,
	canFallbackToNativeAfterEmptyDocumentAi,
	extractPdfPageBatch,
	parseDocumentAiResult,
} from './index.js';

describe('Document AI extraction batching helpers', () => {
	it('splits large PDFs into Document AI-safe page batches', () => {
		const batches = buildPageBatches(119, 30);

		expect(batches).toHaveLength(4);
		expect(batches[0]).toEqual(Array.from({ length: 30 }, (_, index) => index + 1));
		expect(batches[1]?.[0]).toBe(31);
		expect(batches[3]?.[0]).toBe(91);
		expect(batches[3]?.at(-1)).toBe(119);
		expect(batches.every((batch) => batch.length <= 30)).toBe(true);
	});

	it('maps selected Document AI pages back to original PDF page numbers', () => {
		const parsed = parseDocumentAiResult(
			{
				text: 'Page thirty one text\nPage thirty two text',
				pages: [
					{
						layout: { confidence: 0.8 },
						paragraphs: [
							{
								layout: {
									textAnchor: { textSegments: [{ startIndex: 0, endIndex: 20 }] },
									confidence: 0.8,
								},
							},
						],
					},
					{
						layout: { confidence: 0.9 },
						paragraphs: [
							{
								layout: {
									textAnchor: { textSegments: [{ startIndex: 21, endIndex: 41 }] },
									confidence: 0.9,
								},
							},
						],
					},
				],
			},
			[31, 32],
		);

		expect(parsed.map((page) => page.pageNumber)).toEqual([31, 32]);
		expect(parsed[0]?.text).toContain('Page thirty one text');
		expect(parsed[1]?.text).toContain('Page thirty two text');
	});

	it('creates a real partial PDF for each Document AI batch', async () => {
		const sourcePdf = await PDFDocument.create();
		for (let pageIndex = 0; pageIndex < 5; pageIndex += 1) {
			sourcePdf.addPage([200, 200]);
		}
		const sourceBuffer = Buffer.from(await sourcePdf.save());

		const batchBuffer = await extractPdfPageBatch(sourceBuffer, [2, 3, 4]);
		const batchPdf = await PDFDocument.load(batchBuffer);

		expect(batchPdf.getPageCount()).toBe(3);
	});

	it('does not fall back to native text when quality requires enhanced OCR', () => {
		expect(
			canFallbackToNativeAfterEmptyDocumentAi({
				sourceType: 'pdf',
				hasNativeText: true,
				nativeTextRatio: 0.98,
				nativeTextThreshold: 0.85,
				latestRecommendedPath: 'enhanced_ocr',
				preferDocumentAiForUncertainPdf: true,
			}),
		).toBe(false);

		expect(
			canFallbackToNativeAfterEmptyDocumentAi({
				sourceType: 'pdf',
				hasNativeText: true,
				nativeTextRatio: 0.98,
				nativeTextThreshold: 0.85,
				latestRecommendedPath: 'standard',
				preferDocumentAiForUncertainPdf: true,
			}),
		).toBe(true);
	});
});
