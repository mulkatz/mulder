/**
 * Ingest pipeline step — the entry point for all documents into Mulder.
 *
 * Accepts PDF files (single file or directory), validates them, detects
 * native text, uploads to Cloud Storage, and registers them as sources
 * in PostgreSQL.
 *
 * @see docs/specs/16_ingest_step.spec.md
 * @see docs/functional-spec.md §2.1
 */

import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { Logger, MulderConfig, Services, StepError } from '@mulder/core';
import {
	createChildLogger,
	createSource,
	detectNativeText,
	findSourceByHash,
	INGEST_ERROR_CODES,
	IngestError,
	upsertSourceStep,
} from '@mulder/core';
import type pg from 'pg';
import type { IngestFileResult, IngestInput, IngestResult } from './types.js';

export type { IngestFileResult, IngestInput, IngestResult } from './types.js';

// ────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────

/** PDF magic bytes: `%PDF-` */
const PDF_MAGIC_BYTES = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d]);

const STEP_NAME = 'ingest';

// ────────────────────────────────────────────────────────────
// File resolution
// ────────────────────────────────────────────────────────────

/**
 * Resolves the input path to a list of PDF file paths.
 * If the path is a directory, recursively finds all `.pdf` files.
 * If the path is a single file, returns it as-is.
 */
async function resolvePdfFiles(inputPath: string): Promise<string[]> {
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
		const pdfFiles: string[] = [];
		for (const entry of entries) {
			if (entry.toLowerCase().endsWith('.pdf')) {
				pdfFiles.push(join(resolved, entry));
			}
		}
		return pdfFiles.sort();
	}

	throw new IngestError(
		`Path is neither a file nor a directory: ${resolved}`,
		INGEST_ERROR_CODES.INGEST_FILE_NOT_FOUND,
		{
			context: { path: resolved },
		},
	);
}

// ────────────────────────────────────────────────────────────
// Validation helpers
// ────────────────────────────────────────────────────────────

/**
 * Checks the first 5 bytes of a buffer for the `%PDF-` magic bytes.
 */
function hasPdfMagicBytes(buffer: Buffer): boolean {
	if (buffer.length < 5) {
		return false;
	}
	return buffer.subarray(0, 5).equals(PDF_MAGIC_BYTES);
}

/**
 * Computes the SHA-256 hash of a buffer, returned as a hex string.
 */
function computeFileHash(buffer: Buffer): string {
	return createHash('sha256').update(buffer).digest('hex');
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

/**
 * Processes a single PDF file through the ingest pipeline.
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

	// b. Check magic bytes (read first 5 bytes)
	const buffer = await readFile(filePath);

	if (!hasPdfMagicBytes(buffer)) {
		throw new IngestError(
			`Not a valid PDF file (missing %PDF- header): ${filename}`,
			INGEST_ERROR_CODES.INGEST_NOT_PDF,
			{
				context: { path: filePath },
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

	// d/e. Compute SHA-256 hash
	const fileHash = computeFileHash(buffer);

	// f. Check for duplicate (skip when pool is unavailable, e.g. dry-run)
	if (ctx.pool) {
		const existing = await findSourceByHash(ctx.pool, fileHash);
		if (existing) {
			log.info({ sourceId: existing.id, fileHash }, 'Duplicate file detected, skipping upload');
			return {
				sourceId: existing.id,
				filename,
				storagePath: existing.storagePath,
				fileHash,
				pageCount: existing.pageCount ?? 0,
				hasNativeText: existing.hasNativeText,
				nativeTextRatio: existing.nativeTextRatio,
				duplicate: true,
			};
		}
	}

	// g. Native text detection (also gives us pageCount)
	const textResult = await detectNativeText(buffer);

	// h. Check page count
	const maxPages = ctx.config.ingestion.max_pages;
	if (textResult.pageCount > maxPages) {
		throw new IngestError(
			`Too many pages: ${filename} has ${textResult.pageCount} pages, max is ${maxPages}`,
			INGEST_ERROR_CODES.INGEST_TOO_MANY_PAGES,
			{ context: { path: filePath, pageCount: textResult.pageCount, maxPages } },
		);
	}

	// i. Dry run: skip upload and DB insert
	const sourceId = randomUUID();
	const storagePath = `sources/${sourceId}/original.pdf`;

	if (ctx.dryRun) {
		log.info({ sourceId, filename, pageCount: textResult.pageCount }, 'Dry run — skipping upload and DB insert');
		return {
			sourceId,
			filename,
			storagePath,
			fileHash,
			pageCount: textResult.pageCount,
			hasNativeText: textResult.hasNativeText,
			nativeTextRatio: textResult.nativeTextRatio,
			duplicate: false,
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
		await ctx.services.storage.upload(storagePath, buffer, 'application/pdf');
	} catch (cause: unknown) {
		throw new IngestError(`Upload failed for ${filename}`, INGEST_ERROR_CODES.INGEST_UPLOAD_FAILED, {
			cause,
			context: { path: filePath, storagePath },
		});
	}

	// k. Create source record
	const source = await createSource(ctx.pool, {
		filename,
		storagePath,
		fileHash,
		pageCount: textResult.pageCount,
		hasNativeText: textResult.hasNativeText,
		nativeTextRatio: textResult.nativeTextRatio,
		tags: ctx.tags,
	});

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
			pageCount: textResult.pageCount,
			hasNativeText: textResult.hasNativeText,
			nativeTextRatio: textResult.nativeTextRatio,
		},
		'File ingested successfully',
	);

	return {
		sourceId: source.id,
		filename,
		storagePath: source.storagePath,
		fileHash,
		pageCount: textResult.pageCount,
		hasNativeText: textResult.hasNativeText,
		nativeTextRatio: textResult.nativeTextRatio,
		duplicate: false,
	};
}

// ────────────────────────────────────────────────────────────
// Main execute function
// ────────────────────────────────────────────────────────────

/**
 * Executes the ingest pipeline step.
 *
 * Accepts a file or directory path, validates each PDF, uploads to
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

	log.info({ path: input.path, dryRun: input.dryRun ?? false }, 'Ingest step started');

	// 1. Resolve files
	const filePaths = await resolvePdfFiles(input.path);

	if (filePaths.length === 0) {
		log.info('No PDF files found');
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

	log.info({ fileCount: filePaths.length }, 'PDF files resolved');

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
			const result = await processFile(filePath, ctx);
			results.push(result);
			if (result.duplicate) {
				itemsSkipped++;
			}
		} catch (error: unknown) {
			const stepError: StepError = {
				file: filePath,
				code: error instanceof IngestError ? error.code : 'INGEST_UNKNOWN',
				message: error instanceof Error ? error.message : String(error),
			};
			errors.push(stepError);
			log.error({ err: error, file: filePath }, 'Failed to ingest file');
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
