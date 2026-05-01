import { extname } from 'node:path';
import { TextDecoder } from 'node:util';
import type {
	EmailExtractionResult,
	SourceFormatMetadata,
	SourceType,
	SpreadsheetExtractionResult,
	UrlFetchResult,
} from '@mulder/core';

export type SourceDetectionConfidence = 'magic' | 'extension' | 'content';
export type SupportedImageMediaType = 'image/png' | 'image/jpeg' | 'image/tiff';
export type SupportedTextMediaType = 'text/plain' | 'text/markdown' | 'text/x-markdown';
export type SupportedDocxMediaType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export type SupportedSpreadsheetMediaType =
	| 'text/csv'
	| 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export type SupportedEmailMediaType = 'message/rfc822' | 'application/vnd.ms-outlook';
export type SupportedUrlSnapshotMediaType = 'text/html';
export type SourceStorageExtension =
	| 'pdf'
	| 'png'
	| 'jpg'
	| 'tiff'
	| 'txt'
	| 'md'
	| 'docx'
	| 'csv'
	| 'xlsx'
	| 'eml'
	| 'msg'
	| 'html';

export interface SourceDetectionResult {
	sourceType: SourceType;
	confidence: SourceDetectionConfidence;
	mediaType?: string;
}

export interface ImageDimensions {
	width: number;
	height: number;
}

const PDF_SIGNATURE = Buffer.from('%PDF-', 'latin1');
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);
const TIFF_LITTLE_ENDIAN_SIGNATURE = Buffer.from([0x49, 0x49, 0x2a, 0x00]);
const TIFF_BIG_ENDIAN_SIGNATURE = Buffer.from([0x4d, 0x4d, 0x00, 0x2a]);
const ZIP_LOCAL_FILE_HEADER_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const OLE_COMPOUND_DOCUMENT_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

const PDF_MEDIA_TYPE = 'application/pdf';
const PNG_MEDIA_TYPE: SupportedImageMediaType = 'image/png';
const JPEG_MEDIA_TYPE: SupportedImageMediaType = 'image/jpeg';
const TIFF_MEDIA_TYPE: SupportedImageMediaType = 'image/tiff';
const PLAIN_TEXT_MEDIA_TYPE: SupportedTextMediaType = 'text/plain';
const MARKDOWN_MEDIA_TYPE: SupportedTextMediaType = 'text/markdown';
const X_MARKDOWN_MEDIA_TYPE: SupportedTextMediaType = 'text/x-markdown';
export const DOCX_MEDIA_TYPE: SupportedDocxMediaType =
	'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const CSV_MEDIA_TYPE: SupportedSpreadsheetMediaType = 'text/csv';
export const XLSX_MEDIA_TYPE: SupportedSpreadsheetMediaType =
	'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const EML_MEDIA_TYPE: SupportedEmailMediaType = 'message/rfc822';
export const MSG_MEDIA_TYPE: SupportedEmailMediaType = 'application/vnd.ms-outlook';
export const URL_SNAPSHOT_MEDIA_TYPE: SupportedUrlSnapshotMediaType = 'text/html';

const IMAGE_STORAGE_EXTENSIONS_BY_MEDIA_TYPE: Record<SupportedImageMediaType, SourceStorageExtension> = {
	'image/png': 'png',
	'image/jpeg': 'jpg',
	'image/tiff': 'tiff',
};

const TEXT_STORAGE_EXTENSIONS_BY_MEDIA_TYPE: Record<SupportedTextMediaType, SourceStorageExtension> = {
	'text/plain': 'txt',
	'text/markdown': 'md',
	'text/x-markdown': 'md',
};

const SPREADSHEET_STORAGE_EXTENSIONS_BY_MEDIA_TYPE: Record<SupportedSpreadsheetMediaType, SourceStorageExtension> = {
	'text/csv': 'csv',
	'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
};

const EMAIL_STORAGE_EXTENSIONS_BY_MEDIA_TYPE: Record<SupportedEmailMediaType, SourceStorageExtension> = {
	'message/rfc822': 'eml',
	'application/vnd.ms-outlook': 'msg',
};

const SUPPORTED_INGEST_EXTENSIONS = new Set([
	'.pdf',
	'.png',
	'.jpg',
	'.jpeg',
	'.tif',
	'.tiff',
	'.txt',
	'.md',
	'.markdown',
	'.docx',
	'.csv',
	'.xlsx',
	'.eml',
	'.msg',
]);

function hasPrefix(buffer: Buffer, signature: Buffer): boolean {
	return buffer.length >= signature.length && buffer.subarray(0, signature.length).equals(signature);
}

function getExtension(input: string): string {
	const withoutFragment = input.split('#')[0] ?? input;
	const withoutQuery = withoutFragment.split('?')[0] ?? withoutFragment;
	return extname(withoutQuery).toLowerCase();
}

function hasHttpUrlShape(input: string): boolean {
	return /^https?:\/\/\S+$/i.test(input.trim());
}

export function isUrlLikeInput(input: string): boolean {
	return /^[a-z][a-z0-9+.-]*:\/\/\S*$/i.test(input.trim());
}

export function isSupportedUrlInput(input: string): boolean {
	return detectSourceType(null, input)?.sourceType === 'url';
}

export function sanitizeUrlInputForDisplay(input: string): string {
	try {
		const url = new URL(input.trim());
		url.username = '';
		url.password = '';
		return url.toString();
	} catch {
		return 'URL input';
	}
}

export function normalizeUrlInput(input: string): string | null {
	try {
		const url = new URL(input.trim());
		if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname || url.username || url.password) {
			return null;
		}
		url.hash = '';
		return url.toString();
	} catch {
		return null;
	}
}

export function isSupportedIngestFilename(input: string): boolean {
	return SUPPORTED_INGEST_EXTENSIONS.has(getExtension(input));
}

export function isSupportedTextFilename(input: string): boolean {
	const extension = getExtension(input);
	return extension === '.txt' || extension === '.md' || extension === '.markdown';
}

export function isSupportedDocxFilename(input: string): boolean {
	return getExtension(input) === '.docx';
}

export function isSupportedSpreadsheetFilename(input: string): boolean {
	const extension = getExtension(input);
	return extension === '.csv' || extension === '.xlsx';
}

export function isSupportedEmailFilename(input: string): boolean {
	const extension = getExtension(input);
	return extension === '.eml' || extension === '.msg';
}

export function getOriginalExtension(input: string): string {
	return getExtension(input).replace(/^\./, '');
}

export function isSupportedImageMediaType(mediaType: string | undefined): mediaType is SupportedImageMediaType {
	return mediaType === PNG_MEDIA_TYPE || mediaType === JPEG_MEDIA_TYPE || mediaType === TIFF_MEDIA_TYPE;
}

export function isSupportedTextMediaType(mediaType: string | undefined): mediaType is SupportedTextMediaType {
	return (
		mediaType === PLAIN_TEXT_MEDIA_TYPE || mediaType === MARKDOWN_MEDIA_TYPE || mediaType === X_MARKDOWN_MEDIA_TYPE
	);
}

export function isSupportedDocxMediaType(mediaType: string | undefined): mediaType is SupportedDocxMediaType {
	return mediaType === DOCX_MEDIA_TYPE;
}

export function isSupportedSpreadsheetMediaType(
	mediaType: string | undefined,
): mediaType is SupportedSpreadsheetMediaType {
	return mediaType === CSV_MEDIA_TYPE || mediaType === XLSX_MEDIA_TYPE;
}

export function isSupportedEmailMediaType(mediaType: string | undefined): mediaType is SupportedEmailMediaType {
	return mediaType === EML_MEDIA_TYPE || mediaType === MSG_MEDIA_TYPE;
}

export function getCanonicalStorageExtensionForMediaType(mediaType: string | undefined): SourceStorageExtension | null {
	if (mediaType === PDF_MEDIA_TYPE) {
		return 'pdf';
	}
	if (isSupportedImageMediaType(mediaType)) {
		return IMAGE_STORAGE_EXTENSIONS_BY_MEDIA_TYPE[mediaType];
	}
	if (isSupportedTextMediaType(mediaType)) {
		return TEXT_STORAGE_EXTENSIONS_BY_MEDIA_TYPE[mediaType];
	}
	if (isSupportedDocxMediaType(mediaType)) {
		return 'docx';
	}
	if (isSupportedSpreadsheetMediaType(mediaType)) {
		return SPREADSHEET_STORAGE_EXTENSIONS_BY_MEDIA_TYPE[mediaType];
	}
	if (isSupportedEmailMediaType(mediaType)) {
		return EMAIL_STORAGE_EXTENSIONS_BY_MEDIA_TYPE[mediaType];
	}
	if (mediaType === URL_SNAPSHOT_MEDIA_TYPE) {
		return 'html';
	}
	return null;
}

export function getStorageExtensionForDetection(detection: SourceDetectionResult): SourceStorageExtension | null {
	return getCanonicalStorageExtensionForMediaType(detection.mediaType);
}

function readPngDimensions(buffer: Buffer): ImageDimensions | null {
	if (!hasPrefix(buffer, PNG_SIGNATURE) || buffer.length < 24) {
		return null;
	}

	const width = buffer.readUInt32BE(16);
	const height = buffer.readUInt32BE(20);
	return width > 0 && height > 0 ? { width, height } : null;
}

function isJpegStartOfFrameMarker(marker: number): boolean {
	return (
		(marker >= 0xc0 && marker <= 0xc3) ||
		(marker >= 0xc5 && marker <= 0xc7) ||
		(marker >= 0xc9 && marker <= 0xcb) ||
		(marker >= 0xcd && marker <= 0xcf)
	);
}

function readJpegDimensions(buffer: Buffer): ImageDimensions | null {
	if (!hasPrefix(buffer, JPEG_SIGNATURE)) {
		return null;
	}

	let offset = 2;
	while (offset + 4 < buffer.length) {
		if (buffer[offset] !== 0xff) {
			offset++;
			continue;
		}

		const marker = buffer[offset + 1];
		offset += 2;

		if (marker === 0xd9 || marker === 0xda) {
			break;
		}
		if (offset + 2 > buffer.length) {
			break;
		}

		const segmentLength = buffer.readUInt16BE(offset);
		if (segmentLength < 2 || offset + segmentLength > buffer.length) {
			break;
		}

		if (isJpegStartOfFrameMarker(marker) && segmentLength >= 7) {
			const height = buffer.readUInt16BE(offset + 3);
			const width = buffer.readUInt16BE(offset + 5);
			return width > 0 && height > 0 ? { width, height } : null;
		}

		offset += segmentLength;
	}

	return null;
}

export function readImageDimensions(buffer: Buffer, mediaType: string | undefined): ImageDimensions | null {
	if (mediaType === PNG_MEDIA_TYPE) {
		return readPngDimensions(buffer);
	}
	if (mediaType === JPEG_MEDIA_TYPE) {
		return readJpegDimensions(buffer);
	}
	return null;
}

export function buildImageFormatMetadata(
	buffer: Buffer,
	filename: string,
	mediaType: SupportedImageMediaType,
): SourceFormatMetadata {
	const metadata: SourceFormatMetadata = {
		media_type: mediaType,
		original_extension: getOriginalExtension(filename),
		byte_size: buffer.length,
	};
	const dimensions = readImageDimensions(buffer, mediaType);
	if (dimensions) {
		metadata.width = dimensions.width;
		metadata.height = dimensions.height;
		metadata.dimensions = dimensions;
	}
	return metadata;
}

export function decodeUtf8TextBuffer(buffer: Buffer): string | null {
	try {
		const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
		return decoder.decode(buffer);
	} catch {
		return null;
	}
}

export function isReadableText(buffer: Buffer): boolean {
	if (buffer.length === 0) {
		return false;
	}

	const decoded = decodeUtf8TextBuffer(buffer);
	if (decoded === null || decoded.length === 0) {
		return false;
	}

	for (let index = 0; index < decoded.length; index++) {
		const codePoint = decoded.codePointAt(index);
		if (codePoint === undefined) {
			continue;
		}
		if (codePoint > 0xffff) {
			index++;
		}
		if (codePoint === 0x00) {
			return false;
		}
		const isAllowedWhitespace = codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d;
		const isControlCharacter = codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f);
		if (isControlCharacter && !isAllowedWhitespace) {
			return false;
		}
	}

	const replacementCount = decoded.split('\uFFFD').length - 1;
	return replacementCount / decoded.length <= 0.05;
}

export function buildTextFormatMetadata(
	buffer: Buffer,
	filename: string,
	mediaType: SupportedTextMediaType,
): SourceFormatMetadata | null {
	const text = decodeUtf8TextBuffer(buffer);
	if (text === null || !isReadableText(buffer)) {
		return null;
	}

	return {
		media_type: mediaType === X_MARKDOWN_MEDIA_TYPE ? MARKDOWN_MEDIA_TYPE : mediaType,
		original_extension: getOriginalExtension(filename),
		byte_size: buffer.length,
		character_count: text.length,
		line_count: countTextLines(text),
		encoding: 'utf-8',
	};
}

export function buildDocxFormatMetadata(buffer: Buffer, filename: string): SourceFormatMetadata {
	return {
		media_type: DOCX_MEDIA_TYPE,
		original_extension: getOriginalExtension(filename),
		byte_size: buffer.length,
		office_format: 'docx',
		container: 'office_open_xml',
		extraction_engine: 'mammoth',
	};
}

export function buildSpreadsheetFormatMetadata(
	buffer: Buffer,
	filename: string,
	mediaType: SupportedSpreadsheetMediaType,
	extractionResult?: SpreadsheetExtractionResult,
): SourceFormatMetadata {
	const tabularFormat = mediaType === CSV_MEDIA_TYPE ? 'csv' : 'xlsx';
	const metadata: SourceFormatMetadata = {
		media_type: mediaType,
		original_extension: getOriginalExtension(filename),
		byte_size: buffer.length,
		tabular_format: tabularFormat,
		container: tabularFormat === 'csv' ? 'delimited_text' : 'office_open_xml',
		parser_engine: extractionResult?.parserEngine ?? (tabularFormat === 'csv' ? 'mulder-csv' : 'sheetjs-xlsx'),
		sheet_count: extractionResult?.sheetSummaries.length ?? (tabularFormat === 'csv' ? 1 : 0),
		sheet_names:
			extractionResult?.sheetSummaries.map((summary) => summary.sheetName) ?? (tabularFormat === 'csv' ? ['CSV'] : []),
		table_summaries:
			extractionResult?.sheetSummaries.map((summary) => ({
				sheet_name: summary.sheetName,
				row_count: summary.rowCount,
				column_count: summary.columnCount,
				row_group_count: summary.rowGroupCount,
			})) ?? [],
	};

	if (tabularFormat === 'csv') {
		metadata.encoding = 'utf-8';
		metadata.delimiter = extractionResult?.delimiter ?? detectCsvDelimiter(buffer);
	}

	return metadata;
}

export function buildEmailFormatMetadata(
	buffer: Buffer,
	filename: string,
	mediaType: SupportedEmailMediaType,
	extractionResult?: EmailExtractionResult,
): SourceFormatMetadata {
	const emailFormat = mediaType === EML_MEDIA_TYPE ? 'eml' : 'msg';
	const headers = extractionResult?.headers;
	return {
		media_type: mediaType,
		original_extension: getOriginalExtension(filename),
		byte_size: buffer.length,
		email_format: emailFormat,
		container: extractionResult?.container ?? (emailFormat === 'eml' ? 'rfc822_mime' : 'outlook_msg'),
		parser_engine: extractionResult?.parserEngine ?? (emailFormat === 'eml' ? 'mailparser' : 'msgreader'),
		message_id: headers?.messageId ?? null,
		thread_id: headers?.threadId ?? null,
		subject: headers?.subject ?? null,
		from: headers?.from.map((address) => address.display) ?? [],
		to: headers?.to.map((address) => address.display) ?? [],
		cc: headers?.cc.map((address) => address.display) ?? [],
		bcc: headers?.bcc.map((address) => address.display) ?? [],
		sent_at: headers?.sentAt ?? null,
		reply_to: headers?.replyTo.map((address) => address.display) ?? [],
		in_reply_to: headers?.inReplyTo ?? null,
		references: headers?.references ?? [],
		attachment_count: extractionResult?.attachments.length ?? 0,
		attachments:
			extractionResult?.attachments.map((attachment) => ({
				filename: attachment.filename,
				media_type: attachment.mediaType,
				size: attachment.sizeBytes,
				disposition: attachment.disposition,
				content_id: attachment.contentId,
				child_source_id: attachment.childSourceId ?? null,
			})) ?? [],
	};
}

export function buildUrlFormatMetadata(fetchResult: UrlFetchResult, title?: string): SourceFormatMetadata {
	return {
		original_url: fetchResult.originalUrl,
		normalized_url: fetchResult.normalizedUrl,
		final_url: fetchResult.finalUrl,
		fetch_date: fetchResult.fetchedAt,
		last_fetched: fetchResult.fetchedAt,
		http_status: fetchResult.httpStatus,
		content_type: fetchResult.contentType,
		etag: fetchResult.headers.etag ?? null,
		last_modified: fetchResult.headers['last-modified'] ?? null,
		byte_size: fetchResult.html.length,
		snapshot_media_type: URL_SNAPSHOT_MEDIA_TYPE,
		snapshot_encoding: fetchResult.snapshotEncoding ?? 'utf-8',
		parser_engine: 'mozilla-readability-jsdom-turndown',
		robots_allowed: fetchResult.robots.allowed,
		robots_url: fetchResult.robots.robotsUrl,
		redirect_count: fetchResult.redirectCount,
		title: title ?? null,
	};
}

function countTextLines(text: string): number {
	if (text.length === 0) {
		return 0;
	}
	const lines = text.split(/\r\n|\r|\n/);
	return lines.at(-1) === '' ? lines.length - 1 : lines.length;
}

function getTextSample(buffer: Buffer): string {
	return buffer.subarray(0, Math.min(buffer.length, 4096)).toString('utf8');
}

export function detectCsvDelimiter(buffer: Buffer): ',' | ';' | '\t' | null {
	if (!isReadableText(buffer)) {
		return null;
	}

	const lines = getTextSample(buffer)
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.slice(0, 5);

	if (lines.length < 2) {
		return null;
	}

	for (const delimiter of [',', ';', '\t'] as const) {
		const columnCounts = lines.map((line) => line.split(delimiter).length);
		const firstCount = columnCounts[0] ?? 0;
		if (firstCount > 1 && columnCounts.every((count) => count === firstCount)) {
			return delimiter;
		}
	}

	return null;
}

function hasDelimitedTextShape(buffer: Buffer): boolean {
	return detectCsvDelimiter(buffer) !== null;
}

function hasRfc822HeaderShape(buffer: Buffer): boolean {
	if (!isReadableText(buffer)) {
		return false;
	}

	const sample = getTextSample(buffer);
	const headerEnd = sample.search(/\r?\n\r?\n/);
	if (headerEnd <= 0) {
		return false;
	}
	const headers = sample.slice(0, headerEnd);
	if (!/^[!-9;-~]+:\s*.+$/m.test(headers)) {
		return false;
	}
	const hasFrom = /^From:\s.+$/im.test(headers);
	const hasDate = /^Date:\s.+$/im.test(headers);
	const hasSubject = /^Subject:\s.+$/im.test(headers);
	const hasMessageId = /^Message-ID:\s*<[^<>]+>$/im.test(headers);
	return hasFrom && (hasDate || hasSubject || hasMessageId);
}

function findEndOfCentralDirectoryOffset(buffer: Buffer): number {
	const signature = 0x06054b50;
	const maxCommentLength = 0xffff;
	const start = Math.max(0, buffer.length - (maxCommentLength + 22));

	for (let offset = buffer.length - 22; offset >= start; offset--) {
		if (buffer.readUInt32LE(offset) === signature) {
			return offset;
		}
	}

	return -1;
}

function listZipCentralDirectoryEntries(buffer: Buffer): string[] {
	const eocdOffset = findEndOfCentralDirectoryOffset(buffer);
	if (eocdOffset < 0 || eocdOffset + 22 > buffer.length) {
		return [];
	}

	const entryCount = buffer.readUInt16LE(eocdOffset + 10);
	const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);
	if (centralDirectoryOffset >= buffer.length) {
		return [];
	}

	const entries: string[] = [];
	let offset = centralDirectoryOffset;
	for (let index = 0; index < entryCount && offset + 46 <= buffer.length; index++) {
		if (buffer.readUInt32LE(offset) !== 0x02014b50) {
			break;
		}

		const filenameLength = buffer.readUInt16LE(offset + 28);
		const extraLength = buffer.readUInt16LE(offset + 30);
		const commentLength = buffer.readUInt16LE(offset + 32);
		const filenameStart = offset + 46;
		const filenameEnd = filenameStart + filenameLength;
		if (filenameEnd > buffer.length) {
			break;
		}

		entries.push(buffer.subarray(filenameStart, filenameEnd).toString('utf8'));
		offset = filenameEnd + extraLength + commentLength;
	}

	return entries;
}

export function isOfficeOpenXmlDocx(buffer: Buffer): boolean {
	if (!hasPrefix(buffer, ZIP_LOCAL_FILE_HEADER_SIGNATURE)) {
		return false;
	}

	const entries = new Set(listZipCentralDirectoryEntries(buffer).map((entry) => entry.replaceAll('\\', '/')));
	return entries.has('[Content_Types].xml') && entries.has('word/document.xml');
}

export function isOfficeOpenXmlSpreadsheet(buffer: Buffer): boolean {
	if (!hasPrefix(buffer, ZIP_LOCAL_FILE_HEADER_SIGNATURE)) {
		return false;
	}

	const entries = new Set(listZipCentralDirectoryEntries(buffer).map((entry) => entry.replaceAll('\\', '/')));
	return entries.has('[Content_Types].xml') && entries.has('xl/workbook.xml');
}

export function detectSourceType(
	buffer: Buffer | null | undefined,
	filenameOrInput: string,
): SourceDetectionResult | null {
	const extension = getExtension(filenameOrInput);

	if (!buffer && hasHttpUrlShape(filenameOrInput)) {
		return { sourceType: 'url', confidence: 'content' };
	}

	if (buffer) {
		if (hasPrefix(buffer, PDF_SIGNATURE)) {
			return { sourceType: 'pdf', confidence: 'magic', mediaType: PDF_MEDIA_TYPE };
		}

		if (hasPrefix(buffer, PNG_SIGNATURE)) {
			return { sourceType: 'image', confidence: 'magic', mediaType: PNG_MEDIA_TYPE };
		}

		if (hasPrefix(buffer, JPEG_SIGNATURE)) {
			return { sourceType: 'image', confidence: 'magic', mediaType: JPEG_MEDIA_TYPE };
		}

		if (hasPrefix(buffer, TIFF_LITTLE_ENDIAN_SIGNATURE) || hasPrefix(buffer, TIFF_BIG_ENDIAN_SIGNATURE)) {
			return { sourceType: 'image', confidence: 'magic', mediaType: TIFF_MEDIA_TYPE };
		}

		if (hasPrefix(buffer, ZIP_LOCAL_FILE_HEADER_SIGNATURE)) {
			if (isOfficeOpenXmlDocx(buffer)) {
				return { sourceType: 'docx', confidence: 'magic', mediaType: DOCX_MEDIA_TYPE };
			}
			if (extension === '.xlsx' && isOfficeOpenXmlSpreadsheet(buffer)) {
				return { sourceType: 'spreadsheet', confidence: 'magic', mediaType: XLSX_MEDIA_TYPE };
			}
			if (extension === '.xlsx') {
				return null;
			}
		}

		if (extension === '.msg' && hasPrefix(buffer, OLE_COMPOUND_DOCUMENT_SIGNATURE)) {
			return { sourceType: 'email', confidence: 'magic', mediaType: MSG_MEDIA_TYPE };
		}

		if (extension === '.csv' && hasDelimitedTextShape(buffer)) {
			return { sourceType: 'spreadsheet', confidence: 'content', mediaType: 'text/csv' };
		}

		if (extension === '.csv') {
			return null;
		}

		if (extension === '.eml' && hasRfc822HeaderShape(buffer)) {
			return { sourceType: 'email', confidence: 'content', mediaType: EML_MEDIA_TYPE };
		}

		if (extension === '.eml' || extension === '.msg') {
			return null;
		}

		if ((extension === '.txt' || extension === '.md' || extension === '.markdown') && isReadableText(buffer)) {
			return {
				sourceType: 'text',
				confidence: 'extension',
				mediaType: extension === '.md' || extension === '.markdown' ? 'text/markdown' : 'text/plain',
			};
		}

		if (isReadableText(buffer)) {
			return { sourceType: 'text', confidence: 'content', mediaType: 'text/plain' };
		}
	}

	return null;
}
