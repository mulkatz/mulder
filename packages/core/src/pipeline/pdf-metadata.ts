/**
 * Lightweight PDF metadata extractor — reads page count, title, author,
 * dates, and other Info dictionary fields from a PDF buffer WITHOUT
 * decompressing page content.
 *
 * This is the PDF bomb gate: page count is extracted from the trailer/xref
 * and page tree root (/Count) before any content decompression happens.
 * Only metadata-related structures (trailer, xref stream, ObjStm containing
 * the catalog and info dict) are decompressed — these are typically < 2KB.
 *
 * Handles both legacy xref tables and modern xref streams (/FlateDecode).
 *
 * @see docs/functional-spec.md §2.1 (pre-flight validation)
 */

import { inflateSync } from 'node:zlib';
import { createLogger } from '../shared/logger.js';

// ────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────

/** Metadata extracted from a PDF file without decompressing page content. */
export interface PdfMetadata {
	/** Total page count from the page tree root /Count. */
	pageCount: number;
	/** PDF version from the header (e.g., "1.7"). */
	pdfVersion?: string;
	/** Document title from /Info /Title. */
	title?: string;
	/** Author from /Info /Author. */
	author?: string;
	/** Creator application from /Info /Creator. */
	creator?: string;
	/** PDF producer from /Info /Producer. */
	producer?: string;
	/** Creation date from /Info /CreationDate. */
	creationDate?: Date;
	/** Modification date from /Info /ModDate. */
	modificationDate?: Date;
	/** Whether the PDF is encrypted. */
	encrypted?: boolean;
}

// ────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────

/** How many bytes to scan from the end to find startxref. */
const TAIL_SCAN_SIZE = 1024;

/** Maximum bytes to read when scanning for an object. */
const MAX_OBJECT_SCAN = 8192;

// ────────────────────────────────────────────────────────────
// PDF string parsing helpers
// ────────────────────────────────────────────────────────────

/**
 * Extracts the value of a PDF dictionary key from a raw string.
 * Handles integer values, object references (N 0 R), and parenthesized strings.
 */
function extractDictValue(dict: string, key: string): string | undefined {
	// Match /Key followed by value (number, reference, or parenthesized string)
	const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const re = new RegExp(`/${escaped}\\s+(.+?)(?=\\s*/[A-Z]|\\s*>>|\\s*$)`, 'm');
	const match = dict.match(re);
	if (!match) return undefined;
	return match[1].trim();
}

/**
 * Extracts an integer value from a PDF dictionary.
 */
function extractDictInt(dict: string, key: string): number | undefined {
	const val = extractDictValue(dict, key);
	if (!val) return undefined;
	const num = Number.parseInt(val, 10);
	return Number.isNaN(num) ? undefined : num;
}

/**
 * Extracts an object reference (e.g., "2 0 R") and returns the object number.
 */
function extractObjRef(dict: string, key: string): number | undefined {
	const val = extractDictValue(dict, key);
	if (!val) return undefined;
	const match = val.match(/^(\d+)\s+\d+\s+R/);
	return match ? Number.parseInt(match[1], 10) : undefined;
}

/**
 * Extracts a parenthesized PDF string value, handling escape sequences.
 */
function extractPdfString(dict: string, key: string): string | undefined {
	const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	// Match parenthesized strings with balanced parens
	const re = new RegExp(`/${escaped}\\s+\\(([^)]*)\\)`);
	const match = dict.match(re);
	if (match) return match[1];

	// Match hex strings <FEFF...>
	const hexRe = new RegExp(`/${escaped}\\s+<([0-9A-Fa-f]+)>`);
	const hexMatch = dict.match(hexRe);
	if (hexMatch) {
		return decodeHexString(hexMatch[1]);
	}
	return undefined;
}

/**
 * Decodes a hex-encoded PDF string. Handles UTF-16BE (FEFF BOM prefix).
 */
function decodeHexString(hex: string): string {
	const bytes = Buffer.from(hex, 'hex');
	// Check for UTF-16BE BOM (FEFF) — need to swap bytes for Node's utf16le decoder
	if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
		const content = bytes.subarray(2);
		// Swap byte pairs: BE → LE for Node's utf16le decoder
		for (let i = 0; i < content.length - 1; i += 2) {
			const tmp = content[i];
			content[i] = content[i + 1];
			content[i + 1] = tmp;
		}
		return content.toString('utf16le');
	}
	return bytes.toString('latin1');
}

/**
 * Parses a PDF date string: D:YYYYMMDDHHmmSSOHH'mm'
 */
function parsePdfDate(dateStr: string): Date | undefined {
	if (!dateStr) return undefined;
	const cleaned = dateStr.replace(/^D:/, '');
	const match = cleaned.match(/^(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(Z|[+-]\d{2}'?\d{2}'?)?/);
	if (!match) return undefined;

	const year = match[1];
	const month = match[2] ?? '01';
	const day = match[3] ?? '01';
	const hour = match[4] ?? '00';
	const minute = match[5] ?? '00';
	const second = match[6] ?? '00';
	const tz = match[7] ?? 'Z';

	let tzFormatted = 'Z';
	if (tz !== 'Z') {
		// Convert +05'30' → +05:30
		tzFormatted = tz.replace(/'/g, ':').replace(/:$/, '');
	}

	const iso = `${year}-${month}-${day}T${hour}:${minute}:${second}${tzFormatted}`;
	const date = new Date(iso);
	return Number.isNaN(date.getTime()) ? undefined : date;
}

// ────────────────────────────────────────────────────────────
// Low-level PDF structure parsing
// ────────────────────────────────────────────────────────────

/**
 * Finds the startxref offset from the tail of the PDF.
 */
function findStartXref(buffer: Buffer): number | undefined {
	const tailStart = Math.max(0, buffer.length - TAIL_SCAN_SIZE);
	const tail = buffer.subarray(tailStart).toString('latin1');

	const match = tail.match(/startxref\s+(\d+)\s+%%EOF/);
	if (!match) return undefined;
	return Number.parseInt(match[1], 10);
}

/**
 * Reads a dictionary block starting from a position in the buffer.
 * Returns the content between << and >> (handling nested dicts).
 */
function readDict(text: string, startPos: number): string | undefined {
	const dictStart = text.indexOf('<<', startPos);
	if (dictStart === -1) return undefined;

	let depth = 0;
	let i = dictStart;
	while (i < text.length - 1) {
		if (text[i] === '<' && text[i + 1] === '<') {
			depth++;
			i += 2;
		} else if (text[i] === '>' && text[i + 1] === '>') {
			depth--;
			if (depth === 0) {
				return text.substring(dictStart, i + 2);
			}
			i += 2;
		} else {
			i++;
		}
	}
	return undefined;
}

/**
 * Reads the stream content from a PDF object.
 * Returns the raw bytes between `stream\r?\n` and `endstream`.
 */
function readStream(buffer: Buffer, objOffset: number): Buffer | undefined {
	// Scan forward from object start to find "stream" keyword
	const scanEnd = Math.min(objOffset + MAX_OBJECT_SCAN, buffer.length);
	const text = buffer.subarray(objOffset, scanEnd).toString('latin1');

	const streamMatch = text.match(/stream\r?\n/);
	if (!streamMatch || streamMatch.index === undefined) return undefined;

	const streamDataStart = objOffset + streamMatch.index + streamMatch[0].length;

	// Find endstream
	const endMarker = Buffer.from('endstream');
	let endPos = buffer.indexOf(endMarker, streamDataStart);
	if (endPos === -1) return undefined;

	// Strip trailing \r\n before endstream
	if (endPos > 0 && buffer[endPos - 1] === 0x0a) endPos--;
	if (endPos > 0 && buffer[endPos - 1] === 0x0d) endPos--;

	return buffer.subarray(streamDataStart, endPos);
}

/**
 * Finds a standalone PDF object by number (e.g., "2 0 obj").
 * Uses a regex with word boundary to avoid matching "12 0 obj" when seeking "2 0 obj".
 * Returns the byte offset of the object start.
 */
function findObject(buffer: Buffer, objNum: number): number | undefined {
	const text = buffer.toString('latin1');
	const re = new RegExp(`(?:^|\\n|\\r)\\s*(${objNum} 0 obj)\\b`);
	const match = text.match(re);
	if (!match || match.index === undefined) return undefined;
	// Return the position of "N 0 obj", not the preceding newline
	return text.indexOf(match[1], match.index);
}

/**
 * Decompresses FlateDecode data. Returns undefined on failure.
 */
function decompress(data: Buffer): Buffer | undefined {
	try {
		return inflateSync(data);
	} catch {
		return undefined;
	}
}

// ────────────────────────────────────────────────────────────
// Object stream (ObjStm) parsing
// ────────────────────────────────────────────────────────────

/**
 * Parses an ObjStm (compressed object stream) and returns a map
 * of object number → dictionary text.
 */
function parseObjStm(buffer: Buffer, objStmOffset: number): Map<number, string> {
	const result = new Map<number, string>();

	const scanEnd = Math.min(objStmOffset + MAX_OBJECT_SCAN, buffer.length);
	const headerText = buffer.subarray(objStmOffset, scanEnd).toString('latin1');
	const dict = readDict(headerText, 0);
	if (!dict) return result;

	const n = extractDictInt(dict, 'N');
	const first = extractDictInt(dict, 'First');
	if (n === undefined || first === undefined) return result;

	// Read and decompress stream content
	const streamData = readStream(buffer, objStmOffset);
	if (!streamData) return result;

	const isCompressed = dict.includes('/FlateDecode');
	const content = isCompressed ? decompress(streamData) : streamData;
	if (!content) return result;

	const text = content.toString('latin1');

	// Parse the header: pairs of (objnum offset) repeated N times
	const headerPart = text.substring(0, first);
	const pairs = headerPart.trim().split(/\s+/).map(Number);

	const dataPart = text.substring(first);

	for (let i = 0; i < pairs.length - 1; i += 2) {
		const objNum = pairs[i];
		const offset = pairs[i + 1];
		// Next object's offset, or end of data
		const nextOffset = i + 3 < pairs.length ? pairs[i + 3] : dataPart.length;
		const objText = dataPart.substring(offset, nextOffset).trim();
		result.set(objNum, objText);
	}

	return result;
}

// ────────────────────────────────────────────────────────────
// Main extraction function
// ────────────────────────────────────────────────────────────

/**
 * Extracts PDF metadata from a raw buffer without decompressing page content.
 *
 * Reads the trailer, xref, catalog, and info dictionary to extract:
 * - Page count (from /Pages /Count)
 * - PDF version (from %PDF-x.y header)
 * - Title, author, creator, producer, dates (from /Info dictionary)
 *
 * Returns partial results on corrupt/truncated PDFs — never throws.
 * If page count cannot be determined, returns `pageCount: 0`.
 *
 * @param pdfBuffer - The raw PDF file content
 * @returns Extracted metadata (pageCount is always present, other fields optional)
 */
export function extractPdfMetadata(pdfBuffer: Buffer): PdfMetadata {
	const logger = createLogger({ level: process.env.MULDER_LOG_LEVEL ?? 'info' });

	const empty: PdfMetadata = { pageCount: 0 };

	if (pdfBuffer.length < 20) {
		logger.warn('PDF buffer too small for metadata extraction');
		return empty;
	}

	// 1. Extract PDF version from header
	const header = pdfBuffer.subarray(0, 20).toString('latin1');
	const versionMatch = header.match(/%PDF-(\d+\.\d+)/);
	const pdfVersion = versionMatch?.[1];

	// 2. Find startxref offset
	const xrefOffset = findStartXref(pdfBuffer);
	if (xrefOffset === undefined) {
		logger.warn('Could not find startxref in PDF');
		return { ...empty, pdfVersion };
	}

	// 3. Read the xref/trailer area
	const xrefEnd = Math.min(xrefOffset + MAX_OBJECT_SCAN, pdfBuffer.length);
	const xrefArea = pdfBuffer.subarray(xrefOffset, xrefEnd).toString('latin1');

	// Determine format: legacy "xref" table or modern xref stream object
	let trailerDict: string | undefined;

	if (xrefArea.startsWith('xref')) {
		// Legacy format: xref table followed by "trailer << ... >>"
		const trailerIdx = xrefArea.indexOf('trailer');
		if (trailerIdx !== -1) {
			trailerDict = readDict(xrefArea, trailerIdx);
		}
	} else {
		// Modern format: xref stream object "N 0 obj << ... >> stream"
		trailerDict = readDict(xrefArea, 0);
	}

	if (!trailerDict) {
		logger.warn('Could not parse PDF trailer dictionary');
		return { ...empty, pdfVersion };
	}

	// 4. Extract /Root and /Info object references
	const rootObjNum = extractObjRef(trailerDict, 'Root');
	const infoObjNum = extractObjRef(trailerDict, 'Info');
	const encrypted = trailerDict.includes('/Encrypt');

	// 5. Try to find objects — first as standalone, then in ObjStm
	let objStmEntries: Map<number, string> | undefined;

	// Check for ObjStm in the buffer — scan for "/Type /ObjStm" then
	// walk backwards to find the object start ("N 0 obj")
	const bufferText = pdfBuffer.toString('latin1');
	const objStmTypeIdx = bufferText.indexOf('/Type /ObjStm');
	if (objStmTypeIdx !== -1) {
		const before = bufferText.substring(Math.max(0, objStmTypeIdx - 200), objStmTypeIdx);
		const objMatch = before.match(/(\d+) 0 obj\s*$/m);
		if (objMatch && objMatch.index !== undefined) {
			const objStmOffset = Math.max(0, objStmTypeIdx - 200) + objMatch.index;
			objStmEntries = parseObjStm(pdfBuffer, objStmOffset);
		}
	}

	// 6. Extract page count from Root → Pages → Count
	let pageCount = 0;

	if (rootObjNum !== undefined) {
		let catalogDict: string | undefined;

		// Try standalone object first
		const rootOffset = findObject(pdfBuffer, rootObjNum);
		if (rootOffset !== undefined) {
			catalogDict = readDict(bufferText, rootOffset);
		}

		// Fall back to ObjStm
		if (!catalogDict && objStmEntries) {
			const entry = objStmEntries.get(rootObjNum);
			if (entry) {
				catalogDict = entry.includes('<<') ? readDict(entry, 0) : `<< ${entry} >>`;
			}
		}

		if (catalogDict) {
			const pagesObjNum = extractObjRef(catalogDict, 'Pages');
			if (pagesObjNum !== undefined) {
				// Try standalone
				let pagesDict: string | undefined;
				const pagesOffset = findObject(pdfBuffer, pagesObjNum);
				if (pagesOffset !== undefined) {
					pagesDict = readDict(bufferText, pagesOffset);
				}

				// Fall back to ObjStm
				if (!pagesDict && objStmEntries) {
					const entry = objStmEntries.get(pagesObjNum);
					if (entry) {
						pagesDict = entry.includes('<<') ? readDict(entry, 0) : `<< ${entry} >>`;
					}
				}

				if (pagesDict) {
					const count = extractDictInt(pagesDict, 'Count');
					if (count !== undefined) {
						pageCount = count;
					}
				}
			}
		}
	}

	// 7. Extract Info dictionary metadata
	let title: string | undefined;
	let author: string | undefined;
	let creator: string | undefined;
	let producer: string | undefined;
	let creationDate: Date | undefined;
	let modificationDate: Date | undefined;

	if (infoObjNum !== undefined) {
		let infoDict: string | undefined;

		// Try standalone
		const infoOffset = findObject(pdfBuffer, infoObjNum);
		if (infoOffset !== undefined) {
			infoDict = readDict(bufferText, infoOffset);
		}

		// Fall back to ObjStm
		if (!infoDict && objStmEntries) {
			const entry = objStmEntries.get(infoObjNum);
			if (entry) {
				infoDict = entry.includes('<<') ? readDict(entry, 0) : `<< ${entry} >>`;
			}
		}

		if (infoDict) {
			title = extractPdfString(infoDict, 'Title');
			author = extractPdfString(infoDict, 'Author');
			creator = extractPdfString(infoDict, 'Creator');
			producer = extractPdfString(infoDict, 'Producer');
			creationDate = parsePdfDate(extractPdfString(infoDict, 'CreationDate') ?? '');
			modificationDate = parsePdfDate(extractPdfString(infoDict, 'ModDate') ?? '');
		}
	}

	logger.debug(
		{ pageCount, pdfVersion, hasInfo: infoObjNum !== undefined, encrypted },
		'PDF metadata extraction complete',
	);

	return {
		pageCount,
		pdfVersion,
		title,
		author,
		creator,
		producer,
		creationDate,
		modificationDate,
		encrypted,
	};
}
