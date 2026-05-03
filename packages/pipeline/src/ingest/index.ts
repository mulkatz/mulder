/**
 * Ingest pipeline step — the entry point for all documents into Mulder.
 *
 * Accepts supported source files (single file or directory), validates them,
 * uploads to Cloud Storage, and registers them as sources
 * in PostgreSQL.
 *
 * @see docs/specs/16_ingest_step.spec.md
 * @see docs/functional-spec.md §2.1
 */

import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import type {
	Logger,
	MulderConfig,
	PdfMetadata,
	Services,
	SourceFormatMetadata,
	SourceType,
	StepError,
	UrlExtractionResult,
	UrlFetchResult,
	UrlRenderResult,
} from '@mulder/core';
import {
	createChildLogger,
	createSource,
	detectNativeText,
	extractPdfMetadata,
	findSourceByHash,
	INGEST_ERROR_CODES,
	IngestError,
	MulderError,
	upsertSourceStep,
} from '@mulder/core';
import type pg from 'pg';
import {
	buildDocxFormatMetadata,
	buildEmailFormatMetadata,
	buildImageFormatMetadata,
	buildSpreadsheetFormatMetadata,
	buildTextFormatMetadata,
	buildUrlFormatMetadata,
	CSV_MEDIA_TYPE,
	detectSourceType,
	getStorageExtensionForDetection,
	isSupportedEmailMediaType,
	isSupportedImageMediaType,
	isSupportedIngestFilename,
	isSupportedSpreadsheetMediaType,
	isSupportedTextFilename,
	isSupportedTextMediaType,
	isUrlLikeInput,
	normalizeUrlInput,
	sanitizeUrlInputForDisplay,
	URL_SNAPSHOT_MEDIA_TYPE,
} from './source-type.js';
import type { IngestFileResult, IngestInput, IngestResult } from './types.js';

export type {
	ImageDimensions,
	SourceDetectionConfidence,
	SourceDetectionResult,
	SourceStorageExtension,
	SupportedDocxMediaType,
	SupportedEmailMediaType,
	SupportedImageMediaType,
	SupportedSpreadsheetMediaType,
	SupportedTextMediaType,
	SupportedUrlSnapshotMediaType,
} from './source-type.js';
export {
	buildDocxFormatMetadata,
	buildEmailFormatMetadata,
	buildImageFormatMetadata,
	buildSpreadsheetFormatMetadata,
	buildTextFormatMetadata,
	buildUrlFormatMetadata,
	CSV_MEDIA_TYPE,
	DOCX_MEDIA_TYPE,
	decodeUtf8TextBuffer,
	detectSourceType,
	EML_MEDIA_TYPE,
	getCanonicalStorageExtensionForMediaType,
	getOriginalExtension,
	getStorageExtensionForDetection,
	isOfficeOpenXmlDocx,
	isOfficeOpenXmlSpreadsheet,
	isReadableText,
	isSupportedDocxFilename,
	isSupportedDocxMediaType,
	isSupportedEmailFilename,
	isSupportedEmailMediaType,
	isSupportedImageMediaType,
	isSupportedIngestFilename,
	isSupportedSpreadsheetFilename,
	isSupportedSpreadsheetMediaType,
	isSupportedTextFilename,
	isSupportedTextMediaType,
	isSupportedUrlInput,
	isUrlLikeInput,
	MSG_MEDIA_TYPE,
	normalizeUrlInput,
	readImageDimensions,
	sanitizeUrlInputForDisplay,
	URL_SNAPSHOT_MEDIA_TYPE,
	XLSX_MEDIA_TYPE,
} from './source-type.js';
export type { IngestFileResult, IngestInput, IngestResult } from './types.js';

const STEP_NAME = 'ingest';

// ────────────────────────────────────────────────────────────
// File resolution
// ────────────────────────────────────────────────────────────

/**
 * Resolves the input path to a list of supported ingest file paths.
 * If the path is a directory, recursively finds supported ingest files.
 * If the path is a single file, returns it as-is so validation can report
 * an explicit unsupported-format error.
 */
export async function resolveIngestFiles(inputPath: string): Promise<string[]> {
	if (isUrlLikeInput(inputPath)) {
		return [inputPath.trim()];
	}

	const resolved = resolve(inputPath);
	const stats = await stat(resolved).catch(() => null);

	if (!stats) {
		throw new IngestError(`Path not found: ${resolved}`, INGEST_ERROR_CODES.INGEST_FILE_NOT_FOUND, {
			context: { path: resolved },
		});
	}

	if (stats.isFile()) {
		return [resolved];
	}

	if (stats.isDirectory()) {
		const entries = await readdir(resolved, { recursive: true });
		const ingestFiles: string[] = [];
		for (const entry of entries) {
			if (isSupportedIngestFilename(entry)) {
				ingestFiles.push(join(resolved, entry));
			}
		}
		return ingestFiles.sort();
	}

	throw new IngestError(
		`Path is neither a file nor a directory: ${resolved}`,
		INGEST_ERROR_CODES.INGEST_FILE_NOT_FOUND,
		{
			context: { path: resolved },
		},
	);
}

export const resolvePdfFiles = resolveIngestFiles;

// ────────────────────────────────────────────────────────────
// Validation helpers
// ────────────────────────────────────────────────────────────

/**
 * Computes the SHA-256 hash of a buffer, returned as a hex string.
 */
function computeFileHash(buffer: Buffer): string {
	return createHash('sha256').update(buffer).digest('hex');
}

function buildPdfFormatMetadata(pdfMeta: PdfMetadata): Record<string, unknown> {
	const pdfMetadataJson: Record<string, unknown> = {};
	if (pdfMeta.pdfVersion) pdfMetadataJson.pdf_version = pdfMeta.pdfVersion;
	if (pdfMeta.title) pdfMetadataJson.title = pdfMeta.title;
	if (pdfMeta.author) pdfMetadataJson.author = pdfMeta.author;
	if (pdfMeta.creator) pdfMetadataJson.creator = pdfMeta.creator;
	if (pdfMeta.producer) pdfMetadataJson.producer = pdfMeta.producer;
	if (pdfMeta.creationDate) pdfMetadataJson.creation_date = pdfMeta.creationDate.toISOString();
	if (pdfMeta.modificationDate) pdfMetadataJson.modification_date = pdfMeta.modificationDate.toISOString();
	if (pdfMeta.encrypted !== undefined) pdfMetadataJson.encrypted = pdfMeta.encrypted;
	return pdfMetadataJson;
}

// ────────────────────────────────────────────────────────────
// Per-file processing
// ────────────────────────────────────────────────────────────

interface ProcessFileContext {
	config: MulderConfig;
	services: Services;
	pool: pg.Pool | undefined;
	logger: Logger;
	tags?: string[];
	dryRun: boolean;
}

type IngestibleSourceType = Extract<SourceType, 'pdf' | 'image' | 'text' | 'docx' | 'spreadsheet' | 'email' | 'url'>;

interface PreparedFileMetadata {
	sourceType: IngestibleSourceType;
	mediaType: string;
	storageExtension: string;
	formatMetadata: SourceFormatMetadata;
	pageCount: number;
	hasNativeText: boolean;
	nativeTextRatio: number;
	pdfMetadata?: PdfMetadata;
}

function isIngestibleSourceType(sourceType: SourceType): sourceType is IngestibleSourceType {
	return (
		sourceType === 'pdf' ||
		sourceType === 'image' ||
		sourceType === 'text' ||
		sourceType === 'docx' ||
		sourceType === 'spreadsheet' ||
		sourceType === 'email' ||
		sourceType === 'url'
	);
}

function htmlTitle(html: Buffer): string | null {
	const match = html.toString('utf-8').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
	const title = match?.[1]
		?.replace(/<[^>]+>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	return title && title.length > 0 ? title : null;
}

function slugifyFilenamePart(value: string): string {
	return (
		value
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 80) || 'page'
	);
}

function filenameForUrlSnapshot(html: Buffer, finalUrl: string, extractedTitle?: string): string {
	const title = extractedTitle ?? htmlTitle(html);
	const final = new URL(finalUrl);
	const pathPart = final.pathname === '/' ? final.hostname : `${final.hostname}${final.pathname}`;
	const basis = title ? `${title}-${final.hostname}` : pathPart;
	return `${slugifyFilenamePart(basis)}.html`;
}

interface PreparedUrlSnapshot {
	html: Buffer;
	finalUrl: string;
	title: string | null;
	formatMetadata: SourceFormatMetadata;
	renderingMethod: 'static' | 'playwright';
}

function errorCode(error: unknown): string {
	return error instanceof MulderError ? error.code : error instanceof Error ? error.name : 'UNKNOWN';
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function probeUrlSnapshot(input: {
	services: Services;
	html: Buffer;
	sourceId: string;
	fetchMetadata: SourceFormatMetadata;
}): Promise<UrlExtractionResult> {
	return await input.services.urlExtractors.extractUrl(input.html, input.sourceId, input.fetchMetadata);
}

async function prepareUrlSnapshot(
	fetchResult: UrlFetchResult,
	ctx: ProcessFileContext,
	displayUrl: string,
	log: Logger,
): Promise<PreparedUrlSnapshot> {
	const staticTitle = htmlTitle(fetchResult.html);
	const staticMetadata = buildUrlFormatMetadata(fetchResult, staticTitle ?? undefined);
	try {
		const staticProbe = await probeUrlSnapshot({
			services: ctx.services,
			html: fetchResult.html,
			sourceId: 'url-static-readability-probe',
			fetchMetadata: staticMetadata,
		});
		return {
			html: fetchResult.html,
			finalUrl: fetchResult.finalUrl,
			title: staticProbe.title || staticTitle,
			formatMetadata: buildUrlFormatMetadata(fetchResult, staticProbe.title || staticTitle || undefined),
			renderingMethod: 'static',
		};
	} catch (staticError: unknown) {
		const staticReadabilityError = errorCode(staticError);
		log.info({ staticReadabilityError }, 'Static URL snapshot unreadable, attempting render fallback');
		let renderResult: UrlRenderResult;
		try {
			renderResult = await ctx.services.urlRenderers.renderUrl(fetchResult.finalUrl, {
				maxBytes: ctx.config.ingestion.max_file_size_mb * 1024 * 1024,
			});
		} catch (cause: unknown) {
			throw new IngestError(
				`URL render fallback failed for ${displayUrl}`,
				INGEST_ERROR_CODES.INGEST_URL_RENDER_FAILED,
				{
					cause,
					context: { url: displayUrl, staticReadabilityError },
				},
			);
		}
		const renderingMetadata = {
			result: renderResult,
			fallbackReason: 'static_unreadable',
			staticReadabilityError,
			renderedFromUrl: fetchResult.finalUrl,
		};
		const renderedTitle = htmlTitle(renderResult.html);
		const renderedMetadata = buildUrlFormatMetadata(fetchResult, renderedTitle ?? undefined, renderingMetadata);
		let renderedProbe: UrlExtractionResult;
		try {
			renderedProbe = await probeUrlSnapshot({
				services: ctx.services,
				html: renderResult.html,
				sourceId: 'url-rendered-readability-probe',
				fetchMetadata: renderedMetadata,
			});
		} catch (cause: unknown) {
			throw new IngestError(
				`Rendered URL snapshot was not readable for ${displayUrl}`,
				INGEST_ERROR_CODES.INGEST_URL_RENDER_FAILED,
				{
					cause,
					context: {
						url: displayUrl,
						staticReadabilityError,
						renderedReadabilityError: errorCode(cause),
						renderedErrorMessage: errorMessage(cause),
					},
				},
			);
		}
		return {
			html: renderResult.html,
			finalUrl: renderResult.finalUrl,
			title: renderedProbe.title || renderedTitle,
			formatMetadata: buildUrlFormatMetadata(
				fetchResult,
				renderedProbe.title || renderedTitle || undefined,
				renderingMetadata,
			),
			renderingMethod: 'playwright',
		};
	}
}

async function processUrl(inputUrl: string, ctx: ProcessFileContext): Promise<IngestFileResult> {
	const normalizedUrl = normalizeUrlInput(inputUrl);
	const displayUrl = normalizedUrl ? sanitizeUrlInputForDisplay(normalizedUrl) : sanitizeUrlInputForDisplay(inputUrl);
	if (!normalizedUrl) {
		throw new IngestError(`Unsupported URL input: ${displayUrl}`, INGEST_ERROR_CODES.INGEST_UNSUPPORTED_SOURCE_TYPE, {
			context: { input: displayUrl },
		});
	}

	const log = createChildLogger(ctx.logger, { step: STEP_NAME, url: displayUrl });
	let fetchResult: Awaited<ReturnType<Services['urls']['fetchUrl']>>;
	try {
		fetchResult = await ctx.services.urls.fetchUrl(inputUrl, {
			maxBytes: ctx.config.ingestion.max_file_size_mb * 1024 * 1024,
		});
	} catch (cause: unknown) {
		throw new IngestError(`URL fetch failed for ${displayUrl}`, INGEST_ERROR_CODES.INGEST_URL_FETCH_FAILED, {
			cause,
			context: { url: displayUrl },
		});
	}

	const prepared = await prepareUrlSnapshot(fetchResult, ctx, displayUrl, log);
	const filename = filenameForUrlSnapshot(prepared.html, prepared.finalUrl, prepared.title ?? undefined);
	const fileHash = computeFileHash(prepared.html);
	const formatMetadata = prepared.formatMetadata;

	if (ctx.pool) {
		const existing = await findSourceByHash(ctx.pool, fileHash);
		if (existing) {
			log.info({ sourceId: existing.id, fileHash }, 'Duplicate URL snapshot detected, skipping upload');
			return {
				sourceId: existing.id,
				filename,
				storagePath: existing.storagePath,
				fileHash,
				sourceType: existing.sourceType,
				formatMetadata: existing.formatMetadata,
				pageCount: existing.pageCount ?? 0,
				hasNativeText: existing.hasNativeText,
				nativeTextRatio: existing.nativeTextRatio,
				duplicate: true,
			};
		}
	}

	const sourceId = randomUUID();
	const storagePath = `raw/${sourceId}/original.html`;
	if (ctx.dryRun) {
		log.info(
			{ sourceId, filename, renderingMethod: prepared.renderingMethod },
			'Dry run — skipping URL snapshot upload and DB insert',
		);
		return {
			sourceId,
			filename,
			storagePath,
			fileHash,
			sourceType: 'url',
			formatMetadata,
			pageCount: 0,
			hasNativeText: false,
			nativeTextRatio: 0,
			duplicate: false,
		};
	}

	if (!ctx.pool) {
		throw new IngestError(
			'Database pool is required for non-dry-run URL ingest',
			INGEST_ERROR_CODES.INGEST_UPLOAD_FAILED,
			{
				context: { url: displayUrl },
			},
		);
	}

	try {
		await ctx.services.storage.upload(storagePath, prepared.html, URL_SNAPSHOT_MEDIA_TYPE);
	} catch (cause: unknown) {
		throw new IngestError(`Upload failed for URL snapshot ${displayUrl}`, INGEST_ERROR_CODES.INGEST_UPLOAD_FAILED, {
			cause,
			context: { url: displayUrl, storagePath },
		});
	}

	const source = await createSource(ctx.pool, {
		id: sourceId,
		filename,
		storagePath,
		fileHash,
		sourceType: 'url',
		formatMetadata,
		pageCount: 0,
		hasNativeText: false,
		nativeTextRatio: 0,
		tags: ctx.tags,
		metadata: formatMetadata,
	});

	if (source.id !== sourceId) {
		await ctx.services.storage.delete(storagePath).catch(() => undefined);
		return {
			sourceId: source.id,
			filename,
			storagePath: source.storagePath,
			fileHash,
			sourceType: source.sourceType,
			formatMetadata: source.formatMetadata,
			pageCount: source.pageCount ?? 0,
			hasNativeText: source.hasNativeText,
			nativeTextRatio: source.nativeTextRatio,
			duplicate: true,
		};
	}

	await upsertSourceStep(ctx.pool, {
		sourceId: source.id,
		stepName: STEP_NAME,
		status: 'completed',
	});
	ctx.services.firestore
		.setDocument('documents', source.id, {
			filename,
			sourceType: 'url',
			uploadedAt: new Date().toISOString(),
			fileHash,
			status: 'ingested',
		})
		.catch(() => undefined);

	return {
		sourceId: source.id,
		filename,
		storagePath: source.storagePath,
		fileHash,
		sourceType: source.sourceType,
		formatMetadata: source.formatMetadata,
		pageCount: source.pageCount ?? 0,
		hasNativeText: source.hasNativeText,
		nativeTextRatio: source.nativeTextRatio,
		duplicate: false,
	};
}

/**
 * Processes a single supported file through the ingest pipeline.
 */
async function processFile(filePath: string, ctx: ProcessFileContext): Promise<IngestFileResult> {
	const filename = basename(filePath);
	const log = createChildLogger(ctx.logger, { step: STEP_NAME, file: filename });

	// a. Check file exists
	const fileStats = await stat(filePath).catch(() => null);
	if (!fileStats?.isFile()) {
		throw new IngestError(`File not found: ${filePath}`, INGEST_ERROR_CODES.INGEST_FILE_NOT_FOUND, {
			context: { path: filePath },
		});
	}

	// b. Detect source type with magic bytes before extension fallback.
	const buffer = await readFile(filePath);
	const detection = detectSourceType(buffer, filePath);

	if (!detection) {
		if (filename.toLowerCase().endsWith('.pdf')) {
			throw new IngestError(
				`Not a valid PDF file (missing %PDF- header): ${filename}`,
				INGEST_ERROR_CODES.INGEST_NOT_PDF,
				{
					context: { path: filePath },
				},
			);
		}
		if (filename.toLowerCase().endsWith('.docx')) {
			throw new IngestError(
				`Not a valid DOCX file (missing Office Open XML document entries): ${filename}`,
				INGEST_ERROR_CODES.INGEST_UNSUPPORTED_SOURCE_TYPE,
				{
					context: { path: filePath },
				},
			);
		}
		if (filename.toLowerCase().endsWith('.xlsx')) {
			throw new IngestError(
				`Not a valid XLSX spreadsheet (missing Office Open XML spreadsheet entries): ${filename}`,
				INGEST_ERROR_CODES.INGEST_UNSUPPORTED_SOURCE_TYPE,
				{
					context: { path: filePath },
				},
			);
		}
		if (filename.toLowerCase().endsWith('.csv')) {
			throw new IngestError(
				`Not a valid CSV spreadsheet (requires readable UTF-8 delimited rows): ${filename}`,
				INGEST_ERROR_CODES.INGEST_UNSUPPORTED_SOURCE_TYPE,
				{
					context: { path: filePath },
				},
			);
		}
		if (filename.toLowerCase().endsWith('.eml')) {
			throw new IngestError(
				`Not a valid EML email message (requires RFC 822/MIME headers and body): ${filename}`,
				INGEST_ERROR_CODES.INGEST_UNSUPPORTED_SOURCE_TYPE,
				{
					context: { path: filePath },
				},
			);
		}
		if (filename.toLowerCase().endsWith('.msg')) {
			throw new IngestError(
				`Not a valid Outlook MSG email message (requires OLE compound message evidence): ${filename}`,
				INGEST_ERROR_CODES.INGEST_UNSUPPORTED_SOURCE_TYPE,
				{
					context: { path: filePath },
				},
			);
		}
		throw new IngestError(
			`Unsupported or unknown source format for ${filename}`,
			INGEST_ERROR_CODES.INGEST_UNKNOWN_SOURCE_TYPE,
			{
				context: { path: filePath },
			},
		);
	}

	if (!isIngestibleSourceType(detection.sourceType)) {
		throw new IngestError(
			`Unsupported source type "${detection.sourceType}" for ${filename}; only pdf, image, text, docx, spreadsheet, and email are supported in this step`,
			INGEST_ERROR_CODES.INGEST_UNSUPPORTED_SOURCE_TYPE,
			{
				context: { path: filePath, sourceType: detection.sourceType, confidence: detection.confidence },
			},
		);
	}

	// c. Check file size
	const fileSizeMb = buffer.length / (1024 * 1024);
	const maxSizeMb = ctx.config.ingestion.max_file_size_mb;
	if (fileSizeMb > maxSizeMb) {
		throw new IngestError(
			`File too large: ${filename} is ${fileSizeMb.toFixed(2)} MB, max is ${maxSizeMb} MB`,
			INGEST_ERROR_CODES.INGEST_FILE_TOO_LARGE,
			{ context: { path: filePath, fileSizeMb, maxSizeMb } },
		);
	}

	let prepared: PreparedFileMetadata;
	const storageExtension = getStorageExtensionForDetection(detection);
	if (!storageExtension || !detection.mediaType) {
		throw new IngestError(
			`Unsupported or unknown source format for ${filename}`,
			INGEST_ERROR_CODES.INGEST_UNKNOWN_SOURCE_TYPE,
			{
				context: { path: filePath, sourceType: detection.sourceType, mediaType: detection.mediaType },
			},
		);
	}

	if (detection.sourceType === 'pdf') {
		// d. Lightweight PDF metadata extraction (no page content decompression).
		//    Reads page count from the trailer/page tree root — PDF bomb gate.
		const pdfMeta = await extractPdfMetadata(buffer);

		// e. Check page count BEFORE full parse — rejects PDF bombs early
		const maxPages = ctx.config.ingestion.max_pages;
		if (pdfMeta.pageCount > maxPages) {
			throw new IngestError(
				`Too many pages: ${filename} has ${pdfMeta.pageCount} pages, max is ${maxPages}`,
				INGEST_ERROR_CODES.INGEST_TOO_MANY_PAGES,
				{ context: { path: filePath, pageCount: pdfMeta.pageCount, maxPages } },
			);
		}

		log.debug(
			{ sourceType: 'pdf', pageCount: pdfMeta.pageCount, pdfVersion: pdfMeta.pdfVersion, title: pdfMeta.title },
			'PDF metadata extracted (lightweight)',
		);

		const textResult = await detectNativeText(buffer);
		prepared = {
			sourceType: 'pdf',
			mediaType: detection.mediaType,
			storageExtension,
			formatMetadata: buildPdfFormatMetadata(pdfMeta),
			pageCount: textResult.pageCount,
			hasNativeText: textResult.hasNativeText,
			nativeTextRatio: textResult.nativeTextRatio,
			pdfMetadata: pdfMeta,
		};
	} else if (detection.sourceType === 'image') {
		if (!isSupportedImageMediaType(detection.mediaType)) {
			throw new IngestError(
				`Unsupported image media type for ${filename}`,
				INGEST_ERROR_CODES.INGEST_UNSUPPORTED_SOURCE_TYPE,
				{
					context: { path: filePath, mediaType: detection.mediaType },
				},
			);
		}

		prepared = {
			sourceType: 'image',
			mediaType: detection.mediaType,
			storageExtension,
			formatMetadata: buildImageFormatMetadata(buffer, filename, detection.mediaType),
			pageCount: 1,
			hasNativeText: false,
			nativeTextRatio: 0,
		};
		log.debug({ sourceType: 'image', mediaType: detection.mediaType, pageCount: 1 }, 'Image metadata prepared');
	} else if (detection.sourceType === 'text') {
		if (!isSupportedTextFilename(filename)) {
			throw new IngestError(
				`Unsupported text source extension for ${filename}; supported text files must end with .txt, .md, or .markdown`,
				INGEST_ERROR_CODES.INGEST_UNSUPPORTED_SOURCE_TYPE,
				{
					context: { path: filePath, sourceType: detection.sourceType, confidence: detection.confidence },
				},
			);
		}

		if (!isSupportedTextMediaType(detection.mediaType)) {
			throw new IngestError(
				`Unsupported text media type for ${filename}`,
				INGEST_ERROR_CODES.INGEST_UNSUPPORTED_SOURCE_TYPE,
				{
					context: { path: filePath, mediaType: detection.mediaType },
				},
			);
		}

		const formatMetadata = buildTextFormatMetadata(buffer, filename, detection.mediaType);
		if (!formatMetadata) {
			throw new IngestError(
				`Text source is not readable UTF-8: ${filename}`,
				INGEST_ERROR_CODES.INGEST_UNSUPPORTED_SOURCE_TYPE,
				{
					context: { path: filePath, mediaType: detection.mediaType },
				},
			);
		}

		prepared = {
			sourceType: 'text',
			mediaType: typeof formatMetadata.media_type === 'string' ? formatMetadata.media_type : detection.mediaType,
			storageExtension,
			formatMetadata,
			pageCount: 0,
			hasNativeText: false,
			nativeTextRatio: 0,
		};
		log.debug({ sourceType: 'text', mediaType: prepared.mediaType, pageCount: 0 }, 'Text metadata prepared');
	} else if (detection.sourceType === 'docx') {
		prepared = {
			sourceType: 'docx',
			mediaType: detection.mediaType,
			storageExtension,
			formatMetadata: buildDocxFormatMetadata(buffer, filename),
			pageCount: 0,
			hasNativeText: false,
			nativeTextRatio: 0,
		};
		log.debug({ sourceType: 'docx', mediaType: detection.mediaType, pageCount: 0 }, 'DOCX metadata prepared');
	} else if (detection.sourceType === 'spreadsheet') {
		if (!isSupportedSpreadsheetMediaType(detection.mediaType)) {
			throw new IngestError(
				`Unsupported spreadsheet media type for ${filename}`,
				INGEST_ERROR_CODES.INGEST_UNSUPPORTED_SOURCE_TYPE,
				{
					context: { path: filePath, mediaType: detection.mediaType },
				},
			);
		}

		let extractionResult: Awaited<ReturnType<Services['spreadsheets']['extractSpreadsheet']>>;
		try {
			extractionResult = await ctx.services.spreadsheets.extractSpreadsheet(
				buffer,
				filename,
				detection.mediaType === CSV_MEDIA_TYPE ? 'csv' : 'xlsx',
			);
		} catch (cause: unknown) {
			throw new IngestError(
				`Invalid spreadsheet source: ${filename}`,
				INGEST_ERROR_CODES.INGEST_UNSUPPORTED_SOURCE_TYPE,
				{
					cause,
					context: { path: filePath, mediaType: detection.mediaType },
				},
			);
		}

		prepared = {
			sourceType: 'spreadsheet',
			mediaType: detection.mediaType,
			storageExtension,
			formatMetadata: buildSpreadsheetFormatMetadata(buffer, filename, detection.mediaType, extractionResult),
			pageCount: 0,
			hasNativeText: false,
			nativeTextRatio: 0,
		};
		log.debug(
			{ sourceType: 'spreadsheet', mediaType: detection.mediaType, sheetCount: extractionResult.sheets.length },
			'Spreadsheet metadata prepared',
		);
	} else {
		if (!isSupportedEmailMediaType(detection.mediaType)) {
			throw new IngestError(
				`Unsupported email media type for ${filename}`,
				INGEST_ERROR_CODES.INGEST_UNSUPPORTED_SOURCE_TYPE,
				{
					context: { path: filePath, mediaType: detection.mediaType },
				},
			);
		}

		let extractionResult: Awaited<ReturnType<Services['emails']['extractEmail']>>;
		try {
			extractionResult = await ctx.services.emails.extractEmail(
				buffer,
				filename,
				detection.mediaType === 'message/rfc822' ? 'eml' : 'msg',
			);
		} catch (cause: unknown) {
			throw new IngestError(`Invalid email source: ${filename}`, INGEST_ERROR_CODES.INGEST_UNSUPPORTED_SOURCE_TYPE, {
				cause,
				context: { path: filePath, mediaType: detection.mediaType },
			});
		}

		prepared = {
			sourceType: 'email',
			mediaType: detection.mediaType,
			storageExtension,
			formatMetadata: buildEmailFormatMetadata(buffer, filename, detection.mediaType, extractionResult),
			pageCount: 0,
			hasNativeText: false,
			nativeTextRatio: 0,
		};
		log.debug(
			{ sourceType: 'email', mediaType: detection.mediaType, attachmentCount: extractionResult.attachments.length },
			'Email metadata prepared',
		);
	}

	// f. Compute SHA-256 hash
	const fileHash = computeFileHash(buffer);

	// g. Check for duplicate (skip when pool is unavailable, e.g. dry-run)
	if (ctx.pool) {
		const existing = await findSourceByHash(ctx.pool, fileHash);
		if (existing) {
			log.info({ sourceId: existing.id, fileHash }, 'Duplicate file detected, skipping upload');
			return {
				sourceId: existing.id,
				filename,
				storagePath: existing.storagePath,
				fileHash,
				sourceType: existing.sourceType,
				formatMetadata: existing.formatMetadata,
				pageCount: existing.pageCount ?? 0,
				hasNativeText: existing.hasNativeText,
				nativeTextRatio: existing.nativeTextRatio,
				duplicate: true,
				pdfMetadata: prepared.pdfMetadata,
			};
		}
	}

	// i. Dry run: skip upload and DB insert
	const sourceId = randomUUID();
	const storagePath = `raw/${sourceId}/original.${prepared.storageExtension}`;

	if (ctx.dryRun) {
		log.info({ sourceId, filename, pageCount: prepared.pageCount }, 'Dry run — skipping upload and DB insert');
		return {
			sourceId,
			filename,
			storagePath,
			fileHash,
			sourceType: prepared.sourceType,
			formatMetadata: prepared.formatMetadata,
			pageCount: prepared.pageCount,
			hasNativeText: prepared.hasNativeText,
			nativeTextRatio: prepared.nativeTextRatio,
			duplicate: false,
			pdfMetadata: prepared.pdfMetadata,
		};
	}

	// Pool is required for non-dry-run operations (upload + DB insert).
	// This guard narrows the type for TypeScript — reaching here without a
	// pool would be a caller bug (dry-run bails out above).
	if (!ctx.pool) {
		throw new IngestError('Database pool is required for non-dry-run ingest', INGEST_ERROR_CODES.INGEST_UPLOAD_FAILED, {
			context: { path: filePath },
		});
	}

	// j. Upload to storage
	try {
		await ctx.services.storage.upload(storagePath, buffer, prepared.mediaType);
	} catch (cause: unknown) {
		throw new IngestError(`Upload failed for ${filename}`, INGEST_ERROR_CODES.INGEST_UPLOAD_FAILED, {
			cause,
			context: { path: filePath, storagePath },
		});
	}

	// k. Create source record (store PDF metadata in JSONB column)
	const source = await createSource(ctx.pool, {
		id: sourceId,
		filename,
		storagePath,
		fileHash,
		sourceType: prepared.sourceType,
		formatMetadata: prepared.formatMetadata,
		pageCount: prepared.pageCount,
		hasNativeText: prepared.hasNativeText,
		nativeTextRatio: prepared.nativeTextRatio,
		tags: ctx.tags,
		metadata: prepared.formatMetadata,
	});

	if (source.id !== sourceId) {
		if (source.storagePath !== storagePath) {
			try {
				await ctx.services.storage.delete(storagePath);
				log.info(
					{ sourceId: source.id, duplicateUploadPath: storagePath },
					'Duplicate file race detected, removed unused uploaded object',
				);
			} catch (cause: unknown) {
				log.warn(
					{ err: cause, sourceId: source.id, duplicateUploadPath: storagePath },
					'Duplicate file race detected, but unused uploaded object cleanup failed',
				);
			}
		}
		return {
			sourceId: source.id,
			filename,
			storagePath: source.storagePath,
			fileHash,
			sourceType: source.sourceType,
			formatMetadata: source.formatMetadata,
			pageCount: source.pageCount ?? 0,
			hasNativeText: source.hasNativeText,
			nativeTextRatio: source.nativeTextRatio,
			duplicate: true,
			pdfMetadata: prepared.pdfMetadata,
		};
	}

	// l. Upsert source step
	await upsertSourceStep(ctx.pool, {
		sourceId: source.id,
		stepName: STEP_NAME,
		status: 'completed',
	});

	// m. Firestore observability (fire-and-forget)
	ctx.services.firestore
		.setDocument('documents', source.id, {
			filename,
			sourceType: prepared.sourceType,
			uploadedAt: new Date().toISOString(),
			fileHash,
			status: 'ingested',
		})
		.catch(() => {
			// Silently swallow — Firestore is best-effort observability
		});

	log.info(
		{
			sourceId: source.id,
			filename,
			sourceType: prepared.sourceType,
			pageCount: prepared.pageCount,
			hasNativeText: prepared.hasNativeText,
			nativeTextRatio: prepared.nativeTextRatio,
		},
		'File ingested successfully',
	);

	return {
		sourceId: source.id,
		filename,
		storagePath: source.storagePath,
		fileHash,
		sourceType: source.sourceType,
		formatMetadata: source.formatMetadata,
		pageCount: source.pageCount ?? prepared.pageCount,
		hasNativeText: source.hasNativeText,
		nativeTextRatio: source.nativeTextRatio,
		duplicate: false,
		pdfMetadata: prepared.pdfMetadata,
	};
}

// ────────────────────────────────────────────────────────────
// Main execute function
// ────────────────────────────────────────────────────────────

/**
 * Executes the ingest pipeline step.
 *
 * Accepts a file or directory path, validates each supported source, uploads to
 * Cloud Storage, and registers sources in PostgreSQL. Per-file errors
 * are caught and collected — processing continues for remaining files.
 *
 * @param input - Ingest input (path, tags, dryRun)
 * @param config - Validated Mulder configuration
 * @param services - Service registry (storage, firestore, etc.)
 * @param pool - PostgreSQL connection pool
 * @param logger - Logger instance
 * @returns Aggregate ingest result
 */
export async function execute(
	input: IngestInput,
	config: MulderConfig,
	services: Services,
	pool: pg.Pool | undefined,
	logger: Logger,
): Promise<IngestResult> {
	const log = createChildLogger(logger, { step: STEP_NAME });
	const startTime = performance.now();
	const urlInput = isUrlLikeInput(input.path);
	const inputPathForDisplay = urlInput ? sanitizeUrlInputForDisplay(input.path) : input.path;

	log.info({ path: inputPathForDisplay, dryRun: input.dryRun ?? false }, 'Ingest step started');

	// 1. Resolve URL or files. URL strings bypass filesystem stat completely.
	const filePaths = urlInput ? [input.path] : await resolveIngestFiles(input.path);

	if (filePaths.length === 0) {
		log.info('No supported ingest files found');
		return {
			status: 'success',
			data: [],
			errors: [],
			metadata: {
				duration_ms: Math.round(performance.now() - startTime),
				items_processed: 0,
				items_skipped: 0,
				items_cached: 0,
			},
		};
	}

	log.info(urlInput ? { urlCount: filePaths.length } : { fileCount: filePaths.length }, 'Ingest inputs resolved');

	// 2. Process each file
	const ctx: ProcessFileContext = {
		config,
		services,
		pool,
		logger: log,
		tags: input.tags,
		dryRun: input.dryRun ?? false,
	};

	const results: IngestFileResult[] = [];
	const errors: StepError[] = [];
	let itemsSkipped = 0;

	for (const filePath of filePaths) {
		try {
			const result = urlInput ? await processUrl(filePath, ctx) : await processFile(filePath, ctx);
			results.push(result);
			if (result.duplicate) {
				itemsSkipped++;
			}
		} catch (error: unknown) {
			const fileForDisplay = urlInput ? sanitizeUrlInputForDisplay(filePath) : filePath;
			const stepError: StepError = {
				file: fileForDisplay,
				code: error instanceof IngestError ? error.code : 'INGEST_UNKNOWN',
				message: error instanceof Error ? error.message : String(error),
			};
			errors.push(stepError);
			log.error({ err: error, file: fileForDisplay }, 'Failed to ingest file');
		}
	}

	// 3. Determine overall status
	let status: 'success' | 'partial' | 'failed';
	if (errors.length === 0) {
		status = 'success';
	} else if (results.length > 0) {
		status = 'partial';
	} else {
		status = 'failed';
	}

	const durationMs = Math.round(performance.now() - startTime);

	log.info(
		{
			status,
			processed: results.length,
			errors: errors.length,
			skipped: itemsSkipped,
			duration_ms: durationMs,
		},
		'Ingest step completed',
	);

	return {
		status,
		data: results,
		errors,
		metadata: {
			duration_ms: durationMs,
			items_processed: results.length,
			items_skipped: itemsSkipped,
			items_cached: 0,
		},
	};
}
