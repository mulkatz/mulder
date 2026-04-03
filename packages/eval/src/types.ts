/**
 * Type definitions for the eval package.
 *
 * @see docs/specs/21_golden_test_set_extraction.spec.md §4.2
 * @see docs/functional-spec.md §15.1, §15.2
 */

// ────────────────────────────────────────────────────────────
// Golden annotations
// ────────────────────────────────────────────────────────────

/** Difficulty level for a golden annotation page. */
export type DifficultyLevel = 'simple' | 'moderate' | 'complex';

/** Ground truth annotation for a single page's extraction. */
export interface ExtractionGolden {
	/** Reference to source fixture (slug matches fixtures/extracted/{slug}/). */
	sourceSlug: string;
	/** 1-indexed page number. */
	pageNumber: number;
	/** Difficulty level for reporting. */
	difficulty: DifficultyLevel;
	/** Language(s) present on the page. */
	languages: string[];
	/** Expected full page text (reading order). */
	expectedText: string;
	/** Optional: expected block count (for layout accuracy). */
	expectedBlockCount?: number;
	/** Annotation metadata. */
	annotation: {
		author: string;
		date: string;
		notes?: string;
	};
}

// ────────────────────────────────────────────────────────────
// Metric results
// ────────────────────────────────────────────────────────────

/** CER/WER result for a single page. */
export interface ExtractionMetricResult {
	sourceSlug: string;
	pageNumber: number;
	difficulty: string;
	cer: number;
	wer: number;
	charCount: number;
	wordCount: number;
}

/** Per-difficulty aggregated stats. */
export interface DifficultyStats {
	avgCer: number;
	avgWer: number;
	count: number;
}

/** Aggregate extraction eval results. */
export interface ExtractionEvalResult {
	timestamp: string;
	pages: ExtractionMetricResult[];
	summary: {
		totalPages: number;
		avgCer: number;
		avgWer: number;
		maxCer: number;
		maxWer: number;
		byDifficulty: Record<string, DifficultyStats>;
	};
}

// ────────────────────────────────────────────────────────────
// Segmentation golden annotations
// ────────────────────────────────────────────────────────────

/** Expected segment boundary for a single story. */
export interface ExpectedSegment {
	/** Story title (for matching against actual output). */
	title: string;
	/** First page number (1-indexed). */
	pageStart: number;
	/** Last page number (1-indexed). */
	pageEnd: number;
	/** Story category. */
	category: string;
}

/** Ground truth annotation for segmentation of a document. */
export interface SegmentationGolden {
	/** Reference to source fixture (slug matches fixtures/segments/{slug}/). */
	sourceSlug: string;
	/** Total page count of the document. */
	totalPages: number;
	/** Difficulty level for reporting. */
	difficulty: DifficultyLevel;
	/** Expected number of segments. */
	expectedSegmentCount: number;
	/** Expected segment boundaries. */
	expectedSegments: ExpectedSegment[];
	/** Annotation metadata. */
	annotation: {
		author: string;
		date: string;
		notes?: string;
	};
}

/** Actual segment as parsed from fixture metadata. */
export interface ActualSegment {
	title: string;
	pageStart: number;
	pageEnd: number;
	category: string;
}

/** Segmentation metric result for a single document. */
export interface SegmentationMetricResult {
	sourceSlug: string;
	difficulty: string;
	/** 1.0 = all boundaries exact, 0.0 = all wrong. */
	boundaryAccuracy: number;
	/** Whether actual count matches expected count. */
	segmentCountExact: boolean;
	/** Actual segment count. */
	actualSegmentCount: number;
	/** Expected segment count. */
	expectedSegmentCount: number;
}

/** Aggregate segmentation eval results. */
export interface SegmentationEvalResult {
	timestamp: string;
	documents: SegmentationMetricResult[];
	summary: {
		totalDocuments: number;
		avgBoundaryAccuracy: number;
		segmentCountExactRatio: number;
		byDifficulty: Record<string, { avgBoundaryAccuracy: number; count: number }>;
	};
}

// ────────────────────────────────────────────────────────────
// Entity golden annotations
// ────────────────────────────────────────────────────────────

/** Expected entity in a golden annotation. */
export interface ExpectedEntity {
	/** Entity name. */
	name: string;
	/** Entity type from ontology (person, location, organization, event, document). */
	type: string;
	/** Key attributes to verify (subset — not all attributes need matching). */
	attributes?: Record<string, unknown>;
}

/** Expected relationship in a golden annotation. */
export interface ExpectedRelationship {
	sourceEntity: string;
	targetEntity: string;
	relationshipType: string;
}

/** Ground truth annotation for entity extraction from a story. */
export interface EntityGolden {
	/** Segment ID (matches fixtures/entities/{segmentId}.entities.json). */
	segmentId: string;
	/** Source slug for context. */
	sourceSlug: string;
	/** Difficulty level for reporting. */
	difficulty: DifficultyLevel;
	/** Languages in the source story. */
	languages: string[];
	/** Expected entities. */
	expectedEntities: ExpectedEntity[];
	/** Expected relationships. */
	expectedRelationships: ExpectedRelationship[];
	/** Annotation metadata. */
	annotation: {
		author: string;
		date: string;
		notes?: string;
	};
}

/** Precision, Recall, F1 tuple. */
export interface PRF1 {
	precision: number;
	recall: number;
	f1: number;
}

/** Entity metric result for a single story/segment. */
export interface EntityMetricResult {
	segmentId: string;
	sourceSlug: string;
	difficulty: string;
	/** Per entity type: precision, recall, F1. */
	byType: Record<string, PRF1>;
	/** Aggregate across all types. */
	overall: PRF1;
	/** Relationship metrics. */
	relationships: PRF1;
}

/** Aggregate entity eval results. */
export interface EntityEvalResult {
	timestamp: string;
	segments: EntityMetricResult[];
	summary: {
		totalSegments: number;
		/** Per entity type averaged across all segments. */
		byType: Record<string, { avgPrecision: number; avgRecall: number; avgF1: number; count: number }>;
		/** Overall averaged across all segments. */
		overall: { avgPrecision: number; avgRecall: number; avgF1: number };
		/** Relationship metrics averaged. */
		relationships: { avgPrecision: number; avgRecall: number; avgF1: number };
		byDifficulty: Record<string, { avgF1: number; count: number }>;
	};
}
