/**
 * Native text detection for PDF files.
 *
 * Analyzes PDFs to determine whether they contain extractable native text.
 * Returns a ratio of pages with text, which drives the Extract step's cost gate:
 * PDFs with high native text ratio can skip Document AI entirely.
 *
 * @see docs/specs/15_native_text_detection.spec.md
 * @see docs/functional-spec.md §2.1
 */

import { PDFParse } from 'pdf-parse';
import { createLogger } from '../shared/logger.js';

// ────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────

/** Result of native text detection on a PDF. */
export interface NativeTextResult {
	/** Whether any page has meaningful native text. */
	hasNativeText: boolean;
	/** Fraction of pages with native text (0-1). */
	nativeTextRatio: number;
	/** Total number of pages in the PDF. */
	pageCount: number;
	/** Number of pages with native text above the character threshold. */
	pagesWithText: number;
}

/** Options for native text detection. */
export interface NativeTextDetectOptions {
	/**
	 * Minimum characters per page to consider it "has text".
	 * Pages with fewer characters are treated as image-only.
	 * Default: 50 (filters out OCR noise, page numbers, headers).
	 */
	minCharsPerPage?: number;
}

// ────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────

const DEFAULT_MIN_CHARS_PER_PAGE = 50;

// ────────────────────────────────────────────────────────────
// Detection function
// ────────────────────────────────────────────────────────────

/**
 * Analyzes a PDF buffer to detect native (extractable) text.
 *
 * Uses pdf-parse to extract text per page. A page is considered
 * "has text" if it contains more than `minCharsPerPage` non-whitespace
 * characters (default: 50). This filters out page numbers, headers,
 * and OCR noise.
 *
 * If pdf-parse throws (corrupt PDF, empty buffer), the error is caught,
 * a warning is logged, and a zero-result is returned.
 *
 * @param pdfBuffer - The raw PDF file content
 * @param options - Detection options (character threshold)
 * @returns Native text detection result
 */
export async function detectNativeText(
	pdfBuffer: Buffer,
	options?: NativeTextDetectOptions,
): Promise<NativeTextResult> {
	const logger = createLogger({ level: process.env.MULDER_LOG_LEVEL ?? 'info' });
	const minChars = options?.minCharsPerPage ?? DEFAULT_MIN_CHARS_PER_PAGE;

	const zeroResult: NativeTextResult = {
		hasNativeText: false,
		nativeTextRatio: 0,
		pageCount: 0,
		pagesWithText: 0,
	};

	if (pdfBuffer.length === 0) {
		logger.warn('Empty PDF buffer provided to detectNativeText');
		return zeroResult;
	}

	try {
		const parser = new PDFParse({ data: new Uint8Array(pdfBuffer) });
		const textResult = await parser.getText({ pageJoiner: '' });

		const totalPages = textResult.total;

		if (totalPages === 0) {
			logger.warn('PDF has zero pages');
			await parser.destroy();
			return zeroResult;
		}

		let pagesWithText = 0;

		for (const page of textResult.pages) {
			const nonWhitespaceCount = page.text.replace(/\s/g, '').length;
			if (nonWhitespaceCount >= minChars) {
				pagesWithText++;
			}
		}

		const nativeTextRatio = pagesWithText / totalPages;

		await parser.destroy();

		const result: NativeTextResult = {
			hasNativeText: pagesWithText > 0,
			nativeTextRatio,
			pageCount: totalPages,
			pagesWithText,
		};

		logger.debug(
			{
				pageCount: totalPages,
				pagesWithText,
				nativeTextRatio,
				minCharsPerPage: minChars,
			},
			'Native text detection complete',
		);

		return result;
	} catch (error: unknown) {
		logger.warn({ err: error }, 'Failed to parse PDF for native text detection — treating as image-only');
		return zeroResult;
	}
}
