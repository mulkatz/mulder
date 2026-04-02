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
