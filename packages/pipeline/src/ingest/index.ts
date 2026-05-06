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
	Source,
	SourceFormatMetadata,
	SourceType,
	StepError,
} from '@mulder/core';
import {
	buildContentAddressedBlobPath,
	computeUrlLifecycleNextAllowedAt,
	createChildLogger,
	createSource,
	detectNativeText,
	extractPdfMetadata,
	findSourceByCrossFormatDedupKey,
	findSourceByHash,
	findUrlHostLifecycleByHost,
	INGEST_ERROR_CODES,
	IngestError,
	normalizeUrlLifecycleHost,
	recordIngestProvenance,
	recordUrlHostLifecycle,
	recordUrlLifecycleFetch,
	resolveUrlPolitenessDelayMs,
	sleepForUrlPoliteness,
	upsertDocumentBlob,
	upsertSourceStep,
	urlLifecycleHeaderValue,
} from '@mulder/core';
import type pg from 'pg';
import {
	buildTabularCrossFormatContent,
	deriveMarkdownTitle,
	getCrossFormatDedupKey,
	normalizeCrossFormatText,
	withCrossFormatDedupMetadata,
} from './cross-format-dedup.js';
import { ensureRawDocumentBlob } from './raw-blob.js';
import {
	buildDocxFormatMetadata,
	buildEmailFormatMetadata,
	buildImageFormatMetadata,
	buildSpreadsheetFormatMetadata,
	buildTextFormatMetadata,
	CSV_MEDIA_TYPE,
	decodeUtf8TextBuffer,
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
import type { IngestFileResult, IngestInput, IngestProvenanceInput, IngestResult } from './types.js';
import { filenameForUrlSnapshot, prepareUrlSnapshot } from './url-snapshot.js';

export type {
	CrossFormatDedupBasis,
	CrossFormatDedupMetadataInput,
	CrossFormatTabularSheet,
} from './cross-format-dedup.js';
export {
	buildTabularCrossFormatContent,
	deriveCrossFormatContentKey,
	deriveCrossFormatTitleKey,
	deriveMarkdownTitle,
	getCrossFormatDedupKey,
	isStrongCrossFormatContentSignal,
	normalizeCrossFormatText,
	withCrossFormatDedupMetadata,
} from './cross-format-dedup.js';
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
	isPreStructuredType,
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
export type { IngestFileResult, IngestInput, IngestProvenanceInput, IngestResult } from './types.js';

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
	provenance?: IngestProvenanceInput;
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

function stringMetadataValue(metadata: SourceFormatMetadata, key: string): string | null {
	const value = metadata[key];
	return typeof value === 'string' ? value : null;
}

async function recordSuccessfulIngestProvenance(input: {
	ctx: ProcessFileContext;
	source: Source;
	blobContentHash: string;
	defaultChannel: 'manual_upload' | 'web_research';
}): Promise<void> {
	if (!input.ctx.pool || input.ctx.dryRun) {
		return;
	}

	const explicitContext = input.ctx.provenance?.context;
	await recordIngestProvenance(input.ctx.pool, {
		blobContentHash: input.blobContentHash,
		sourceId: input.source.id,
		context: {
			channel: explicitContext?.channel ?? input.defaultChannel,
			submittedBy: {
				userId: explicitContext?.submittedBy?.userId ?? 'mulder-cli',
				type: explicitContext?.submittedBy?.type ?? 'system',
				role: explicitContext?.submittedBy?.role ?? null,
			},
			submittedAt: explicitContext?.submittedAt,
			collectionId: explicitContext?.collectionId ?? null,
			submissionNotes: explicitContext?.submissionNotes ?? null,
			submissionMetadata: explicitContext?.submissionMetadata ?? {},
			authenticityStatus: explicitContext?.authenticityStatus ?? 'unverified',
			authenticityNotes: explicitContext?.authenticityNotes ?? null,
		},
		originalSource: input.ctx.provenance?.originalSource ?? null,
		custodyChain: input.ctx.provenance?.custodyChain ?? [],
		archive: input.ctx.provenance?.archive ?? null,
		archiveLocation: input.ctx.provenance?.archiveLocation,
	});
}

function buildUrlCrossFormatDedupContent(title: string | null, readabilityMarkdown: string | null): string | null {
	const content = readabilityMarkdown?.trim();
	if (!content) {
		return null;
	}
	const normalizedTitle = title?.trim();
	if (!normalizedTitle) {
		return content;
	}
	const firstContentLine = content.split(/\r?\n/).find((line) => line.trim().length > 0);
	if (firstContentLine && normalizeCrossFormatText(firstContentLine) === normalizeCrossFormatText(normalizedTitle)) {
		return content;
	}
	return `${normalizedTitle}\n\n${content}`;
}

async function waitForUrlHostPoliteness(ctx: ProcessFileContext, normalizedUrl: string): Promise<void> {
	if (!ctx.pool) {
		return;
	}

	const host = normalizeUrlLifecycleHost(normalizedUrl);
	const state = await findUrlHostLifecycleByHost(ctx.pool, host);
	if (!state?.nextAllowedAt) {
		return;
	}

	const waitMs = state.nextAllowedAt.getTime() - Date.now();
	if (waitMs > 0) {
		await sleepForUrlPoliteness(waitMs);
	}
}

async function recordUrlLifecycleForFetch(input: {
	ctx: ProcessFileContext;
	source: Source;
	fetchResult: Awaited<ReturnType<Services['urls']['fetchUrl']>>;
	formatMetadata: SourceFormatMetadata;
	fileHash: string;
	storagePath: string;
	changeKind: 'initial' | 'changed' | 'unchanged';
}): Promise<void> {
	if (!input.ctx.pool || input.ctx.dryRun || input.source.sourceType !== 'url') {
		return;
	}

	const fetchedAt = new Date(input.fetchResult.fetchedAt);
	const minimumDelayMs = resolveUrlPolitenessDelayMs();
	const finalUrl = stringMetadataValue(input.formatMetadata, 'final_url') ?? input.fetchResult.finalUrl;
	const host = normalizeUrlLifecycleHost(finalUrl);
	const initialHost = normalizeUrlLifecycleHost(input.fetchResult.normalizedUrl);
	const nextFetchAfter = computeUrlLifecycleNextAllowedAt(fetchedAt, minimumDelayMs);

	for (const hostToRecord of new Set([initialHost, host])) {
		await recordUrlHostLifecycle(input.ctx.pool, {
			host: hostToRecord,
			minimumDelayMs,
			requestedAt: fetchedAt,
			lastRobotsCheckedAt: fetchedAt,
		});
	}

	await recordUrlLifecycleFetch(input.ctx.pool, {
		sourceId: input.source.id,
		originalUrl: input.fetchResult.originalUrl,
		normalizedUrl: input.fetchResult.normalizedUrl,
		finalUrl,
		host,
		etag: urlLifecycleHeaderValue(input.fetchResult.headers, 'etag'),
		lastModified: urlLifecycleHeaderValue(input.fetchResult.headers, 'last-modified'),
		lastFetchedAt: fetchedAt,
		lastCheckedAt: fetchedAt,
		nextFetchAfter,
		lastHttpStatus: input.fetchResult.httpStatus,
		robotsAllowed: input.fetchResult.robots.allowed,
		robotsUrl: input.fetchResult.robots.robotsUrl,
		robotsCheckedAt: fetchedAt,
		robotsMatchedUserAgent: input.fetchResult.robots.matchedUserAgent,
		robotsMatchedRule: input.fetchResult.robots.matchedRule,
		redirectCount: input.fetchResult.redirectCount,
		contentType: input.fetchResult.contentType,
		renderingMethod: stringMetadataValue(input.formatMetadata, 'rendering_method'),
		snapshotEncoding:
			input.fetchResult.snapshotEncoding ?? stringMetadataValue(input.formatMetadata, 'snapshot_encoding'),
		lastContentHash: input.fileHash,
		lastSnapshotStoragePath: input.storagePath,
		changeKind: input.changeKind,
	});
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
		await waitForUrlHostPoliteness(ctx, normalizedUrl);
		fetchResult = await ctx.services.urls.fetchUrl(inputUrl, {
			maxBytes: ctx.config.ingestion.max_file_size_mb * 1024 * 1024,
		});
	} catch (cause: unknown) {
		throw new IngestError(`URL fetch failed for ${displayUrl}`, INGEST_ERROR_CODES.INGEST_URL_FETCH_FAILED, {
			cause,
			context: { url: displayUrl },
		});
	}

	const prepared = await prepareUrlSnapshot(fetchResult, {
		config: ctx.config,
		services: ctx.services,
		displayUrl,
		logger: log,
	});
	const filename = filenameForUrlSnapshot(prepared.html, prepared.finalUrl, prepared.title ?? undefined);
	const fileHash = computeFileHash(prepared.html);
	const formatMetadata = withCrossFormatDedupMetadata(prepared.formatMetadata, {
		content: buildUrlCrossFormatDedupContent(prepared.title, prepared.readabilityMarkdown),
		basis: 'url_readability_content',
		title: prepared.title,
	});

	if (ctx.pool) {
		const existing = await findSourceByHash(ctx.pool, fileHash);
		if (existing) {
			log.info({ sourceId: existing.id, fileHash }, 'Duplicate URL snapshot detected, skipping upload');
			await upsertDocumentBlob(ctx.pool, {
				contentHash: fileHash,
				storagePath: existing.storagePath,
				storageUri: ctx.services.storage.buildUri(existing.storagePath),
				mimeType: URL_SNAPSHOT_MEDIA_TYPE,
				fileSizeBytes: prepared.html.byteLength,
				originalFilenames: [filename],
			});
			await recordUrlLifecycleForFetch({
				ctx,
				source: existing,
				fetchResult,
				formatMetadata,
				fileHash,
				storagePath: existing.storagePath,
				changeKind: 'unchanged',
			});
			await recordSuccessfulIngestProvenance({
				ctx,
				source: existing,
				blobContentHash: fileHash,
				defaultChannel: 'web_research',
			});
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

		const crossFormatDedupKey = getCrossFormatDedupKey(formatMetadata);
		if (crossFormatDedupKey) {
			const existingCrossFormatSource = await findSourceByCrossFormatDedupKey(ctx.pool, crossFormatDedupKey);
			if (existingCrossFormatSource) {
				log.info(
					{ sourceId: existingCrossFormatSource.id, crossFormatDedupKey },
					'Cross-format duplicate URL snapshot detected, skipping upload',
				);
				return {
					sourceId: existingCrossFormatSource.id,
					filename,
					storagePath: existingCrossFormatSource.storagePath,
					fileHash: existingCrossFormatSource.fileHash,
					sourceType: existingCrossFormatSource.sourceType,
					formatMetadata: existingCrossFormatSource.formatMetadata,
					pageCount: existingCrossFormatSource.pageCount ?? 0,
					hasNativeText: existingCrossFormatSource.hasNativeText,
					nativeTextRatio: existingCrossFormatSource.nativeTextRatio,
					duplicate: true,
				};
			}
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
		await upsertDocumentBlob(ctx.pool, {
			contentHash: fileHash,
			storagePath: source.storagePath,
			storageUri: ctx.services.storage.buildUri(source.storagePath),
			mimeType: URL_SNAPSHOT_MEDIA_TYPE,
			fileSizeBytes: prepared.html.byteLength,
			originalFilenames: [filename],
		});
		await recordUrlLifecycleForFetch({
			ctx,
			source,
			fetchResult,
			formatMetadata,
			fileHash,
			storagePath: source.storagePath,
			changeKind: 'unchanged',
		});
		await recordSuccessfulIngestProvenance({
			ctx,
			source,
			blobContentHash: fileHash,
			defaultChannel: 'web_research',
		});
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

	await upsertDocumentBlob(ctx.pool, {
		contentHash: fileHash,
		storagePath: source.storagePath,
		storageUri: ctx.services.storage.buildUri(source.storagePath),
		mimeType: URL_SNAPSHOT_MEDIA_TYPE,
		fileSizeBytes: prepared.html.byteLength,
		originalFilenames: [filename],
	});
	await recordUrlLifecycleForFetch({
		ctx,
		source,
		fetchResult,
		formatMetadata,
		fileHash,
		storagePath: source.storagePath,
		changeKind: 'initial',
	});
	await recordSuccessfulIngestProvenance({
		ctx,
		source,
		blobContentHash: fileHash,
		defaultChannel: 'web_research',
	});

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

		const textContent = decodeUtf8TextBuffer(buffer);
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
			formatMetadata: withCrossFormatDedupMetadata(formatMetadata, {
				content: textContent,
				title: textContent ? deriveMarkdownTitle(textContent) : null,
				basis: 'text_content',
			}),
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
			formatMetadata: withCrossFormatDedupMetadata(
				buildSpreadsheetFormatMetadata(buffer, filename, detection.mediaType, extractionResult),
				{
					content: buildTabularCrossFormatContent(extractionResult.sheets),
					basis: 'tabular_rows',
				},
			),
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
			formatMetadata: withCrossFormatDedupMetadata(
				buildEmailFormatMetadata(buffer, filename, detection.mediaType, extractionResult),
				{
					content: [extractionResult.headers.subject, extractionResult.bodyText || extractionResult.bodyHtmlText]
						.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
						.join('\n\n'),
					title: extractionResult.headers.subject,
					basis: 'email_body',
				},
			),
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
			await ensureRawDocumentBlob({
				services: ctx.services,
				pool: ctx.pool,
				contentHash: fileHash,
				content: buffer,
				mediaType: prepared.mediaType,
				storageExtension: prepared.storageExtension,
				filename,
			});
			await recordSuccessfulIngestProvenance({
				ctx,
				source: existing,
				blobContentHash: fileHash,
				defaultChannel: 'manual_upload',
			});
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

		const crossFormatDedupKey = getCrossFormatDedupKey(prepared.formatMetadata);
		if (crossFormatDedupKey) {
			const existingCrossFormatSource = await findSourceByCrossFormatDedupKey(ctx.pool, crossFormatDedupKey);
			if (existingCrossFormatSource) {
				log.info(
					{ sourceId: existingCrossFormatSource.id, crossFormatDedupKey },
					'Cross-format duplicate file detected, skipping upload',
				);
				return {
					sourceId: existingCrossFormatSource.id,
					filename,
					storagePath: existingCrossFormatSource.storagePath,
					fileHash: existingCrossFormatSource.fileHash,
					sourceType: existingCrossFormatSource.sourceType,
					formatMetadata: existingCrossFormatSource.formatMetadata,
					pageCount: existingCrossFormatSource.pageCount ?? 0,
					hasNativeText: existingCrossFormatSource.hasNativeText,
					nativeTextRatio: existingCrossFormatSource.nativeTextRatio,
					duplicate: true,
					pdfMetadata: prepared.pdfMetadata,
				};
			}
		}
	}

	// i. Dry run: skip upload and DB insert
	const sourceId = randomUUID();
	let storagePath = buildContentAddressedBlobPath(fileHash, prepared.storageExtension);

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

	// j. Upload to content-addressed storage and register the blob
	try {
		storagePath = await ensureRawDocumentBlob({
			services: ctx.services,
			pool: ctx.pool,
			contentHash: fileHash,
			content: buffer,
			mediaType: prepared.mediaType,
			storageExtension: prepared.storageExtension,
			filename,
		});
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
		await recordSuccessfulIngestProvenance({
			ctx,
			source,
			blobContentHash: fileHash,
			defaultChannel: 'manual_upload',
		});
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
	await recordSuccessfulIngestProvenance({
		ctx,
		source,
		blobContentHash: fileHash,
		defaultChannel: 'manual_upload',
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
		provenance: input.provenance,
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
