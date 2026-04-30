/**
 * Type definitions for the extract pipeline step.
 *
 * @see docs/specs/19_extract_step.spec.md §4.3
 * @see docs/functional-spec.md §2.2
 */

import type { StepError } from '@mulder/core';

// ────────────────────────────────────────────────────────────
// Input
// ────────────────────────────────────────────────────────────

/** Input for the extract step. */
export interface ExtractInput {
	/** Single source to extract. */
	sourceId: string;
	/** Force re-extraction (cascading delete first). */
	force?: boolean;
	/** Only run Gemini Vision fallback on low-confidence pages. */
	fallbackOnly?: boolean;
}

// ────────────────────────────────────────────────────────────
// Extraction data types
// ────────────────────────────────────────────────────────────

/** The extraction method used for a given page. */
export type ExtractionMethod = 'native' | 'document_ai' | 'vision_fallback';

/** The source-level extraction path used for a completed extract step. */
export type PrimaryExtractionMethod = 'native' | 'document_ai' | 'text';

/** Per-page extraction details. */
export interface PageExtraction {
	/** 1-indexed page number. */
	pageNumber: number;
	/** Extraction method used for this page. */
	method: ExtractionMethod;
	/** Confidence in the extraction quality (0-1). */
	confidence: number;
	/** Extracted text for this page. */
	text: string;
}

/** Aggregate extraction data for a source. */
export interface ExtractionData {
	/** Source UUID. */
	sourceId: string;
	/** GCS URI: extracted/{doc-id}/layout.json */
	layoutUri: string | null;
	/** GCS URIs: extracted/{doc-id}/pages/page-NNN.png */
	pageImageUris: string[];
	/** Total number of pages. */
	pageCount: number;
	/** Primary extraction method (native or document_ai). */
	primaryMethod: PrimaryExtractionMethod;
	/** Per-page extraction details. */
	pages: PageExtraction[];
	/** How many pages used Gemini Vision fallback. */
	visionFallbackCount: number;
	/** True if circuit breaker was hit. */
	visionFallbackCapped: boolean;
}

// ────────────────────────────────────────────────────────────
// Layout JSON types (output format consumed by Segment step)
// ────────────────────────────────────────────────────────────

/** Bounding box for a layout block. */
export interface LayoutBlockBoundingBox {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** A single block of text within a page layout. */
export interface LayoutBlock {
	text: string;
	type: string;
	boundingBox?: LayoutBlockBoundingBox;
	confidence: number;
}

/** Layout data for a single page. */
export interface LayoutPage {
	/** 1-indexed page number. */
	pageNumber: number;
	/** Extraction method used. */
	method: ExtractionMethod;
	/** Confidence score (0-1). */
	confidence: number;
	/** Full page text (reading order). */
	text: string;
	/** Blocks with spatial data — only present for document_ai method. */
	blocks?: LayoutBlock[];
}

/** The normalized layout.json document format. */
export interface LayoutDocument {
	sourceId: string;
	pageCount: number;
	primaryMethod: Exclude<PrimaryExtractionMethod, 'text'>;
	extractedAt: string;
	pages: LayoutPage[];
	metadata: {
		visionFallbackCount: number;
		visionFallbackCapped: boolean;
		documentAiRaw?: Record<string, unknown>;
	};
}

// ────────────────────────────────────────────────────────────
// Aggregate result
// ────────────────────────────────────────────────────────────

/** Aggregate result of the extract step. */
export interface ExtractResult {
	/** Overall status: success if extraction passed, partial if some pages failed, failed if all failed. */
	status: 'success' | 'partial' | 'failed';
	/** Extraction data for the source. */
	data: ExtractionData | null;
	/** Per-page errors for failed pages. */
	errors: StepError[];
	/** Execution metadata. */
	metadata: {
		duration_ms: number;
		items_processed: number;
		items_skipped: number;
		items_cached: number;
	};
}
