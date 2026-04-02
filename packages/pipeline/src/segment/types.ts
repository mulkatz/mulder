/**
 * Type definitions for the segment pipeline step.
 *
 * @see docs/specs/23_segment_step.spec.md §4.3
 * @see docs/functional-spec.md §2.3
 */

import type { StepError } from '@mulder/core';

// ────────────────────────────────────────────────────────────
// Input
// ────────────────────────────────────────────────────────────

/** Input for the segment step. */
export interface SegmentInput {
	/** Single source to segment. */
	sourceId: string;
	/** Force re-segmentation (delete existing stories first). */
	force?: boolean;
}

// ────────────────────────────────────────────────────────────
// Story types
// ────────────────────────────────────────────────────────────

/** A single story identified by Gemini segmentation. */
export interface SegmentedStory {
	/** UUID generated for this segment. */
	id: string;
	/** Story title. */
	title: string;
	/** Story subtitle, if present. */
	subtitle: string | null;
	/** ISO 639-1 language code. */
	language: string;
	/** Story category (e.g., "sighting_report", "editorial", "news"). */
	category: string;
	/** First page number (1-indexed) where this story appears. */
	pageStart: number;
	/** Last page number (1-indexed) where this story ends. */
	pageEnd: number;
	/** ISO dates mentioned in the story. */
	dateReferences: string[];
	/** Place names mentioned in the story. */
	geographicReferences: string[];
	/** Confidence in story boundary identification (0-1). */
	extractionConfidence: number;
	/** GCS path: segments/{doc-id}/{segment-id}.md */
	gcsMarkdownUri: string;
	/** GCS path: segments/{doc-id}/{segment-id}.meta.json */
	gcsMetadataUri: string;
}

// ────────────────────────────────────────────────────────────
// Aggregate data
// ────────────────────────────────────────────────────────────

/** Aggregate segmentation data for a source. */
export interface SegmentationData {
	/** Source UUID. */
	sourceId: string;
	/** Number of stories identified. */
	storyCount: number;
	/** All identified stories. */
	stories: SegmentedStory[];
}

// ────────────────────────────────────────────────────────────
// Aggregate result
// ────────────────────────────────────────────────────────────

/** Result of the segment pipeline step. */
export interface SegmentResult {
	/** Overall status: success if segmentation passed, partial if some errors, failed if all failed. */
	status: 'success' | 'partial' | 'failed';
	/** Segmentation data for the source. */
	data: SegmentationData | null;
	/** Errors during segmentation. */
	errors: StepError[];
	/** Execution metadata. */
	metadata: {
		duration_ms: number;
		/** Stories created. */
		items_processed: number;
		/** Pages without stories. */
		items_skipped: number;
		/** LLM cache hits (dev mode). */
		items_cached: number;
	};
}
