import { extname } from 'node:path';
import type { SourceType } from '@mulder/core';

export type SourceDetectionConfidence = 'magic' | 'extension' | 'content';

export interface SourceDetectionResult {
	sourceType: SourceType;
	confidence: SourceDetectionConfidence;
	mediaType?: string;
}

const PDF_SIGNATURE = Buffer.from('%PDF-', 'latin1');
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);
const TIFF_LITTLE_ENDIAN_SIGNATURE = Buffer.from([0x49, 0x49, 0x2a, 0x00]);
const TIFF_BIG_ENDIAN_SIGNATURE = Buffer.from([0x4d, 0x4d, 0x00, 0x2a]);
const ZIP_LOCAL_FILE_HEADER_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

const DOCX_MEDIA_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX_MEDIA_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

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

function isReadableText(buffer: Buffer): boolean {
	if (buffer.length === 0) {
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

	const decoded = sample.toString('utf8');
	const replacementCount = decoded.split('\uFFFD').length - 1;
	return replacementCount / decoded.length <= 0.05;
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
			return { sourceType: 'pdf', confidence: 'magic', mediaType: 'application/pdf' };
		}

		if (hasPrefix(buffer, PNG_SIGNATURE)) {
			return { sourceType: 'image', confidence: 'magic', mediaType: 'image/png' };
		}

		if (hasPrefix(buffer, JPEG_SIGNATURE)) {
			return { sourceType: 'image', confidence: 'magic', mediaType: 'image/jpeg' };
		}

		if (hasPrefix(buffer, TIFF_LITTLE_ENDIAN_SIGNATURE) || hasPrefix(buffer, TIFF_BIG_ENDIAN_SIGNATURE)) {
			return { sourceType: 'image', confidence: 'magic', mediaType: 'image/tiff' };
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

		if (extension === '.txt' || extension === '.md' || extension === '.markdown') {
			return {
				sourceType: 'text',
				confidence: 'extension',
				mediaType: extension === '.md' || extension === '.markdown' ? 'text/markdown' : 'text/plain',
			};
		}

		if (!extension && isReadableText(buffer)) {
			return { sourceType: 'text', confidence: 'content', mediaType: 'text/plain' };
		}
	}

	return null;
}
