import { extname } from 'node:path';
import { TextDecoder } from 'node:util';
import type { SourceFormatMetadata, SourceType } from '@mulder/core';

export type SourceDetectionConfidence = 'magic' | 'extension' | 'content';
export type SupportedImageMediaType = 'image/png' | 'image/jpeg' | 'image/tiff';
export type SupportedTextMediaType = 'text/plain' | 'text/markdown' | 'text/x-markdown';
export type SourceStorageExtension = 'pdf' | 'png' | 'jpg' | 'tiff' | 'txt' | 'md';

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

const PDF_MEDIA_TYPE = 'application/pdf';
const PNG_MEDIA_TYPE: SupportedImageMediaType = 'image/png';
const JPEG_MEDIA_TYPE: SupportedImageMediaType = 'image/jpeg';
const TIFF_MEDIA_TYPE: SupportedImageMediaType = 'image/tiff';
const PLAIN_TEXT_MEDIA_TYPE: SupportedTextMediaType = 'text/plain';
const MARKDOWN_MEDIA_TYPE: SupportedTextMediaType = 'text/markdown';
const X_MARKDOWN_MEDIA_TYPE: SupportedTextMediaType = 'text/x-markdown';
const DOCX_MEDIA_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX_MEDIA_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

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

export function isSupportedIngestFilename(input: string): boolean {
	return SUPPORTED_INGEST_EXTENSIONS.has(getExtension(input));
}

export function isSupportedTextFilename(input: string): boolean {
	const extension = getExtension(input);
	return extension === '.txt' || extension === '.md' || extension === '.markdown';
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

	const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
	let suspiciousControlBytes = 0;
	for (const byte of sample) {
		if (byte === 0x00) {
			return false;
		}
		const isAllowedWhitespace = byte === 0x09 || byte === 0x0a || byte === 0x0d;
		if (byte < 0x20 && !isAllowedWhitespace) {
			suspiciousControlBytes++;
		}
	}

	if (suspiciousControlBytes / sample.length > 0.02) {
		return false;
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

function hasDelimitedTextShape(buffer: Buffer): boolean {
	if (!isReadableText(buffer)) {
		return false;
	}

	const lines = getTextSample(buffer)
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.slice(0, 5);

	if (lines.length < 2) {
		return false;
	}

	return [',', ';', '\t'].some((delimiter) => {
		const delimitedLines = lines.filter((line) => line.split(delimiter).length > 1);
		return delimitedLines.length >= 2;
	});
}

function hasRfc822HeaderShape(buffer: Buffer): boolean {
	if (!isReadableText(buffer)) {
		return false;
	}

	const sample = getTextSample(buffer);
	return /^From:\s.+$/im.test(sample) && /^Date:\s.+$/im.test(sample) && /^Subject:\s.+$/im.test(sample);
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
			if (extension === '.docx') {
				return { sourceType: 'docx', confidence: 'magic', mediaType: DOCX_MEDIA_TYPE };
			}
			if (extension === '.xlsx') {
				return { sourceType: 'spreadsheet', confidence: 'magic', mediaType: XLSX_MEDIA_TYPE };
			}
		}

		if (extension === '.csv' && hasDelimitedTextShape(buffer)) {
			return { sourceType: 'spreadsheet', confidence: 'content', mediaType: 'text/csv' };
		}

		if (hasRfc822HeaderShape(buffer)) {
			return { sourceType: 'email', confidence: 'content', mediaType: 'message/rfc822' };
		}

		if ((extension === '.eml' || extension === '.msg') && isReadableText(buffer)) {
			return { sourceType: 'email', confidence: 'extension', mediaType: 'message/rfc822' };
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
