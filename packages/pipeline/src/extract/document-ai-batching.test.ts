import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import {
	backfillSparseDocumentAiPagesFromNative,
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

	it('parses Layout Parser documentLayout blocks when Document AI pages are absent', () => {
		const parsed = parseDocumentAiResult(
			{
				documentLayout: {
					blocks: [
						{
							textBlock: {
								text: 'Norman Mesa Nevada UFO report.',
								type: 'paragraph',
							},
							pageSpan: { pageStart: 1, pageEnd: 1 },
						},
						{
							textBlock: {
								text: 'Continuation on the following page.',
								type: 'paragraph',
							},
							pageSpan: { pageStart: 2, pageEnd: 2 },
						},
					],
				},
			},
			[31, 32],
		);

		expect(parsed.map((page) => page.pageNumber)).toEqual([31, 32]);
		expect(parsed[0]?.text).toContain('Norman Mesa');
		expect(parsed[1]?.text).toContain('following page');
		expect(parsed[0]?.blocks[0]?.type).toBe('paragraph');
	});

	it('preserves multi-page Layout Parser blocks across page spans', () => {
		const parsed = parseDocumentAiResult({
			documentLayout: {
				blocks: [
					{
						textBlock: {
							text: 'A long sighting report spans two scanned pages.',
							type: 'paragraph',
						},
						pageSpan: { pageStart: 1, pageEnd: 2 },
					},
				],
			},
		});

		expect(parsed.map((page) => page.pageNumber)).toEqual([1, 2]);
		expect(parsed[0]?.text).toContain('spans two scanned pages');
		expect(parsed[1]?.text).toContain('spans two scanned pages');
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

	it('backfills sparse Document AI pages from embedded PDF text without replacing useful pages', () => {
		const pages = [
			{
				pageNumber: 1,
				text: 'A complete Document AI page with enough extracted narrative text to keep.',
				confidence: 0.8,
				blocks: [],
			},
			{
				pageNumber: 2,
				text: 'REMARQUES-CONCLUSION',
				confidence: 0.8,
				blocks: [{ text: 'REMARQUES-CONCLUSION', type: 'paragraph', confidence: 0.8 }],
			},
		];
		const nativePageTexts = [
			'Short native text.',
			`REMARQUES-CONCLUSION\n\n${'Full paragraph text recovered from embedded PDF OCR. '.repeat(20)}`,
		];

		const replaced = backfillSparseDocumentAiPagesFromNative({ pages, nativePageTexts });

		expect(replaced).toBe(1);
		expect(pages[0]?.text).toContain('complete Document AI page');
		expect(pages[1]?.text).toContain('Full paragraph text recovered');
		expect(pages[1]?.confidence).toBeLessThan(0.8);
		expect(pages[1]?.blocks?.[0]?.type).toBe('native_text_backfill');
	});
});
