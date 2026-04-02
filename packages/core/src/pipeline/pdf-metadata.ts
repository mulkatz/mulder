/**
 * Lightweight PDF metadata extractor using pdf-lib.
 *
 * Reads page count, title, author, dates, and other metadata from a PDF
 * buffer WITHOUT decompressing page content. pdf-lib parses the document
 * structure (xref, catalog, info dict) but does not render or decompress
 * page content streams.
 *
 * This is the PDF bomb gate: page count is extracted before any content
 * decompression (pdf-parse) happens. A PDF with 1M pages in a 1KB file
 * is rejected in milliseconds.
 *
 * @see docs/functional-spec.md §2.1 (pre-flight validation)
 */

import { PDFDocument } from 'pdf-lib';
import { createLogger } from '../shared/logger.js';

// ────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────

/** Metadata extracted from a PDF file without decompressing page content. */
export interface PdfMetadata {
	/** Total page count from the page tree root. */
	pageCount: number;
	/** PDF version from the header (e.g., "1.7"). */
	pdfVersion?: string;
	/** Document title from the Info dictionary. */
	title?: string;
	/** Author from the Info dictionary. */
	author?: string;
	/** Creator application from the Info dictionary. */
	creator?: string;
	/** PDF producer from the Info dictionary. */
	producer?: string;
	/** Creation date from the Info dictionary. */
	creationDate?: Date;
	/** Modification date from the Info dictionary. */
	modificationDate?: Date;
	/** Whether the PDF is encrypted. */
	encrypted?: boolean;
}

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

/**
 * Extracts the PDF version from the file header (first 20 bytes).
 * Returns undefined if the header doesn't match %PDF-x.y.
 */
function parsePdfVersion(buffer: Buffer): string | undefined {
	const header = buffer.subarray(0, 20).toString('latin1');
	return header.match(/%PDF-(\d+\.\d+)/)?.[1];
}

/**
 * Checks whether a PDF buffer contains an /Encrypt dictionary entry,
 * indicating the PDF is encrypted. Scans the trailer area only.
 */
function detectEncryption(buffer: Buffer): boolean {
	const tailStart = Math.max(0, buffer.length - 2048);
	const tail = buffer.subarray(tailStart).toString('latin1');
	return tail.includes('/Encrypt');
}

// ────────────────────────────────────────────────────────────
// Main extraction function
// ────────────────────────────────────────────────────────────

/**
 * Extracts PDF metadata from a raw buffer without decompressing page content.
 *
 * Uses pdf-lib to parse the document structure (xref, catalog, info dict).
 * pdf-lib does NOT render pages or decompress content streams — it only
 * reads the structural metadata needed for page count, info dict, etc.
 *
 * Returns partial results on corrupt/truncated/encrypted PDFs — never throws.
 * If page count cannot be determined, returns `pageCount: 0`.
 *
 * @param pdfBuffer - The raw PDF file content
 * @returns Extracted metadata (pageCount is always present, other fields optional)
 */
export async function extractPdfMetadata(pdfBuffer: Buffer): Promise<PdfMetadata> {
	const logger = createLogger({ level: process.env.MULDER_LOG_LEVEL ?? 'info' });

	const empty: PdfMetadata = { pageCount: 0 };

	if (pdfBuffer.length < 20) {
		logger.warn('PDF buffer too small for metadata extraction');
		return empty;
	}

	const pdfVersion = parsePdfVersion(pdfBuffer);
	const encrypted = detectEncryption(pdfBuffer);

	if (encrypted) {
		logger.debug('PDF is encrypted — returning partial metadata');
		return { pageCount: 0, pdfVersion, encrypted: true };
	}

	try {
		const doc = await PDFDocument.load(pdfBuffer, {
			updateMetadata: false,
			throwOnInvalidObject: false,
		});

		const pageCount = doc.getPageCount();
		const title = doc.getTitle() ?? undefined;
		const author = doc.getAuthor() ?? undefined;
		const creator = doc.getCreator() ?? undefined;
		const producer = doc.getProducer() ?? undefined;
		const creationDate = doc.getCreationDate() ?? undefined;
		const modificationDate = doc.getModificationDate() ?? undefined;

		logger.debug({ pageCount, pdfVersion, title, encrypted }, 'PDF metadata extraction complete');

		return {
			pageCount,
			pdfVersion,
			title,
			author,
			creator,
			producer,
			creationDate,
			modificationDate,
			encrypted: false,
		};
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		logger.warn({ err: error }, `PDF metadata extraction failed: ${message}`);
		return { pageCount: 0, pdfVersion, encrypted };
	}
}
