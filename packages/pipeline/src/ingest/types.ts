/**
 * Type definitions for the ingest pipeline step.
 *
 * @see docs/specs/16_ingest_step.spec.md §4.2
 * @see docs/functional-spec.md §2.1
 */

import type { PdfMetadata, SourceFormatMetadata, SourceType, StepError } from '@mulder/core';

// ────────────────────────────────────────────────────────────
// Input
// ────────────────────────────────────────────────────────────

/** Input for the ingest step. */
export interface IngestInput {
	/** File or directory path containing PDF(s). */
	path: string;
	/** Optional tags for batch operations. */
	tags?: string[];
	/** Validate without uploading or creating DB records. */
	dryRun?: boolean;
}

// ────────────────────────────────────────────────────────────
// Per-file result
// ────────────────────────────────────────────────────────────

/** Result for a single ingested file. */
export interface IngestFileResult {
	/** UUID of the source record. */
	sourceId: string;
	/** Original filename (basename). */
	filename: string;
	/** Storage path in GCS (e.g., `raw/{uuid}/original.pdf`). */
	storagePath: string;
	/** SHA-256 hash of the file content. */
	fileHash: string;
	/** Detected source format discriminator. */
	sourceType: SourceType;
	/** Format-specific metadata stored on the source row. */
	formatMetadata: SourceFormatMetadata;
	/** Number of pages in the PDF. */
	pageCount: number;
	/** Whether the PDF contains extractable native text. */
	hasNativeText: boolean;
	/** Fraction of pages with native text (0-1). */
	nativeTextRatio: number;
	/** True if this file hash already existed in the database. */
	duplicate: boolean;
	/** Lightweight PDF metadata extracted without decompressing page content. */
	pdfMetadata?: PdfMetadata;
}

// ────────────────────────────────────────────────────────────
// Aggregate result
// ────────────────────────────────────────────────────────────

/** Aggregate result of the ingest step. */
export interface IngestResult {
	/** Overall status: success if all passed, partial if some failed, failed if all failed. */
	status: 'success' | 'partial' | 'failed';
	/** Per-file results for successful files. */
	data: IngestFileResult[];
	/** Per-file errors for failed files. */
	errors: StepError[];
	/** Execution metadata. */
	metadata: {
		duration_ms: number;
		items_processed: number;
		items_skipped: number;
		items_cached: number;
	};
}
