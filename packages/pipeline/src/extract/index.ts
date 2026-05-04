/**
 * Extract pipeline step — the second pipeline step that takes ingested PDF
 * sources and produces structured layout data with spatial information and
 * page images to GCS.
 *
 * Three extraction paths based on native text ratio:
 * - Native text path (ratio >= threshold): local pdf-parse + pdf-to-img
 * - Document AI path (ratio < threshold): Document AI Layout Parser
 * - Gemini Vision fallback: corrects low-confidence Document AI pages
 *
 * @see docs/specs/19_extract_step.spec.md
 * @see docs/functional-spec.md §2.2
 */

import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type {
	DocumentAiResult,
	EmailAttachmentSummary,
	EmailExtractionResult,
	Logger,
	MulderConfig,
	Services,
	SourceFormatMetadata,
	SpreadsheetExtractionResult,
	SpreadsheetSheet,
	SpreadsheetTabularFormat,
	StepError,
	UrlEntityHint,
	UrlExtractionResult,
} from '@mulder/core';
import {
	createChildLogger,
	createSource,
	createStory,
	detectNativeText,
	EXTRACT_ERROR_CODES,
	ExtractError,
	extractPdfMetadata,
	findSourceByHash,
	findSourceById,
	getStepConfigHash,
	renderPrompt,
	resetPipelineStep,
	updateSource,
	updateSourceStatus,
	upsertSourceStep,
} from '@mulder/core';
import { PDFParse } from 'pdf-parse';
import type pg from 'pg';
import {
	buildDocxFormatMetadata,
	buildEmailFormatMetadata,
	buildImageFormatMetadata,
	buildSpreadsheetFormatMetadata as buildIngestSpreadsheetFormatMetadata,
	buildTextFormatMetadata,
	decodeUtf8TextBuffer,
	detectSourceType,
	getStorageExtensionForDetection,
	isReadableText,
	isSupportedEmailMediaType,
	isSupportedImageMediaType,
	isSupportedSpreadsheetMediaType,
	isSupportedTextFilename,
	isSupportedTextMediaType,
} from '../ingest/source-type.js';
import { layoutToMarkdown } from './layout-to-markdown.js';
import { assertFallbackOnlySupported, requireExtractRoute } from './source-routing.js';
import type { ExtractInput, ExtractionData, ExtractResult, LayoutBlock, LayoutDocument, LayoutPage } from './types.js';

export { layoutToMarkdown } from './layout-to-markdown.js';
export type {
	ExtractRouteKind,
	ExtractSourceRoute,
	LayoutExtractRoute,
	LayoutExtractSourceType,
	PrestructuredExtractRoute,
	PrestructuredExtractSourceType,
} from './source-routing.js';
export {
	assertFallbackOnlySupported,
	EXTRACT_LAYOUT_SOURCE_TYPES,
	EXTRACT_PRESTRUCTURED_SOURCE_TYPES,
	EXTRACT_SOURCE_TYPES,
	isAcceptedExtractSourceType,
	requireExtractRoute,
	resolveExtractRoute,
} from './source-routing.js';
export type {
	ExtractInput,
	ExtractionData,
	ExtractionMethod,
	ExtractResult,
	LayoutDocument,
	PageExtraction,
	PrimaryExtractionMethod,
} from './types.js';

// ────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────

const STEP_NAME = 'extract';

// ────────────────────────────────────────────────────────────
// Native text extraction (Path A)
// ────────────────────────────────────────────────────────────

/**
 * Extracts text per page using pdf-parse. Returns an array of page texts.
 */
async function extractNativeText(pdfBuffer: Buffer, logger: Logger): Promise<string[]> {
	const parser = new PDFParse({ data: new Uint8Array(pdfBuffer) });
	const textResult = await parser.getText({ pageJoiner: '' });
	const pageTexts = textResult.pages.map((p) => p.text);
	await parser.destroy();
	logger.debug({ pageCount: pageTexts.length }, 'Native text extracted');
	return pageTexts;
}

/**
 * Renders page images from a PDF buffer using pdfjs-dist + @napi-rs/canvas.
 * Returns an array of PNG buffers, one per page.
 *
 * Both dependencies ship prebuilt binaries with no system-library
 * compilation, so this works on macOS arm64, Linux, and CI without any
 * `brew install` or `apt-get install` step.
 *
 * If rendering fails for an unexpected reason, the function logs the error
 * and returns an empty array so downstream steps can continue with
 * text-only processing.
 */
async function renderPageImages(pdfBuffer: Buffer, logger: Logger): Promise<Buffer[]> {
	try {
		// Dynamic imports keep pdfjs-dist out of the cold-start path for
		// callers that never reach this branch.
		const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
		const { createCanvas } = await import('@napi-rs/canvas');

		const loadingTask = pdfjs.getDocument({
			data: new Uint8Array(pdfBuffer),
			useSystemFonts: true,
			isEvalSupported: false,
		});
		const doc = await loadingTask.promise;

		const pages: Buffer[] = [];
		const scale = 2;

		for (let i = 1; i <= doc.numPages; i++) {
			const page = await doc.getPage(i);
			const viewport = page.getViewport({ scale });
			const width = Math.ceil(viewport.width);
			const height = Math.ceil(viewport.height);

			// @napi-rs/canvas implements the HTMLCanvasElement contract at
			// runtime; the structural cast lets pdfjs-dist render into it
			// without pulling DOM types into the tsconfig.
			const napiCanvas = createCanvas(width, height);
			// biome-ignore lint/suspicious/noExplicitAny: cross-runtime canvas type bridge
			await page.render({ canvas: napiCanvas as any, viewport }).promise;

			pages.push(napiCanvas.toBuffer('image/png'));
			page.cleanup();
		}

		await doc.cleanup();
		await doc.destroy();

		logger.debug({ pageCount: pages.length }, 'Page images rendered via pdfjs-dist + @napi-rs/canvas');
		return pages;
	} catch (error: unknown) {
		logger.warn({ err: error }, 'PDF page rendering failed — downstream steps will run text-only');
		return [];
	}
}

async function renderImagePageImage(imageBuffer: Buffer, mediaType: string, logger: Logger): Promise<Buffer | null> {
	if (mediaType === 'image/png') {
		return imageBuffer;
	}

	if (mediaType !== 'image/jpeg') {
		return null;
	}

	try {
		const { createCanvas, loadImage } = await import('@napi-rs/canvas');
		const image = await loadImage(imageBuffer);
		const canvas = createCanvas(image.width, image.height);
		const context = canvas.getContext('2d');
		context.drawImage(image, 0, 0);
		return canvas.toBuffer('image/png');
	} catch (error: unknown) {
		logger.warn({ err: error }, 'Image preview rendering failed — continuing without page image');
		return null;
	}
}

function readStoredMediaType(formatMetadata: Record<string, unknown>): string | null {
	return typeof formatMetadata.media_type === 'string' ? formatMetadata.media_type : null;
}

function resolveSourceMediaType(
	source: { filename: string; sourceType: string; formatMetadata: Record<string, unknown> },
	buffer: Buffer,
): string | null {
	if (source.sourceType === 'pdf') {
		return 'application/pdf';
	}

	const storedMediaType = readStoredMediaType(source.formatMetadata);
	if (storedMediaType && isSupportedImageMediaType(storedMediaType)) {
		return storedMediaType;
	}

	const detection = detectSourceType(buffer, source.filename);
	if (detection?.sourceType === 'image' && isSupportedImageMediaType(detection.mediaType)) {
		return detection.mediaType;
	}

	return null;
}

// ────────────────────────────────────────────────────────────
// Text extraction helpers
// ────────────────────────────────────────────────────────────

interface TextStoryMetadataJson {
	id: string;
	document_id: string;
	title: string;
	subtitle: null;
	language: string;
	category: string;
	pages: number[];
	date_references: string[];
	geographic_references: string[];
	extraction_confidence: number;
	source_type: 'text';
	is_markdown: boolean;
}

function normalizeMarkdownLineEndings(text: string): string {
	return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function titleFromFilename(filename: string): string {
	const basename = filename.split(/[\\/]/).pop() ?? filename;
	const withoutExtension = basename.replace(/\.[^.]+$/, '');
	const spaced = withoutExtension.replace(/[-_]+/g, ' ').trim();
	return spaced.length > 0 ? spaced : 'Untitled text source';
}

function titleFromFilenameWithFallback(filename: string, fallback: string): string {
	const basename = filename.split(/[\\/]/).pop() ?? filename;
	const withoutExtension = basename.replace(/\.[^.]+$/, '');
	const spaced = withoutExtension.replace(/[-_]+/g, ' ').trim();
	return spaced.length > 0 ? spaced : fallback;
}

function stripMarkdownInlineSyntax(value: string): string {
	return value
		.replace(/[`*_~[\]()]/g, '')
		.replace(/\s+/g, ' ')
		.trim();
}

function deriveMarkdownTitle(markdown: string, filename: string, fallback = 'Untitled text source'): string {
	const heading = markdown.match(/^#{1,6}\s+(.+?)\s*#*\s*$/m);
	if (!heading?.[1]) {
		return titleFromFilenameWithFallback(filename, fallback);
	}
	const title = stripMarkdownInlineSyntax(heading[1]);
	return title.length > 0 ? title : titleFromFilenameWithFallback(filename, fallback);
}

function escapePlainTextForMarkdown(text: string): string {
	return text
		.split('\n')
		.map((line) => line.replace(/([\\`*_{}[\]<>()#+.!|-])/g, '\\$1'))
		.join('\n');
}

function isMarkdownMediaType(mediaType: unknown): boolean {
	return mediaType === 'text/markdown' || mediaType === 'text/x-markdown';
}

function buildTextStoryMetadata(input: {
	storyId: string;
	sourceId: string;
	title: string;
	language: string;
	isMarkdown: boolean;
}): TextStoryMetadataJson {
	return {
		id: input.storyId,
		document_id: input.sourceId,
		title: input.title,
		subtitle: null,
		language: input.language,
		category: 'document',
		pages: [],
		date_references: [],
		geographic_references: [],
		extraction_confidence: 1.0,
		source_type: 'text',
		is_markdown: input.isMarkdown,
	};
}

async function extractTextSource(input: {
	sourceId: string;
	filename: string;
	storagePath: string;
	formatMetadata: Record<string, unknown>;
	config: MulderConfig;
	services: Services;
	pool: pg.Pool;
	stepConfigHash: string;
	logger: Logger;
}): Promise<ExtractionData> {
	let buffer: Buffer;
	try {
		buffer = await input.services.storage.download(input.storagePath);
	} catch (cause: unknown) {
		throw new ExtractError(
			`Failed to download text source original for source ${input.sourceId}`,
			EXTRACT_ERROR_CODES.EXTRACT_STORAGE_FAILED,
			{ cause, context: { sourceId: input.sourceId, storagePath: input.storagePath } },
		);
	}

	const decoded = decodeUtf8TextBuffer(buffer);
	if (decoded === null || !isReadableText(buffer)) {
		throw new ExtractError(
			`Text source is not readable UTF-8: ${input.sourceId}`,
			EXTRACT_ERROR_CODES.EXTRACT_NATIVE_TEXT_FAILED,
			{ context: { sourceId: input.sourceId, storagePath: input.storagePath } },
		);
	}

	const normalizedText = normalizeMarkdownLineEndings(decoded);
	const isMarkdown = isMarkdownMediaType(input.formatMetadata.media_type) || /\.m(?:d|arkdown)$/i.test(input.filename);
	const title = isMarkdown ? deriveMarkdownTitle(normalizedText, input.filename) : titleFromFilename(input.filename);
	const markdown = isMarkdown ? normalizedText : `# ${title}\n\n${escapePlainTextForMarkdown(normalizedText)}`;
	const language = input.config.project.supported_locales[0] ?? 'en';
	const storyId = randomUUID();
	const markdownUri = `segments/${input.sourceId}/${storyId}.md`;
	const metadataUri = `segments/${input.sourceId}/${storyId}.meta.json`;
	const storyMetadata = buildTextStoryMetadata({
		storyId,
		sourceId: input.sourceId,
		title,
		language,
		isMarkdown,
	});

	try {
		await input.services.storage.upload(markdownUri, markdown, 'text/markdown');
		await input.services.storage.upload(metadataUri, JSON.stringify(storyMetadata, null, 2), 'application/json');
	} catch (cause: unknown) {
		throw new ExtractError(
			`Failed to write text story artifacts for source ${input.sourceId}`,
			EXTRACT_ERROR_CODES.EXTRACT_STORAGE_FAILED,
			{ cause, context: { sourceId: input.sourceId, markdownUri, metadataUri } },
		);
	}

	await createStory(input.pool, {
		id: storyId,
		sourceId: input.sourceId,
		title,
		language,
		category: 'document',
		gcsMarkdownUri: markdownUri,
		gcsMetadataUri: metadataUri,
		extractionConfidence: 1.0,
		metadata: {
			source_type: 'text',
			is_markdown: isMarkdown,
			original_storage_path: input.storagePath,
		},
	});

	await updateSourceStatus(input.pool, input.sourceId, 'extracted');
	await upsertSourceStep(input.pool, {
		sourceId: input.sourceId,
		stepName: STEP_NAME,
		status: 'completed',
		configHash: input.stepConfigHash,
	});

	input.logger.debug({ storyId, markdownUri, isMarkdown }, 'Text source extracted into story Markdown');

	return {
		sourceId: input.sourceId,
		layoutUri: null,
		pageImageUris: [],
		pageCount: 0,
		primaryMethod: 'text',
		pages: [],
		visionFallbackCount: 0,
		visionFallbackCapped: false,
	};
}

interface DocxStoryMetadataJson {
	id: string;
	document_id: string;
	title: string;
	subtitle: null;
	language: string;
	category: string;
	pages: number[];
	date_references: string[];
	geographic_references: string[];
	extraction_confidence: number;
	source_type: 'docx';
	office_format: 'docx';
	extraction_engine: string;
	parser_messages: Array<{ type: string; message: string }>;
}

function buildDocxStoryMetadata(input: {
	storyId: string;
	sourceId: string;
	title: string;
	language: string;
	extractionEngine: string;
	parserMessages: Array<{ type: string; message: string }>;
}): DocxStoryMetadataJson {
	return {
		id: input.storyId,
		document_id: input.sourceId,
		title: input.title,
		subtitle: null,
		language: input.language,
		category: 'document',
		pages: [],
		date_references: [],
		geographic_references: [],
		extraction_confidence: 1.0,
		source_type: 'docx',
		office_format: 'docx',
		extraction_engine: input.extractionEngine,
		parser_messages: input.parserMessages,
	};
}

async function extractDocxSource(input: {
	sourceId: string;
	filename: string;
	storagePath: string;
	config: MulderConfig;
	services: Services;
	pool: pg.Pool;
	stepConfigHash: string;
	logger: Logger;
}): Promise<ExtractionData> {
	let buffer: Buffer;
	try {
		buffer = await input.services.storage.download(input.storagePath);
	} catch (cause: unknown) {
		throw new ExtractError(
			`Failed to download DOCX source original for source ${input.sourceId}`,
			EXTRACT_ERROR_CODES.EXTRACT_STORAGE_FAILED,
			{ cause, context: { sourceId: input.sourceId, storagePath: input.storagePath } },
		);
	}

	let officeResult: Awaited<ReturnType<Services['officeDocuments']['extractDocx']>>;
	try {
		officeResult = await input.services.officeDocuments.extractDocx(buffer, input.sourceId);
	} catch (cause: unknown) {
		throw new ExtractError(
			`DOCX extraction failed for source ${input.sourceId}`,
			EXTRACT_ERROR_CODES.EXTRACT_OFFICE_DOCUMENT_FAILED,
			{ cause, context: { sourceId: input.sourceId, storagePath: input.storagePath } },
		);
	}

	const markdown = normalizeMarkdownLineEndings(officeResult.markdown);
	const title = officeResult.title ?? deriveMarkdownTitle(markdown, input.filename, 'Untitled DOCX source');
	const language = input.config.project.supported_locales[0] ?? 'en';
	const storyId = randomUUID();
	const markdownUri = `segments/${input.sourceId}/${storyId}.md`;
	const metadataUri = `segments/${input.sourceId}/${storyId}.meta.json`;
	const storyMetadata = buildDocxStoryMetadata({
		storyId,
		sourceId: input.sourceId,
		title,
		language,
		extractionEngine: officeResult.extractionEngine,
		parserMessages: officeResult.messages,
	});

	try {
		await input.services.storage.upload(markdownUri, markdown, 'text/markdown');
		await input.services.storage.upload(metadataUri, JSON.stringify(storyMetadata, null, 2), 'application/json');
	} catch (cause: unknown) {
		throw new ExtractError(
			`Failed to write DOCX story artifacts for source ${input.sourceId}`,
			EXTRACT_ERROR_CODES.EXTRACT_STORAGE_FAILED,
			{ cause, context: { sourceId: input.sourceId, markdownUri, metadataUri } },
		);
	}

	await createStory(input.pool, {
		id: storyId,
		sourceId: input.sourceId,
		title,
		language,
		category: 'document',
		gcsMarkdownUri: markdownUri,
		gcsMetadataUri: metadataUri,
		extractionConfidence: 1.0,
		metadata: {
			source_type: 'docx',
			office_format: 'docx',
			extraction_engine: officeResult.extractionEngine,
			original_storage_path: input.storagePath,
		},
	});

	await updateSourceStatus(input.pool, input.sourceId, 'extracted');
	await upsertSourceStep(input.pool, {
		sourceId: input.sourceId,
		stepName: STEP_NAME,
		status: 'completed',
		configHash: input.stepConfigHash,
	});

	input.logger.debug(
		{ storyId, markdownUri, warningCount: officeResult.messages.length },
		'DOCX source extracted into story Markdown',
	);

	return {
		sourceId: input.sourceId,
		layoutUri: null,
		pageImageUris: [],
		pageCount: 0,
		primaryMethod: 'docx',
		pages: [],
		visionFallbackCount: 0,
		visionFallbackCapped: false,
	};
}

// ────────────────────────────────────────────────────────────
// Spreadsheet extraction helpers
// ────────────────────────────────────────────────────────────

type SpreadsheetHintType = 'email' | 'url' | 'date' | 'identifier' | 'person_name' | 'organization' | 'location';
type SpreadsheetHintSource = 'header' | 'value' | 'header_value';

interface SpreadsheetEntityHint {
	row_number: number;
	sheet_name: string;
	column_name: string;
	hint_type: SpreadsheetHintType;
	value: string;
	confidence: number;
	source: SpreadsheetHintSource;
}

interface SpreadsheetStoryMetadataJson {
	id: string;
	document_id: string;
	title: string;
	subtitle: null;
	language: string;
	category: string;
	pages: number[];
	date_references: string[];
	geographic_references: string[];
	extraction_confidence: number;
	source_type: 'spreadsheet';
	tabular_format: SpreadsheetTabularFormat;
	sheet_name: string;
	row_start: number;
	row_end: number;
	row_count: number;
	column_count: number;
	entity_hints: SpreadsheetEntityHint[];
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_PATTERN = /^https?:\/\/\S+$/i;
const DATE_PATTERNS = [/^\d{4}-\d{2}-\d{2}$/, /^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}$/];

function normalizeHeaderForHints(header: string): string {
	return header.toLowerCase().replace(/[^a-z0-9]+/g, '_');
}

function hintTypeForHeader(header: string): SpreadsheetHintType | null {
	const normalized = normalizeHeaderForHints(header);
	if (/(^|_)(id|case|invoice|reference|ref|number|no)(_|$)/.test(normalized)) {
		return 'identifier';
	}
	if (/(^|_)(name|person|author|contact)(_|$)/.test(normalized)) {
		return 'person_name';
	}
	if (/(^|_)(company|organization|organisation|agency|institution)(_|$)/.test(normalized)) {
		return 'organization';
	}
	if (/(^|_)(city|country|address|location|place)(_|$)/.test(normalized)) {
		return 'location';
	}
	if (/(^|_)(date|day|time)(_|$)/.test(normalized)) {
		return 'date';
	}
	return null;
}

function hintTypeForValue(value: string): SpreadsheetHintType | null {
	if (EMAIL_PATTERN.test(value)) {
		return 'email';
	}
	if (URL_PATTERN.test(value)) {
		return 'url';
	}
	if (DATE_PATTERNS.some((pattern) => pattern.test(value))) {
		return 'date';
	}
	return null;
}

function extractSpreadsheetHints(input: {
	sheetName: string;
	headers: string[];
	rows: string[][];
	rowStart: number;
}): SpreadsheetEntityHint[] {
	const hints: SpreadsheetEntityHint[] = [];
	for (let rowIndex = 0; rowIndex < input.rows.length; rowIndex++) {
		const row = input.rows[rowIndex];
		const rowNumber = input.rowStart + rowIndex;
		for (let columnIndex = 0; columnIndex < input.headers.length; columnIndex++) {
			const value = (row[columnIndex] ?? '').trim();
			if (value.length === 0) {
				continue;
			}
			const columnName = input.headers[columnIndex] ?? `Column ${columnIndex + 1}`;
			const valueHint = hintTypeForValue(value);
			const headerHint = hintTypeForHeader(columnName);
			const hintType = valueHint ?? headerHint;
			if (!hintType) {
				continue;
			}
			hints.push({
				row_number: rowNumber,
				sheet_name: input.sheetName,
				column_name: columnName,
				hint_type: hintType,
				value,
				confidence: valueHint && headerHint ? 0.95 : valueHint ? 0.9 : 0.7,
				source: valueHint && headerHint ? 'header_value' : valueHint ? 'value' : 'header',
			});
		}
	}
	return hints;
}

function escapeMarkdownTableCell(value: string): string {
	return value.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}

function renderMarkdownTable(headers: string[], rows: string[][]): string {
	const headerLine = `| ${headers.map(escapeMarkdownTableCell).join(' | ')} |`;
	const separatorLine = `| ${headers.map(() => '---').join(' | ')} |`;
	const dataLines = rows.map((row) => {
		const cells = headers.map((_, index) => escapeMarkdownTableCell(row[index] ?? ''));
		return `| ${cells.join(' | ')} |`;
	});
	return [headerLine, separatorLine, ...dataLines].join('\n');
}

function renderHintSection(hints: SpreadsheetEntityHint[]): string {
	if (hints.length === 0) {
		return '';
	}
	const lines = hints.map(
		(hint) => `- Row ${hint.row_number}, ${hint.column_name}: ${hint.value} (${hint.hint_type}, ${hint.source})`,
	);
	return `\n\n## Row Entity Hints\n\n${lines.join('\n')}`;
}

function spreadsheetTitle(input: {
	filename: string;
	sheetName: string;
	rowStart: number;
	rowEnd: number;
	rowGroupCount: number;
}): string {
	const base = titleFromFilenameWithFallback(input.filename, 'Untitled spreadsheet source');
	const sheet = input.sheetName === 'CSV' ? base : `${base} - ${input.sheetName}`;
	return input.rowGroupCount > 1 ? `${sheet} (rows ${input.rowStart}-${input.rowEnd})` : sheet;
}

function buildSpreadsheetStoryMetadata(input: {
	storyId: string;
	sourceId: string;
	title: string;
	language: string;
	tabularFormat: SpreadsheetTabularFormat;
	sheetName: string;
	rowStart: number;
	rowEnd: number;
	rowCount: number;
	columnCount: number;
	hints: SpreadsheetEntityHint[];
}): SpreadsheetStoryMetadataJson {
	return {
		id: input.storyId,
		document_id: input.sourceId,
		title: input.title,
		subtitle: null,
		language: input.language,
		category: 'document',
		pages: [],
		date_references: [],
		geographic_references: [],
		extraction_confidence: 1.0,
		source_type: 'spreadsheet',
		tabular_format: input.tabularFormat,
		sheet_name: input.sheetName,
		row_start: input.rowStart,
		row_end: input.rowEnd,
		row_count: input.rowCount,
		column_count: input.columnCount,
		entity_hints: input.hints,
	};
}

function buildSpreadsheetFormatMetadata(input: {
	buffer: Buffer;
	filename: string;
	extractionResult: SpreadsheetExtractionResult;
	mediaType: string;
}): Record<string, unknown> {
	const metadata: Record<string, unknown> = {
		media_type: input.mediaType,
		original_extension: input.filename.split('.').pop()?.toLowerCase() ?? '',
		byte_size: input.buffer.length,
		tabular_format: input.extractionResult.tabularFormat,
		container: input.extractionResult.tabularFormat === 'csv' ? 'delimited_text' : 'office_open_xml',
		parser_engine: input.extractionResult.parserEngine,
		sheet_count: input.extractionResult.sheetSummaries.length,
		sheet_names: input.extractionResult.sheetSummaries.map((summary) => summary.sheetName),
		table_summaries: input.extractionResult.sheetSummaries.map((summary) => ({
			sheet_name: summary.sheetName,
			row_count: summary.rowCount,
			column_count: summary.columnCount,
			row_group_count: summary.rowGroupCount,
		})),
		parser_warnings: input.extractionResult.warnings,
	};
	if (input.extractionResult.tabularFormat === 'csv') {
		metadata.encoding = 'utf-8';
		metadata.delimiter = input.extractionResult.delimiter;
	}
	return metadata;
}

async function writeSpreadsheetStory(input: {
	sourceId: string;
	filename: string;
	sheet: SpreadsheetSheet;
	tabularFormat: SpreadsheetTabularFormat;
	rowStart: number;
	rowEnd: number;
	language: string;
	services: Services;
	pool: pg.Pool;
	storagePath: string;
}): Promise<void> {
	const rows = input.sheet.rows.slice(input.rowStart - 1, input.rowEnd);
	const hints = extractSpreadsheetHints({
		sheetName: input.sheet.name,
		headers: input.sheet.headers,
		rows,
		rowStart: input.rowStart,
	});
	const title = spreadsheetTitle({
		filename: input.filename,
		sheetName: input.sheet.name,
		rowStart: input.rowStart,
		rowEnd: input.rowEnd,
		rowGroupCount: input.sheet.rowGroups.length,
	});
	const markdown = [
		`# ${title}`,
		'',
		`Sheet: ${input.sheet.name}`,
		`Rows: ${input.rowStart}-${input.rowEnd}`,
		'',
		renderMarkdownTable(input.sheet.headers, rows),
		renderHintSection(hints),
	].join('\n');
	const storyId = randomUUID();
	const markdownUri = `segments/${input.sourceId}/${storyId}.md`;
	const metadataUri = `segments/${input.sourceId}/${storyId}.meta.json`;
	const storyMetadata = buildSpreadsheetStoryMetadata({
		storyId,
		sourceId: input.sourceId,
		title,
		language: input.language,
		tabularFormat: input.tabularFormat,
		sheetName: input.sheet.name,
		rowStart: input.rowStart,
		rowEnd: input.rowEnd,
		rowCount: rows.length,
		columnCount: input.sheet.headers.length,
		hints,
	});

	await input.services.storage.upload(markdownUri, markdown, 'text/markdown');
	await input.services.storage.upload(metadataUri, JSON.stringify(storyMetadata, null, 2), 'application/json');
	await createStory(input.pool, {
		id: storyId,
		sourceId: input.sourceId,
		title,
		language: input.language,
		category: 'document',
		gcsMarkdownUri: markdownUri,
		gcsMetadataUri: metadataUri,
		extractionConfidence: 1.0,
		metadata: {
			source_type: 'spreadsheet',
			tabular_format: input.tabularFormat,
			sheet_name: input.sheet.name,
			row_start: input.rowStart,
			row_end: input.rowEnd,
			row_count: rows.length,
			column_count: input.sheet.headers.length,
			entity_hints: hints,
			original_storage_path: input.storagePath,
		},
	});
}

async function extractSpreadsheetSource(input: {
	sourceId: string;
	filename: string;
	storagePath: string;
	formatMetadata: Record<string, unknown>;
	config: MulderConfig;
	services: Services;
	pool: pg.Pool;
	stepConfigHash: string;
	logger: Logger;
}): Promise<ExtractionData> {
	let buffer: Buffer;
	try {
		buffer = await input.services.storage.download(input.storagePath);
	} catch (cause: unknown) {
		throw new ExtractError(
			`Failed to download spreadsheet source original for source ${input.sourceId}`,
			EXTRACT_ERROR_CODES.EXTRACT_STORAGE_FAILED,
			{ cause, context: { sourceId: input.sourceId, storagePath: input.storagePath } },
		);
	}

	const mediaType = typeof input.formatMetadata.media_type === 'string' ? input.formatMetadata.media_type : undefined;
	if (!isSupportedSpreadsheetMediaType(mediaType)) {
		throw new ExtractError(
			`Spreadsheet source has unsupported media type for source ${input.sourceId}`,
			EXTRACT_ERROR_CODES.EXTRACT_SPREADSHEET_FAILED,
			{ context: { sourceId: input.sourceId, mediaType } },
		);
	}

	let extractionResult: SpreadsheetExtractionResult;
	try {
		extractionResult = await input.services.spreadsheets.extractSpreadsheet(
			buffer,
			input.sourceId,
			mediaType === 'text/csv' ? 'csv' : 'xlsx',
		);
	} catch (cause: unknown) {
		throw new ExtractError(
			`Spreadsheet extraction failed for source ${input.sourceId}`,
			EXTRACT_ERROR_CODES.EXTRACT_SPREADSHEET_FAILED,
			{ cause, context: { sourceId: input.sourceId, storagePath: input.storagePath } },
		);
	}

	const language = input.config.project.supported_locales[0] ?? 'en';
	let storyCount = 0;
	try {
		for (const sheet of extractionResult.sheets) {
			for (const group of sheet.rowGroups) {
				await writeSpreadsheetStory({
					sourceId: input.sourceId,
					filename: input.filename,
					sheet,
					tabularFormat: extractionResult.tabularFormat,
					rowStart: group.rowStart,
					rowEnd: group.rowEnd,
					language,
					services: input.services,
					pool: input.pool,
					storagePath: input.storagePath,
				});
				storyCount++;
			}
		}
	} catch (cause: unknown) {
		throw new ExtractError(
			`Failed to write spreadsheet story artifacts for source ${input.sourceId}`,
			EXTRACT_ERROR_CODES.EXTRACT_STORAGE_FAILED,
			{ cause, context: { sourceId: input.sourceId } },
		);
	}

	await updateSource(input.pool, input.sourceId, {
		formatMetadata: buildSpreadsheetFormatMetadata({
			buffer,
			filename: input.filename,
			extractionResult,
			mediaType,
		}),
		metadata: buildSpreadsheetFormatMetadata({
			buffer,
			filename: input.filename,
			extractionResult,
			mediaType,
		}),
		status: 'extracted',
	});
	await upsertSourceStep(input.pool, {
		sourceId: input.sourceId,
		stepName: STEP_NAME,
		status: 'completed',
		configHash: input.stepConfigHash,
	});

	input.logger.debug({ storyCount, sheetCount: extractionResult.sheets.length }, 'Spreadsheet source extracted');

	return {
		sourceId: input.sourceId,
		layoutUri: null,
		pageImageUris: [],
		pageCount: 0,
		primaryMethod: 'spreadsheet',
		pages: [],
		visionFallbackCount: 0,
		visionFallbackCapped: false,
	};
}

// ────────────────────────────────────────────────────────────
// Email extraction helpers
// ────────────────────────────────────────────────────────────

type EmailHintType = 'sender' | 'recipient' | 'sent_date' | 'subject' | 'message_id' | 'thread_id' | 'attachment';
type EmailHintSource = 'header' | 'thread' | 'attachment';

interface EmailEntityHint {
	hint_type: EmailHintType;
	field_name: string;
	value: string;
	confidence: number;
	source: EmailHintSource;
}

interface EmailStoryMetadataJson {
	id: string;
	document_id: string;
	title: string;
	subtitle: null;
	language: string;
	category: string;
	pages: number[];
	date_references: string[];
	geographic_references: string[];
	extraction_confidence: number;
	source_type: 'email';
	email_format: 'eml' | 'msg';
	message_id: string | null;
	thread_id: string;
	subject: string | null;
	sent_at: string | null;
	from: string[];
	to: string[];
	cc: string[];
	bcc: string[];
	reply_to: string[];
	in_reply_to: string | null;
	references: string[];
	attachments: EmailAttachmentSummary[];
	entity_hints: EmailEntityHint[];
}

function computeFileHash(buffer: Buffer): string {
	return createHash('sha256').update(buffer).digest('hex');
}

function escapeMarkdownTableValue(value: string): string {
	return value.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}

function formatHeaderList(values: string[]): string {
	return values.length > 0 ? values.join(', ') : '';
}

function emailStoryTitle(filename: string, result: EmailExtractionResult): string {
	const subject = result.headers.subject?.trim();
	const datePrefix = result.headers.sentAt ? result.headers.sentAt.slice(0, 10) : null;
	const fallback = titleFromFilenameWithFallback(filename, 'Untitled email source');
	return [datePrefix, subject && subject.length > 0 ? subject : fallback].filter(Boolean).join(' - ');
}

function buildEmailHints(result: EmailExtractionResult, attachments: EmailAttachmentSummary[]): EmailEntityHint[] {
	const hints: EmailEntityHint[] = [];
	for (const address of result.headers.from) {
		hints.push({ hint_type: 'sender', field_name: 'from', value: address.display, confidence: 1, source: 'header' });
	}
	for (const [fieldName, addresses] of [
		['to', result.headers.to],
		['cc', result.headers.cc],
		['bcc', result.headers.bcc],
		['reply_to', result.headers.replyTo],
	] as const) {
		for (const address of addresses) {
			hints.push({
				hint_type: 'recipient',
				field_name: fieldName,
				value: address.display,
				confidence: 0.95,
				source: 'header',
			});
		}
	}
	if (result.headers.sentAt) {
		hints.push({
			hint_type: 'sent_date',
			field_name: 'sent_at',
			value: result.headers.sentAt,
			confidence: 1,
			source: 'header',
		});
	}
	if (result.headers.subject) {
		hints.push({
			hint_type: 'subject',
			field_name: 'subject',
			value: result.headers.subject,
			confidence: 0.8,
			source: 'header',
		});
	}
	if (result.headers.messageId) {
		hints.push({
			hint_type: 'message_id',
			field_name: 'message_id',
			value: result.headers.messageId,
			confidence: 1,
			source: 'header',
		});
	}
	hints.push({
		hint_type: 'thread_id',
		field_name: 'thread_id',
		value: result.headers.threadId,
		confidence: 1,
		source: 'thread',
	});
	for (const attachment of attachments) {
		if (attachment.filename) {
			hints.push({
				hint_type: 'attachment',
				field_name: attachment.childSourceId ? 'attachment_child_source' : 'attachment_filename',
				value: attachment.childSourceId ? `${attachment.filename} (${attachment.childSourceId})` : attachment.filename,
				confidence: 0.8,
				source: 'attachment',
			});
		}
	}
	return hints;
}

function renderEmailMarkdown(input: {
	title: string;
	result: EmailExtractionResult;
	attachments: EmailAttachmentSummary[];
	hints: EmailEntityHint[];
}): string {
	const headers = input.result.headers;
	const rows = [
		['Subject', headers.subject ?? ''],
		['From', formatHeaderList(headers.from.map((address) => address.display))],
		['To', formatHeaderList(headers.to.map((address) => address.display))],
		['Cc', formatHeaderList(headers.cc.map((address) => address.display))],
		['Bcc', formatHeaderList(headers.bcc.map((address) => address.display))],
		['Reply-To', formatHeaderList(headers.replyTo.map((address) => address.display))],
		['Sent At', headers.sentAt ?? ''],
		['Message ID', headers.messageId ?? ''],
		['Thread ID', headers.threadId],
		['In-Reply-To', headers.inReplyTo ?? ''],
		['References', headers.references.join(' ')],
	].filter(([, value]) => value.length > 0);
	const headerTable = [
		'| Field | Value |',
		'| --- | --- |',
		...rows.map(([field, value]) => `| ${field} | ${escapeMarkdownTableValue(value)} |`),
	].join('\n');
	const sections = [
		`# ${input.title}`,
		'',
		'## Headers',
		'',
		headerTable,
		'',
		'## Body',
		'',
		input.result.bodyText.trim(),
	];

	if (input.attachments.length > 0) {
		sections.push(
			'',
			'## Attachments',
			'',
			...input.attachments.map((attachment) => {
				const details = [
					attachment.mediaType ?? 'unknown media type',
					`${attachment.sizeBytes} bytes`,
					attachment.childSourceId ? `child source ${attachment.childSourceId}` : null,
				].filter(Boolean);
				return `- ${attachment.filename ?? 'unnamed attachment'} (${details.join(', ')})`;
			}),
		);
	}

	if (input.hints.length > 0) {
		sections.push(
			'',
			'## Email Entity Hints',
			'',
			...input.hints.map((hint) => `- ${hint.field_name}: ${hint.value} (${hint.hint_type}, ${hint.source})`),
		);
	}

	return sections.join('\n');
}

function buildEmailStoryMetadata(input: {
	storyId: string;
	sourceId: string;
	title: string;
	language: string;
	result: EmailExtractionResult;
	attachments: EmailAttachmentSummary[];
	hints: EmailEntityHint[];
}): EmailStoryMetadataJson {
	const headers = input.result.headers;
	return {
		id: input.storyId,
		document_id: input.sourceId,
		title: input.title,
		subtitle: null,
		language: input.language,
		category: 'document',
		pages: [],
		date_references: headers.sentAt ? [headers.sentAt] : [],
		geographic_references: [],
		extraction_confidence: 1.0,
		source_type: 'email',
		email_format: input.result.emailFormat,
		message_id: headers.messageId,
		thread_id: headers.threadId,
		subject: headers.subject,
		sent_at: headers.sentAt,
		from: headers.from.map((address) => address.display),
		to: headers.to.map((address) => address.display),
		cc: headers.cc.map((address) => address.display),
		bcc: headers.bcc.map((address) => address.display),
		reply_to: headers.replyTo.map((address) => address.display),
		in_reply_to: headers.inReplyTo,
		references: headers.references,
		attachments: input.attachments,
		entity_hints: input.hints,
	};
}

async function metadataForAttachment(input: {
	buffer: Buffer;
	filename: string;
	mediaType: string;
	sourceType: string;
	services: Services;
	sourceId: string;
}): Promise<{
	formatMetadata: SourceFormatMetadata;
	pageCount: number;
	hasNativeText: boolean;
	nativeTextRatio: number;
}> {
	if (input.sourceType === 'pdf') {
		const pdfMeta = await extractPdfMetadata(input.buffer);
		const textResult = await detectNativeText(input.buffer);
		const formatMetadata: SourceFormatMetadata = {};
		if (pdfMeta.pdfVersion) formatMetadata.pdf_version = pdfMeta.pdfVersion;
		if (pdfMeta.title) formatMetadata.title = pdfMeta.title;
		if (pdfMeta.author) formatMetadata.author = pdfMeta.author;
		if (pdfMeta.creator) formatMetadata.creator = pdfMeta.creator;
		if (pdfMeta.producer) formatMetadata.producer = pdfMeta.producer;
		if (pdfMeta.creationDate) formatMetadata.creation_date = pdfMeta.creationDate.toISOString();
		if (pdfMeta.modificationDate) formatMetadata.modification_date = pdfMeta.modificationDate.toISOString();
		if (pdfMeta.encrypted !== undefined) formatMetadata.encrypted = pdfMeta.encrypted;
		return {
			formatMetadata,
			pageCount: textResult.pageCount,
			hasNativeText: textResult.hasNativeText,
			nativeTextRatio: textResult.nativeTextRatio,
		};
	}
	if (input.sourceType === 'image' && isSupportedImageMediaType(input.mediaType)) {
		return {
			formatMetadata: buildImageFormatMetadata(input.buffer, input.filename, input.mediaType),
			pageCount: 1,
			hasNativeText: false,
			nativeTextRatio: 0,
		};
	}
	if (
		input.sourceType === 'text' &&
		isSupportedTextFilename(input.filename) &&
		isSupportedTextMediaType(input.mediaType)
	) {
		const formatMetadata = buildTextFormatMetadata(input.buffer, input.filename, input.mediaType);
		if (!formatMetadata) {
			throw new ExtractError('Attachment text source is unreadable', EXTRACT_ERROR_CODES.EXTRACT_EMAIL_FAILED);
		}
		return { formatMetadata, pageCount: 0, hasNativeText: false, nativeTextRatio: 0 };
	}
	if (input.sourceType === 'docx') {
		return {
			formatMetadata: buildDocxFormatMetadata(input.buffer, input.filename),
			pageCount: 0,
			hasNativeText: false,
			nativeTextRatio: 0,
		};
	}
	if (input.sourceType === 'spreadsheet' && isSupportedSpreadsheetMediaType(input.mediaType)) {
		const extractionResult = await input.services.spreadsheets.extractSpreadsheet(
			input.buffer,
			input.sourceId,
			input.mediaType === 'text/csv' ? 'csv' : 'xlsx',
		);
		return {
			formatMetadata: buildIngestSpreadsheetFormatMetadata(
				input.buffer,
				input.filename,
				input.mediaType,
				extractionResult,
			),
			pageCount: 0,
			hasNativeText: false,
			nativeTextRatio: 0,
		};
	}
	throw new ExtractError('Unsupported email attachment source type', EXTRACT_ERROR_CODES.EXTRACT_EMAIL_FAILED, {
		context: { filename: input.filename, sourceType: input.sourceType, mediaType: input.mediaType },
	});
}

async function registerAttachmentChildSources(input: {
	sourceId: string;
	attachments: EmailExtractionResult['attachments'];
	services: Services;
	pool: pg.Pool;
	logger: Logger;
}): Promise<EmailAttachmentSummary[]> {
	const summaries: EmailAttachmentSummary[] = [];
	for (const attachment of input.attachments) {
		const summary: EmailAttachmentSummary = {
			filename: attachment.filename,
			mediaType: attachment.mediaType,
			sizeBytes: attachment.sizeBytes,
			disposition: attachment.disposition,
			contentId: attachment.contentId,
		};
		if (!attachment.content || !attachment.filename) {
			summaries.push(summary);
			continue;
		}

		const detection = detectSourceType(attachment.content, attachment.filename);
		if (!detection || detection.sourceType === 'email' || detection.sourceType === 'url' || !detection.mediaType) {
			summaries.push(summary);
			continue;
		}

		const storageExtension = getStorageExtensionForDetection(detection);
		if (!storageExtension) {
			summaries.push(summary);
			continue;
		}

		const fileHash = computeFileHash(attachment.content);
		const existing = await findSourceByHash(input.pool, fileHash);
		if (existing) {
			summaries.push({ ...summary, childSourceId: existing.id });
			continue;
		}

		const childSourceId = randomUUID();
		const storagePath = `raw/${childSourceId}/original.${storageExtension}`;
		try {
			const childMetadata = await metadataForAttachment({
				buffer: attachment.content,
				filename: attachment.filename,
				mediaType: detection.mediaType,
				sourceType: detection.sourceType,
				services: input.services,
				sourceId: childSourceId,
			});
			await input.services.storage.upload(storagePath, attachment.content, detection.mediaType);
			const child = await createSource(input.pool, {
				id: childSourceId,
				filename: attachment.filename,
				storagePath,
				fileHash,
				parentSourceId: input.sourceId,
				sourceType: detection.sourceType,
				formatMetadata: childMetadata.formatMetadata,
				pageCount: childMetadata.pageCount,
				hasNativeText: childMetadata.hasNativeText,
				nativeTextRatio: childMetadata.nativeTextRatio,
				metadata: childMetadata.formatMetadata,
			});
			if (child.id !== childSourceId) {
				await input.services.storage.delete(storagePath).catch(() => undefined);
			}
			summaries.push({ ...summary, childSourceId: child.id });
		} catch (cause: unknown) {
			input.logger.warn(
				{ err: cause, filename: attachment.filename },
				'Email attachment child source registration failed',
			);
			await input.services.storage.delete(storagePath).catch(() => undefined);
			summaries.push(summary);
		}
	}
	return summaries;
}

async function extractEmailSource(input: {
	sourceId: string;
	filename: string;
	storagePath: string;
	formatMetadata: Record<string, unknown>;
	config: MulderConfig;
	services: Services;
	pool: pg.Pool;
	stepConfigHash: string;
	logger: Logger;
}): Promise<ExtractionData> {
	let buffer: Buffer;
	try {
		buffer = await input.services.storage.download(input.storagePath);
	} catch (cause: unknown) {
		throw new ExtractError(
			`Failed to download email source original for source ${input.sourceId}`,
			EXTRACT_ERROR_CODES.EXTRACT_STORAGE_FAILED,
			{ cause, context: { sourceId: input.sourceId, storagePath: input.storagePath } },
		);
	}

	const mediaType = typeof input.formatMetadata.media_type === 'string' ? input.formatMetadata.media_type : undefined;
	if (!isSupportedEmailMediaType(mediaType)) {
		throw new ExtractError(
			`Email source has unsupported media type for source ${input.sourceId}`,
			EXTRACT_ERROR_CODES.EXTRACT_EMAIL_FAILED,
			{ context: { sourceId: input.sourceId, mediaType } },
		);
	}

	let emailResult: EmailExtractionResult;
	try {
		emailResult = await input.services.emails.extractEmail(
			buffer,
			input.sourceId,
			mediaType === 'message/rfc822' ? 'eml' : 'msg',
		);
	} catch (cause: unknown) {
		throw new ExtractError(
			`Email extraction failed for source ${input.sourceId}`,
			EXTRACT_ERROR_CODES.EXTRACT_EMAIL_FAILED,
			{
				cause,
				context: { sourceId: input.sourceId, storagePath: input.storagePath },
			},
		);
	}

	const attachments = await registerAttachmentChildSources({
		sourceId: input.sourceId,
		attachments: emailResult.attachments,
		services: input.services,
		pool: input.pool,
		logger: input.logger,
	});
	const title = emailStoryTitle(input.filename, emailResult);
	const language = input.config.project.supported_locales[0] ?? 'en';
	const hints = buildEmailHints(emailResult, attachments);
	const storyId = randomUUID();
	const markdownUri = `segments/${input.sourceId}/${storyId}.md`;
	const metadataUri = `segments/${input.sourceId}/${storyId}.meta.json`;
	const storyMetadata = buildEmailStoryMetadata({
		storyId,
		sourceId: input.sourceId,
		title,
		language,
		result: emailResult,
		attachments,
		hints,
	});
	const markdown = renderEmailMarkdown({ title, result: emailResult, attachments, hints });

	try {
		await input.services.storage.upload(markdownUri, markdown, 'text/markdown');
		await input.services.storage.upload(metadataUri, JSON.stringify(storyMetadata, null, 2), 'application/json');
	} catch (cause: unknown) {
		throw new ExtractError(
			`Failed to write email story artifacts for source ${input.sourceId}`,
			EXTRACT_ERROR_CODES.EXTRACT_STORAGE_FAILED,
			{ cause, context: { sourceId: input.sourceId, markdownUri, metadataUri } },
		);
	}

	await createStory(input.pool, {
		id: storyId,
		sourceId: input.sourceId,
		title,
		language,
		category: 'document',
		gcsMarkdownUri: markdownUri,
		gcsMetadataUri: metadataUri,
		extractionConfidence: 1.0,
		metadata: {
			source_type: 'email',
			email_format: emailResult.emailFormat,
			message_id: emailResult.headers.messageId,
			thread_id: emailResult.headers.threadId,
			subject: emailResult.headers.subject,
			sent_at: emailResult.headers.sentAt,
			attachments,
			entity_hints: hints,
			original_storage_path: input.storagePath,
		},
	});

	const updatedFormatMetadata = buildEmailFormatMetadata(buffer, input.filename, mediaType, {
		...emailResult,
		attachments: emailResult.attachments.map((attachment, index) => ({
			...attachment,
			childSourceId: attachments[index]?.childSourceId,
		})),
	});
	await updateSource(input.pool, input.sourceId, {
		formatMetadata: updatedFormatMetadata,
		metadata: updatedFormatMetadata,
		status: 'extracted',
	});
	await upsertSourceStep(input.pool, {
		sourceId: input.sourceId,
		stepName: STEP_NAME,
		status: 'completed',
		configHash: input.stepConfigHash,
	});

	input.logger.debug({ storyId, attachmentCount: attachments.length }, 'Email source extracted into story Markdown');

	return {
		sourceId: input.sourceId,
		layoutUri: null,
		pageImageUris: [],
		pageCount: 0,
		primaryMethod: 'email',
		pages: [],
		visionFallbackCount: 0,
		visionFallbackCapped: false,
	};
}

// ────────────────────────────────────────────────────────────
// URL extraction helpers
// ────────────────────────────────────────────────────────────

interface UrlStoryMetadataJson {
	id: string;
	document_id: string;
	title: string;
	subtitle: null;
	language: string;
	category: string;
	pages: number[];
	date_references: string[];
	geographic_references: string[];
	extraction_confidence: number;
	source_type: 'url';
	original_url: string | null;
	final_url: string | null;
	canonical_url: string | null;
	host: string | null;
	site_name: string | null;
	byline: string | null;
	published_time: string | null;
	modified_time: string | null;
	rendering_method: string | null;
	rendering_engine: string | null;
	parser_engine: string;
	text_length: number;
	entity_hints: UrlEntityHint[];
}

function urlMetadataString(metadata: Record<string, unknown>, key: string): string | null {
	const value = metadata[key];
	return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function hostFromUrl(value: string | null): string | null {
	if (!value) {
		return null;
	}
	try {
		return new URL(value).hostname;
	} catch {
		return null;
	}
}

function renderUrlMetadataTable(input: {
	originalUrl: string | null;
	finalUrl: string | null;
	canonicalUrl: string | null;
	host: string | null;
	siteName: string | null;
	byline: string | null;
	publishedTime: string | null;
	modifiedTime: string | null;
	fetchDate: string | null;
	renderingMethod: string | null;
	renderingEngine: string | null;
}): string {
	const rows = [
		['Original URL', input.originalUrl],
		['Final URL', input.finalUrl],
		['Canonical URL', input.canonicalUrl],
		['Host', input.host],
		['Site Name', input.siteName],
		['Byline', input.byline],
		['Published', input.publishedTime],
		['Modified', input.modifiedTime],
		['Fetched', input.fetchDate],
		['Rendering', input.renderingMethod],
		['Renderer', input.renderingEngine],
	].filter((row): row is [string, string] => typeof row[1] === 'string' && row[1].length > 0);
	if (rows.length === 0) {
		return '';
	}
	return [
		'| Field | Value |',
		'| --- | --- |',
		...rows.map(([field, value]) => `| ${field} | ${escapeMarkdownTableValue(value)} |`),
	].join('\n');
}

function renderUrlHintSection(hints: UrlEntityHint[]): string {
	if (hints.length === 0) {
		return '';
	}
	return [
		'## URL Entity Hints',
		'',
		...hints.map((hint) => `- ${hint.field_name}: ${hint.value} (${hint.hint_type}, ${hint.source})`),
	].join('\n');
}

function renderUrlMarkdown(input: {
	title: string;
	result: UrlExtractionResult;
	fetchMetadata: Record<string, unknown>;
}): string {
	const originalUrl = urlMetadataString(input.fetchMetadata, 'original_url');
	const finalUrl = urlMetadataString(input.fetchMetadata, 'final_url');
	const sections = [
		`# ${input.title}`,
		'',
		renderUrlMetadataTable({
			originalUrl,
			finalUrl,
			canonicalUrl: input.result.canonicalUrl,
			host: hostFromUrl(finalUrl),
			siteName: input.result.siteName,
			byline: input.result.byline,
			publishedTime: input.result.publishedTime,
			modifiedTime: input.result.modifiedTime,
			fetchDate: urlMetadataString(input.fetchMetadata, 'fetch_date'),
			renderingMethod: urlMetadataString(input.fetchMetadata, 'rendering_method'),
			renderingEngine: urlMetadataString(input.fetchMetadata, 'rendering_engine'),
		}),
		'',
		input.result.markdown,
	];
	const hintSection = renderUrlHintSection(input.result.entityHints);
	if (hintSection.length > 0) {
		sections.push('', hintSection);
	}
	return sections.filter((section) => section.length > 0).join('\n');
}

function buildUrlStoryMetadata(input: {
	storyId: string;
	sourceId: string;
	title: string;
	language: string;
	result: UrlExtractionResult;
	fetchMetadata: Record<string, unknown>;
}): UrlStoryMetadataJson {
	const finalUrl = urlMetadataString(input.fetchMetadata, 'final_url');
	return {
		id: input.storyId,
		document_id: input.sourceId,
		title: input.title,
		subtitle: null,
		language: input.language,
		category: 'document',
		pages: [],
		date_references: [input.result.publishedTime, input.result.modifiedTime].filter(
			(value): value is string => value !== null,
		),
		geographic_references: [],
		extraction_confidence: 1.0,
		source_type: 'url',
		original_url: urlMetadataString(input.fetchMetadata, 'original_url'),
		final_url: finalUrl,
		canonical_url: input.result.canonicalUrl,
		host: hostFromUrl(finalUrl),
		site_name: input.result.siteName,
		byline: input.result.byline,
		published_time: input.result.publishedTime,
		modified_time: input.result.modifiedTime,
		rendering_method: urlMetadataString(input.fetchMetadata, 'rendering_method'),
		rendering_engine: urlMetadataString(input.fetchMetadata, 'rendering_engine'),
		parser_engine: input.result.parserEngine,
		text_length: input.result.textLength,
		entity_hints: input.result.entityHints,
	};
}

async function extractUrlSource(input: {
	sourceId: string;
	filename: string;
	storagePath: string;
	formatMetadata: Record<string, unknown>;
	config: MulderConfig;
	services: Services;
	pool: pg.Pool;
	stepConfigHash: string;
	logger: Logger;
}): Promise<ExtractionData> {
	let buffer: Buffer;
	try {
		buffer = await input.services.storage.download(input.storagePath);
	} catch (cause: unknown) {
		throw new ExtractError(
			`Failed to download URL HTML snapshot for source ${input.sourceId}`,
			EXTRACT_ERROR_CODES.EXTRACT_STORAGE_FAILED,
			{ cause, context: { sourceId: input.sourceId, storagePath: input.storagePath } },
		);
	}

	let urlResult: UrlExtractionResult;
	try {
		urlResult = await input.services.urlExtractors.extractUrl(buffer, input.sourceId, input.formatMetadata);
	} catch (cause: unknown) {
		throw new ExtractError(
			`URL extraction failed for source ${input.sourceId}`,
			EXTRACT_ERROR_CODES.EXTRACT_URL_FAILED,
			{
				cause,
				context: { sourceId: input.sourceId, storagePath: input.storagePath },
			},
		);
	}

	const title = urlResult.title || titleFromFilenameWithFallback(input.filename, 'Untitled URL source');
	const language = input.config.project.supported_locales[0] ?? 'en';
	const storyId = randomUUID();
	const markdownUri = `segments/${input.sourceId}/${storyId}.md`;
	const metadataUri = `segments/${input.sourceId}/${storyId}.meta.json`;
	const markdown = renderUrlMarkdown({ title, result: urlResult, fetchMetadata: input.formatMetadata });
	const storyMetadata = buildUrlStoryMetadata({
		storyId,
		sourceId: input.sourceId,
		title,
		language,
		result: urlResult,
		fetchMetadata: input.formatMetadata,
	});

	try {
		await input.services.storage.upload(markdownUri, markdown, 'text/markdown');
		await input.services.storage.upload(metadataUri, JSON.stringify(storyMetadata, null, 2), 'application/json');
	} catch (cause: unknown) {
		throw new ExtractError(
			`Failed to write URL story artifacts for source ${input.sourceId}`,
			EXTRACT_ERROR_CODES.EXTRACT_STORAGE_FAILED,
			{ cause, context: { sourceId: input.sourceId, markdownUri, metadataUri } },
		);
	}

	await createStory(input.pool, {
		id: storyId,
		sourceId: input.sourceId,
		title,
		language,
		category: 'document',
		gcsMarkdownUri: markdownUri,
		gcsMetadataUri: metadataUri,
		extractionConfidence: 1.0,
		metadata: {
			source_type: 'url',
			original_url: storyMetadata.original_url,
			final_url: storyMetadata.final_url,
			canonical_url: storyMetadata.canonical_url,
			host: storyMetadata.host,
			site_name: storyMetadata.site_name,
			byline: storyMetadata.byline,
			published_time: storyMetadata.published_time,
			modified_time: storyMetadata.modified_time,
			rendering_method: storyMetadata.rendering_method,
			rendering_engine: storyMetadata.rendering_engine,
			parser_engine: urlResult.parserEngine,
			entity_hints: urlResult.entityHints,
			original_storage_path: input.storagePath,
		},
	});

	const updatedFormatMetadata = {
		...input.formatMetadata,
		title: urlResult.title,
		canonical_url: urlResult.canonicalUrl,
		site_name: urlResult.siteName,
		byline: urlResult.byline,
		published_time: urlResult.publishedTime,
		modified_time: urlResult.modifiedTime,
		readability_text_length: urlResult.textLength,
		parser_engine: urlResult.parserEngine,
		parser_warnings: urlResult.warnings,
	};
	await updateSource(input.pool, input.sourceId, {
		formatMetadata: updatedFormatMetadata,
		metadata: updatedFormatMetadata,
		status: 'extracted',
	});
	await upsertSourceStep(input.pool, {
		sourceId: input.sourceId,
		stepName: STEP_NAME,
		status: 'completed',
		configHash: input.stepConfigHash,
	});

	input.logger.debug({ storyId, textLength: urlResult.textLength }, 'URL source extracted into story Markdown');

	return {
		sourceId: input.sourceId,
		layoutUri: null,
		pageImageUris: [],
		pageCount: 0,
		primaryMethod: 'url',
		pages: [],
		visionFallbackCount: 0,
		visionFallbackCapped: false,
	};
}

// ────────────────────────────────────────────────────────────
// Document AI parsing helpers
// ────────────────────────────────────────────────────────────

interface ParsedDocumentAiPage {
	pageNumber: number;
	text: string;
	confidence: number;
	blocks: LayoutBlock[];
}

/**
 * Type guard: checks if a value is a non-null, non-array object (i.e. a record).
 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Safely extracts a numeric field from a record, with a default fallback.
 */
function getNumber(obj: Record<string, unknown>, key: string, fallback: number): number {
	const val = obj[key];
	if (typeof val === 'number') return val;
	if (typeof val === 'string') return Number.parseInt(val, 10) || fallback;
	return fallback;
}

/**
 * Parses a Document AI result into per-page extraction data.
 * Extracts text, confidence, and block-level bounding boxes from the raw JSON.
 */
function parseDocumentAiResult(document: Record<string, unknown>): ParsedDocumentAiPage[] {
	const pages: ParsedDocumentAiPage[] = [];

	// Document AI response has a 'pages' array and a top-level 'text' field
	const docText = typeof document.text === 'string' ? document.text : '';
	const rawPages = Array.isArray(document.pages) ? document.pages : [];

	for (let i = 0; i < rawPages.length; i++) {
		const rawPage = isRecord(rawPages[i]) ? rawPages[i] : {};

		// Extract page-level confidence (layout.confidence or overall)
		let pageConfidence = 0.5;
		if (isRecord(rawPage.layout)) {
			pageConfidence = getNumber(rawPage.layout, 'confidence', 0.5);
		}

		// Extract blocks (paragraphs) with bounding boxes
		const blocks: LayoutBlock[] = [];
		const rawParagraphs = Array.isArray(rawPage.paragraphs) ? rawPage.paragraphs : [];

		for (const rawParagraph of rawParagraphs) {
			if (!isRecord(rawParagraph)) continue;

			const paraLayout = rawParagraph.layout;
			if (!isRecord(paraLayout)) continue;

			// Extract text via textAnchor
			let blockText = '';
			const textAnchorCandidate = paraLayout.textAnchor ?? rawParagraph.textAnchor;
			if (isRecord(textAnchorCandidate)) {
				const textSegments = Array.isArray(textAnchorCandidate.textSegments) ? textAnchorCandidate.textSegments : [];
				for (const seg of textSegments) {
					if (!isRecord(seg)) continue;
					const startIndex = getNumber(seg, 'startIndex', 0);
					const endIndex = getNumber(seg, 'endIndex', 0);
					blockText += docText.slice(startIndex, endIndex);
				}
			}

			// Extract bounding box
			let boundingBox: LayoutBlock['boundingBox'];
			const bpCandidate = paraLayout.boundingPoly ?? rawParagraph.boundingPoly;
			if (isRecord(bpCandidate)) {
				const normalizedVertices = Array.isArray(bpCandidate.normalizedVertices) ? bpCandidate.normalizedVertices : [];
				if (normalizedVertices.length >= 4) {
					const vertices = normalizedVertices.map((v) => {
						if (isRecord(v)) {
							return {
								x: typeof v.x === 'number' ? v.x : 0,
								y: typeof v.y === 'number' ? v.y : 0,
							};
						}
						return { x: 0, y: 0 };
					});
					const xs = vertices.map((v) => v.x);
					const ys = vertices.map((v) => v.y);
					boundingBox = {
						x: Math.min(...xs),
						y: Math.min(...ys),
						width: Math.max(...xs) - Math.min(...xs),
						height: Math.max(...ys) - Math.min(...ys),
					};
				}
			}

			const blockConfidence = getNumber(paraLayout, 'confidence', pageConfidence);

			blocks.push({
				text: blockText,
				type: 'paragraph',
				boundingBox,
				confidence: blockConfidence,
			});
		}

		// Build full-page text from blocks, or fall back to text segment extraction
		const pageText = blocks.length > 0 ? blocks.map((b) => b.text).join('\n') : '';

		pages.push({
			pageNumber: i + 1,
			text: pageText,
			confidence: pageConfidence,
			blocks,
		});
	}

	return pages;
}

// ────────────────────────────────────────────────────────────
// Vision fallback
// ────────────────────────────────────────────────────────────

interface VisionFallbackContext {
	services: Services;
	config: MulderConfig;
	logger: Logger;
	maxVisionPages: number;
}

/**
 * Runs Gemini Vision fallback on low-confidence pages.
 * Respects the circuit breaker (max_vision_pages).
 *
 * Mutates the pages array in place, updating text and method for corrected pages.
 * Returns the number of pages corrected and whether the cap was hit.
 */
async function runVisionFallback(
	pages: LayoutPage[],
	pageImages: Buffer[],
	confidenceThreshold: number,
	ctx: VisionFallbackContext,
): Promise<{ visionFallbackCount: number; visionFallbackCapped: boolean; errors: StepError[] }> {
	let visionFallbackCount = 0;
	let visionFallbackCapped = false;
	const errors: StepError[] = [];
	const locale = ctx.config.project.supported_locales[0] ?? 'en';

	for (let i = 0; i < pages.length; i++) {
		const page = pages[i];
		if (page.confidence >= confidenceThreshold) continue;
		if (page.method === 'vision_fallback') continue; // Already corrected

		if (visionFallbackCount >= ctx.maxVisionPages) {
			visionFallbackCapped = true;
			ctx.logger.warn(
				{ pageNumber: page.pageNumber, maxVisionPages: ctx.maxVisionPages },
				'Vision fallback circuit breaker hit — using Document AI text as-is for remaining pages',
			);
			break;
		}

		// Need a page image for the vision call
		const pageImage = pageImages[i];
		if (!pageImage || pageImage.length === 0) {
			ctx.logger.warn({ pageNumber: page.pageNumber }, 'No page image available for vision fallback — skipping');
			continue;
		}

		try {
			const prompt = renderPrompt('vision-fallback', {
				locale,
				confidence: String(page.confidence),
				page_text: page.text,
			});

			const correctedText = await ctx.services.llm.generateText({
				prompt,
				media: [{ mimeType: 'image/png', data: pageImage }],
			});

			if (correctedText.length > 0) {
				page.text = correctedText;
				page.method = 'vision_fallback';
				page.confidence = Math.max(page.confidence, 0.9); // Vision-corrected gets higher confidence
				visionFallbackCount++;
				ctx.logger.info(
					{ pageNumber: page.pageNumber, originalConfidence: pages[i].confidence },
					'Vision fallback corrected page text',
				);
			}
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);
			errors.push({
				code: EXTRACT_ERROR_CODES.EXTRACT_VISION_FALLBACK_FAILED,
				message: `Vision fallback failed for page ${page.pageNumber}: ${message}`,
			});
			ctx.logger.warn(
				{ err: error, pageNumber: page.pageNumber },
				'Vision fallback failed — using Document AI text as-is',
			);
		}
	}

	return { visionFallbackCount, visionFallbackCapped, errors };
}

// ────────────────────────────────────────────────────────────
// Force cleanup
// ────────────────────────────────────────────────────────────

/**
 * Cleans up existing extraction artifacts before re-extraction.
 * Deletes GCS extracted/ prefix and resets the source step.
 */
async function forceCleanup(sourceId: string, services: Services, pool: pg.Pool, logger: Logger): Promise<void> {
	// 1. GCS cleanup (not in DB function)
	const prefix = `extracted/${sourceId}/`;
	const existing = await services.storage.list(prefix);
	for (const path of existing.paths) {
		await services.storage.delete(path);
	}
	logger.debug({ sourceId, deletedFiles: existing.paths.length }, 'Deleted existing extraction artifacts');

	const segmentPrefix = `segments/${sourceId}/`;
	const existingSegments = await services.storage.list(segmentPrefix);
	for (const path of existingSegments.paths) {
		await services.storage.delete(path);
	}
	logger.debug({ sourceId, deletedFiles: existingSegments.paths.length }, 'Deleted downstream segment artifacts');

	// 2. Atomic DB reset — cascading-deletes stories, chunks, edges, ALL source_steps
	await resetPipelineStep(pool, sourceId, 'extract');
	logger.info({ sourceId }, 'Force cleanup complete — source status reset to ingested');
}

// ────────────────────────────────────────────────────────────
// GCS output helpers
// ────────────────────────────────────────────────────────────

/**
 * Zero-pads a page number to 3 digits.
 */
function padPageNumber(n: number): string {
	return String(n).padStart(3, '0');
}

/**
 * Writes the human-readable layout.md alongside layout.json. The Markdown
 * representation is a derived byproduct of extraction — if the storage write
 * fails, we log a warning and return normally so the overall Extract step
 * still succeeds. The authoritative output is layout.json.
 */
async function writeLayoutMarkdown(
	sourceId: string,
	layoutDoc: LayoutDocument,
	services: Services,
	logger: Logger,
): Promise<void> {
	const markdownUri = `extracted/${sourceId}/layout.md`;
	try {
		const markdown = layoutToMarkdown(layoutDoc);
		await services.storage.upload(markdownUri, markdown, 'text/markdown');
		logger.debug({ markdownUri, bytes: markdown.length }, 'Layout Markdown uploaded');
	} catch (err) {
		logger.warn({ err, markdownUri }, 'Layout Markdown write failed — extract still succeeded');
	}
}

/**
 * Writes layout.json and page images to GCS.
 * Returns the GCS URIs.
 */
async function writeToStorage(
	sourceId: string,
	layoutDoc: LayoutDocument,
	pageImages: Buffer[],
	services: Services,
	logger: Logger,
): Promise<{ layoutUri: string; pageImageUris: string[] }> {
	const layoutUri = `extracted/${sourceId}/layout.json`;
	await services.storage.upload(layoutUri, JSON.stringify(layoutDoc, null, 2), 'application/json');
	logger.debug({ layoutUri }, 'Layout JSON uploaded');

	// Write the human-readable Markdown view alongside layout.json. This is a
	// byproduct, not a core output — failures must never fail the Extract step.
	await writeLayoutMarkdown(sourceId, layoutDoc, services, logger);

	const pageImageUris: string[] = [];
	for (let i = 0; i < pageImages.length; i++) {
		const imageBuffer = pageImages[i];
		if (!imageBuffer || imageBuffer.length === 0) continue;
		const uri = `extracted/${sourceId}/pages/page-${padPageNumber(i + 1)}.png`;
		await services.storage.upload(uri, imageBuffer, 'image/png');
		pageImageUris.push(uri);
	}
	logger.debug({ pageImageCount: pageImageUris.length }, 'Page images uploaded');

	return { layoutUri, pageImageUris };
}

// ────────────────────────────────────────────────────────────
// Main execute function
// ────────────────────────────────────────────────────────────

/**
 * Executes the extract pipeline step.
 *
 * Accepts a source ID, downloads the PDF, chooses the extraction path
 * based on native text ratio, and outputs layout.json + page images to GCS.
 *
 * @param input - Extract input (sourceId, force, fallbackOnly)
 * @param config - Validated Mulder configuration
 * @param services - Service registry (storage, documentAi, llm, firestore)
 * @param pool - PostgreSQL connection pool
 * @param logger - Logger instance
 * @returns Extract result
 */
export async function execute(
	input: ExtractInput,
	config: MulderConfig,
	services: Services,
	pool: pg.Pool | undefined,
	logger: Logger,
): Promise<ExtractResult> {
	const log = createChildLogger(logger, { step: STEP_NAME, sourceId: input.sourceId });
	const startTime = performance.now();
	const stepConfigHash = getStepConfigHash(config, STEP_NAME);

	log.info({ force: input.force ?? false, fallbackOnly: input.fallbackOnly ?? false }, 'Extract step started');

	if (!pool) {
		throw new ExtractError('Database pool is required for extract step', EXTRACT_ERROR_CODES.EXTRACT_SOURCE_NOT_FOUND, {
			context: { sourceId: input.sourceId },
		});
	}

	// 1. Load source
	const source = await findSourceById(pool, input.sourceId);
	if (!source) {
		throw new ExtractError(`Source not found: ${input.sourceId}`, EXTRACT_ERROR_CODES.EXTRACT_SOURCE_NOT_FOUND, {
			context: { sourceId: input.sourceId },
		});
	}
	const route = requireExtractRoute(source.sourceType, { sourceId: input.sourceId });
	if (input.fallbackOnly) {
		assertFallbackOnlySupported(route, { sourceId: input.sourceId });
	}

	// 2. Validate status
	const validStatuses = ['ingested', 'extracted', 'segmented', 'enriched', 'embedded', 'graphed', 'analyzed'];
	if (!validStatuses.includes(source.status)) {
		throw new ExtractError(
			`Source ${input.sourceId} has invalid status "${source.status}" for extraction — must be at least "ingested"`,
			EXTRACT_ERROR_CODES.EXTRACT_INVALID_STATUS,
			{ context: { sourceId: input.sourceId, status: source.status } },
		);
	}

	// Already extracted and no --force? Skip.
	if (source.status !== 'ingested' && !input.force && !input.fallbackOnly) {
		log.info({ status: source.status }, 'Source already extracted — skipping (use --force to re-extract)');
		return {
			status: 'success',
			data: null,
			errors: [],
			metadata: {
				duration_ms: Math.round(performance.now() - startTime),
				items_processed: 0,
				items_skipped: source.pageCount ?? 0,
				items_cached: 0,
			},
		};
	}

	// 3. Force cleanup if --force
	if (input.force && source.status !== 'ingested') {
		await forceCleanup(input.sourceId, services, pool, log);
	}

	const errors: StepError[] = [];
	let extractionData: ExtractionData;

	if (!input.fallbackOnly && route.kind === 'prestructured') {
		switch (route.sourceType) {
			case 'text':
				extractionData = await extractTextSource({
					sourceId: input.sourceId,
					filename: source.filename,
					storagePath: source.storagePath,
					formatMetadata: source.formatMetadata,
					config,
					services,
					pool,
					stepConfigHash,
					logger: log,
				});
				break;
			case 'docx':
				extractionData = await extractDocxSource({
					sourceId: input.sourceId,
					filename: source.filename,
					storagePath: source.storagePath,
					config,
					services,
					pool,
					stepConfigHash,
					logger: log,
				});
				break;
			case 'spreadsheet':
				extractionData = await extractSpreadsheetSource({
					sourceId: input.sourceId,
					filename: source.filename,
					storagePath: source.storagePath,
					formatMetadata: source.formatMetadata,
					config,
					services,
					pool,
					stepConfigHash,
					logger: log,
				});
				break;
			case 'email':
				extractionData = await extractEmailSource({
					sourceId: input.sourceId,
					filename: source.filename,
					storagePath: source.storagePath,
					formatMetadata: source.formatMetadata,
					config,
					services,
					pool,
					stepConfigHash,
					logger: log,
				});
				break;
			case 'url':
				extractionData = await extractUrlSource({
					sourceId: input.sourceId,
					filename: source.filename,
					storagePath: source.storagePath,
					formatMetadata: source.formatMetadata,
					config,
					services,
					pool,
					stepConfigHash,
					logger: log,
				});
				break;
		}
	} else if (input.fallbackOnly) {
		log.info('Running vision fallback only on existing extraction');

		// Download existing layout.json
		const layoutUri = `extracted/${input.sourceId}/layout.json`;
		let existingLayout: LayoutDocument;
		try {
			const layoutBuffer = await services.storage.download(layoutUri);
			existingLayout = JSON.parse(layoutBuffer.toString('utf-8'));
		} catch (cause: unknown) {
			throw new ExtractError(
				`Cannot run fallback-only: layout.json not found for source ${input.sourceId}`,
				EXTRACT_ERROR_CODES.EXTRACT_STORAGE_FAILED,
				{ cause, context: { sourceId: input.sourceId, layoutUri } },
			);
		}

		// Download existing page images
		const pageImages: Buffer[] = [];
		for (let i = 0; i < existingLayout.pageCount; i++) {
			const imageUri = `extracted/${input.sourceId}/pages/page-${padPageNumber(i + 1)}.png`;
			try {
				pageImages.push(await services.storage.download(imageUri));
			} catch {
				pageImages.push(Buffer.alloc(0));
			}
		}

		// Run vision fallback on low-confidence pages
		const fallbackResult = await runVisionFallback(
			existingLayout.pages,
			pageImages,
			config.extraction.confidence_threshold,
			{
				services,
				config,
				logger: log,
				maxVisionPages: config.extraction.max_vision_pages,
			},
		);

		existingLayout.metadata.visionFallbackCount += fallbackResult.visionFallbackCount;
		existingLayout.metadata.visionFallbackCapped = fallbackResult.visionFallbackCapped;
		errors.push(...fallbackResult.errors);

		// Re-upload updated layout.json and refresh the derived layout.md.
		await services.storage.upload(layoutUri, JSON.stringify(existingLayout, null, 2), 'application/json');
		await writeLayoutMarkdown(input.sourceId, existingLayout, services, log);

		extractionData = {
			sourceId: input.sourceId,
			layoutUri,
			pageImageUris: pageImages.map((_, i) => `extracted/${input.sourceId}/pages/page-${padPageNumber(i + 1)}.png`),
			pageCount: existingLayout.pageCount,
			primaryMethod: existingLayout.primaryMethod,
			pages: existingLayout.pages.map((p) => ({
				pageNumber: p.pageNumber,
				method: p.method,
				confidence: p.confidence,
				text: p.text,
			})),
			visionFallbackCount: existingLayout.metadata.visionFallbackCount,
			visionFallbackCapped: existingLayout.metadata.visionFallbackCapped,
		};
	} else {
		// ── Path A or B: Full extraction ────────────────────
		// 3. Download source original
		const storagePath = source.storagePath;
		let sourceBuffer: Buffer;
		try {
			sourceBuffer = await services.storage.download(storagePath);
		} catch (cause: unknown) {
			throw new ExtractError(
				`Failed to download source original for source ${input.sourceId}`,
				EXTRACT_ERROR_CODES.EXTRACT_STORAGE_FAILED,
				{ cause, context: { sourceId: input.sourceId, storagePath } },
			);
		}

		// 4. Choose extraction path
		const sourceMediaType = resolveSourceMediaType(source, sourceBuffer);
		if (!sourceMediaType) {
			throw new ExtractError(
				`Unable to resolve image media type for source ${input.sourceId}`,
				EXTRACT_ERROR_CODES.EXTRACT_INVALID_STATUS,
				{ context: { sourceId: input.sourceId, sourceType: source.sourceType } },
			);
		}
		const nativeTextRatio = source.sourceType === 'image' ? 0 : source.nativeTextRatio;
		const threshold = config.extraction.native_text_threshold;
		const isNativePath = source.sourceType === 'pdf' && nativeTextRatio >= threshold;

		log.info(
			{
				nativeTextRatio,
				threshold,
				sourceType: source.sourceType,
				mediaType: sourceMediaType,
				path: isNativePath ? 'native' : 'document_ai',
			},
			'Extraction path selected',
		);

		const layoutPages: LayoutPage[] = [];
		let pageImages: Buffer[] = [];
		let primaryMethod: 'native' | 'document_ai';
		let documentAiRaw: Record<string, unknown> | undefined;
		let visionFallbackCount = 0;
		let visionFallbackCapped = false;

		if (isNativePath) {
			// ── Path A: Native text ───────────────────────────
			primaryMethod = 'native';

			try {
				const pageTexts = await extractNativeText(sourceBuffer, log);

				for (let i = 0; i < pageTexts.length; i++) {
					layoutPages.push({
						pageNumber: i + 1,
						method: 'native',
						confidence: 1.0,
						text: pageTexts[i],
					});
				}
			} catch (cause: unknown) {
				throw new ExtractError(
					`Native text extraction failed for source ${input.sourceId}`,
					EXTRACT_ERROR_CODES.EXTRACT_NATIVE_TEXT_FAILED,
					{ cause, context: { sourceId: input.sourceId } },
				);
			}

			// Render page images from PDF
			try {
				pageImages = await renderPageImages(sourceBuffer, log);
			} catch (cause: unknown) {
				log.warn({ err: cause }, 'Page image rendering failed — continuing without images');
			}
		} else {
			// ── Path B: Document AI ───────────────────────────
			primaryMethod = 'document_ai';

			let docAiResult: DocumentAiResult;
			try {
				docAiResult = await services.documentAi.processDocument(sourceBuffer, input.sourceId, sourceMediaType);
			} catch (cause: unknown) {
				throw new ExtractError(
					`Document AI processing failed for source ${input.sourceId}`,
					EXTRACT_ERROR_CODES.EXTRACT_DOCUMENT_AI_FAILED,
					{ cause, context: { sourceId: input.sourceId } },
				);
			}

			documentAiRaw = docAiResult.document;
			pageImages = docAiResult.pageImages;
			if (source.sourceType === 'image' && pageImages.length === 0) {
				const imagePage = await renderImagePageImage(sourceBuffer, sourceMediaType, log);
				if (imagePage) {
					pageImages = [imagePage];
				}
			}

			// Parse the Document AI result into per-page data
			const parsedPages = parseDocumentAiResult(docAiResult.document);
			if (source.sourceType === 'image' && parsedPages.length === 0) {
				parsedPages.push({
					pageNumber: 1,
					confidence: 0.9,
					text: '',
					blocks: [],
				});
			}

			for (const parsed of parsedPages) {
				layoutPages.push({
					pageNumber: parsed.pageNumber,
					method: 'document_ai',
					confidence: parsed.confidence,
					text: parsed.text,
					blocks: parsed.blocks,
				});
			}

			// Run Gemini Vision fallback on low-confidence pages
			const fallbackResult = await runVisionFallback(layoutPages, pageImages, config.extraction.confidence_threshold, {
				services,
				config,
				logger: log,
				maxVisionPages: config.extraction.max_vision_pages,
			});

			visionFallbackCount = fallbackResult.visionFallbackCount;
			visionFallbackCapped = fallbackResult.visionFallbackCapped;
			errors.push(...fallbackResult.errors);
		}

		// 5. Build layout document
		const layoutDoc: LayoutDocument = {
			sourceId: input.sourceId,
			pageCount: layoutPages.length,
			primaryMethod,
			extractedAt: new Date().toISOString(),
			pages: layoutPages,
			metadata: {
				visionFallbackCount,
				visionFallbackCapped,
				documentAiRaw: primaryMethod === 'document_ai' ? documentAiRaw : undefined,
			},
		};

		// 6. Write to GCS
		const { layoutUri, pageImageUris } = await writeToStorage(input.sourceId, layoutDoc, pageImages, services, log);

		extractionData = {
			sourceId: input.sourceId,
			layoutUri,
			pageImageUris,
			pageCount: layoutPages.length,
			primaryMethod,
			pages: layoutPages.map((p) => ({
				pageNumber: p.pageNumber,
				method: p.method,
				confidence: p.confidence,
				text: p.text,
			})),
			visionFallbackCount,
			visionFallbackCapped,
		};

		// 7. Update database
		await updateSourceStatus(pool, input.sourceId, 'extracted');
		await upsertSourceStep(pool, {
			sourceId: input.sourceId,
			stepName: STEP_NAME,
			status: 'completed',
			configHash: stepConfigHash,
		});
	}

	// 8. Firestore observability (fire-and-forget)
	services.firestore
		.setDocument('documents', input.sourceId, {
			status: 'extracted',
			extractedAt: new Date().toISOString(),
			primaryMethod: extractionData.primaryMethod,
			pageCount: extractionData.pageCount,
			visionFallbackCount: extractionData.visionFallbackCount,
			visionFallbackCapped: extractionData.visionFallbackCapped,
		})
		.catch(() => {
			// Silently swallow — Firestore is best-effort observability
		});

	// 9. Determine overall status
	let status: 'success' | 'partial' | 'failed';
	if (errors.length === 0) {
		status = 'success';
	} else if (extractionData.pages.length > 0) {
		status = 'partial';
	} else {
		status = 'failed';
	}

	const durationMs = Math.round(performance.now() - startTime);

	log.info(
		{
			status,
			pageCount: extractionData.pageCount,
			primaryMethod: extractionData.primaryMethod,
			visionFallbackCount: extractionData.visionFallbackCount,
			visionFallbackCapped: extractionData.visionFallbackCapped,
			errors: errors.length,
			duration_ms: durationMs,
		},
		'Extract step completed',
	);

	return {
		status,
		data: extractionData,
		errors,
		metadata: {
			duration_ms: durationMs,
			items_processed: extractionData.pageCount,
			items_skipped: 0,
			items_cached: 0,
		},
	};
}
