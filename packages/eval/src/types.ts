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

// ────────────────────────────────────────────────────────────
// Quality-routing golden annotations
// ────────────────────────────────────────────────────────────

export type DocumentOverallQuality = 'high' | 'medium' | 'low' | 'unusable';

export type ExtractionPath =
	| 'standard'
	| 'enhanced_ocr'
	| 'visual_extraction'
	| 'handwriting_recognition'
	| 'manual_transcription_required'
	| 'skip';

export type ExtractionGateOutcome = 'allow' | 'skip';

export interface ExpectedQualityMetadata {
	source_document_quality: 'high' | 'medium' | 'low';
	extraction_path: ExtractionPath;
	extraction_confidence: number;
}

export interface QualityRoutingGolden {
	caseId: string;
	sourceSlug: string;
	difficulty: DifficultyLevel;
	expected: {
		overallQuality: DocumentOverallQuality;
		processable: boolean;
		recommendedPath: ExtractionPath;
		extractionGateOutcome: ExtractionGateOutcome;
		qualityMetadata: ExpectedQualityMetadata;
		signals: Record<string, unknown>;
	};
	annotation: {
		author: string;
		date: string;
		notes?: string;
	};
}

export interface ActualQualityRoutingCase {
	caseId: string;
	sourceSlug: string;
	assessment: {
		overallQuality: DocumentOverallQuality;
		processable: boolean;
		recommendedPath: ExtractionPath;
		signals: Record<string, unknown>;
	};
	extractionGate: {
		outcome: ExtractionGateOutcome;
	};
	qualityMetadata: ExpectedQualityMetadata;
}

export interface EvalMismatch {
	field: string;
	expected: unknown;
	actual: unknown;
}

export interface QualityRoutingCaseResult {
	caseId: string;
	sourceSlug: string;
	difficulty: DifficultyLevel;
	overallQuality: DocumentOverallQuality;
	recommendedPath: ExtractionPath;
	processable: boolean;
	passed: boolean;
	checks: {
		overallQuality: boolean;
		processable: boolean;
		recommendedPath: boolean;
		extractionGateOutcome: boolean;
		qualityMetadata: boolean;
		signals: boolean;
	};
	mismatches: EvalMismatch[];
}

export interface QualityRoutingEvalResult {
	timestamp: string;
	cases: QualityRoutingCaseResult[];
	summary: {
		totalCases: number;
		passedCases: number;
		failedCases: number;
		passRate: number;
		coverage: {
			byQuality: Record<DocumentOverallQuality, number>;
			byRoute: Partial<Record<ExtractionPath, number>>;
		};
	};
}

// ────────────────────────────────────────────────────────────
// Assertion-classification golden annotations
// ────────────────────────────────────────────────────────────

export type AssertionType = 'observation' | 'interpretation' | 'hypothesis';

export type ClassificationProvenance = 'llm_auto' | 'human_reviewed' | 'author_explicit';

export interface AssertionConfidenceMetadata {
	witness_count: number | null;
	measurement_based: boolean;
	contemporaneous: boolean;
	corroborated: boolean;
	peer_reviewed: boolean;
	author_is_interpreter: boolean;
}

export interface AssertionClassificationGolden {
	caseId: string;
	segmentId: string;
	sourceSlug: string;
	difficulty: DifficultyLevel;
	expected: {
		content: string;
		assertionType: AssertionType;
		classificationProvenance: ClassificationProvenance;
		confidenceMetadata: AssertionConfidenceMetadata;
		entityNames?: string[];
		qualityMetadata?: Record<string, unknown>;
	};
	annotation: {
		author: string;
		date: string;
		notes?: string;
	};
}

export interface ActualAssertionCase {
	caseId: string;
	segmentId: string;
	sourceSlug: string;
	assertion: {
		content: string;
		assertion_type: AssertionType;
		classification_provenance: ClassificationProvenance;
		confidence_metadata: AssertionConfidenceMetadata;
		entity_names?: string[];
		quality_metadata?: Record<string, unknown>;
	};
}

export interface AssertionClassificationCaseResult {
	caseId: string;
	segmentId: string;
	sourceSlug: string;
	difficulty: DifficultyLevel;
	assertionType: AssertionType;
	classificationProvenance: ClassificationProvenance;
	passed: boolean;
	checks: {
		content: boolean;
		assertionType: boolean;
		classificationProvenance: boolean;
		confidenceMetadata: boolean;
		entityNames: boolean;
		qualityMetadata: boolean;
	};
	mismatches: EvalMismatch[];
}

export interface AssertionClassificationEvalResult {
	timestamp: string;
	cases: AssertionClassificationCaseResult[];
	summary: {
		totalCases: number;
		passedCases: number;
		failedCases: number;
		passRate: number;
		coverage: {
			byAssertionType: Record<AssertionType, number>;
			byProvenance: Partial<Record<ClassificationProvenance, number>>;
		};
	};
}

// ────────────────────────────────────────────────────────────
// Retrieval golden annotations (Phase 3, D5)
// ────────────────────────────────────────────────────────────

/** Relevance level of an expected retrieval hit. */
export type RetrievalRelevance = 'primary' | 'secondary' | 'tangential';

/**
 * A chunk that is expected to show up for a query. Identified by a stable
 * content excerpt so golden files are independent of generated chunk IDs.
 *
 * The eval runner treats a result as "matching" a golden hit if the result's
 * content contains `contentContains` as a substring (case-insensitive). The
 * optional `storyTitle` is used only when the runner cannot determine story
 * identity from content alone (e.g., when deduping across multiple runs).
 */
export interface ExpectedRetrievalHit {
	/** Substring that uniquely identifies the expected chunk in the corpus. */
	contentContains: string;
	/** Optional: story title for disambiguation. */
	storyTitle?: string;
	/** Relevance label (`primary` ≈ "must appear", `secondary` ≈ "should appear"). */
	relevance: RetrievalRelevance;
}

/** Query type taxonomy — used for per-category reporting. */
export type RetrievalQueryType = 'factual' | 'exploratory' | 'relational' | 'negative';

/** Ground-truth annotation for a single retrieval query. */
export interface RetrievalGolden {
	/** Stable identifier for the query. */
	queryId: string;
	/** Natural-language query text passed verbatim to `hybridRetrieve`. */
	queryText: string;
	/** Locale of the query. */
	language: 'de' | 'en';
	/** Query category for reporting. */
	queryType: RetrievalQueryType;
	/** Difficulty level for reporting. */
	difficulty: DifficultyLevel;
	/**
	 * Expected chunks, in no particular order. A `negative` query has
	 * `expectedHits: []` and the metric runner flips the assertion — any
	 * non-empty result is a miss.
	 */
	expectedHits: ExpectedRetrievalHit[];
	/** Entities the orchestrator should extract from the query (optional check). */
	expectedEntities?: string[];
	/** Annotation metadata. */
	annotation: {
		author: string;
		date: string;
		notes?: string;
	};
}

// ────────────────────────────────────────────────────────────
// Retrieval actual results (runner input)
// ────────────────────────────────────────────────────────────

/**
 * A single retrieval hit as observed in the system under test. Mirrors the
 * shape of `RerankedResult` from `@mulder/retrieval` but trimmed to what the
 * runner needs — we deliberately avoid importing from `@mulder/retrieval` to
 * keep the eval package free of a retrieval dependency.
 */
export interface ActualRetrievalHit {
	chunkId: string;
	storyId: string;
	content: string;
	/** 1-based rank in the final result list. */
	rank: number;
	/** Final score (RRF or reranker, depending on pipeline config). */
	score: number;
}

/** Actual retrieval results for one golden query. */
export interface ActualRetrievalRun {
	queryId: string;
	hits: ActualRetrievalHit[];
}

// ────────────────────────────────────────────────────────────
// Retrieval metric results
// ────────────────────────────────────────────────────────────

/** Precision@k, Recall@k, F1@k metric tuple. */
export interface RetrievalMetricAtK {
	k: number;
	precision: number;
	recall: number;
	f1: number;
}

/** Per-query retrieval metric result. */
export interface RetrievalMetricResult {
	queryId: string;
	queryText: string;
	queryType: RetrievalQueryType;
	difficulty: string;
	/** Metrics at the configured k values (default: k = 5 and k = 10). */
	atK: RetrievalMetricAtK[];
	/** Mean Reciprocal Rank of the first primary hit. 0 if no primary hit found. */
	mrr: number;
	/** nDCG@10. 0 if no expected hits are primary. */
	ndcg10: number;
	/** Number of expected `primary` hits that appeared anywhere in results. */
	primaryRecall: number;
	/** Total number of `primary` expected hits for this query. */
	primaryTotal: number;
	/** True if the query was negative (expected empty) and no results appeared. */
	negativeSatisfied?: boolean;
}

/** Aggregate retrieval eval results. */
export interface RetrievalEvalResult {
	timestamp: string;
	queries: RetrievalMetricResult[];
	summary: {
		totalQueries: number;
		/** Averages across all non-negative queries. */
		averages: {
			precisionAt5: number;
			precisionAt10: number;
			recallAt5: number;
			recallAt10: number;
			mrr: number;
			ndcg10: number;
		};
		/** Negative-query satisfaction ratio (none/positive results for `negative` queries). */
		negativeSatisfiedRatio: number;
		/** Per query-type averaged MRR + Precision@5. */
		byType: Record<string, { avgMrr: number; avgPrecisionAt5: number; count: number }>;
		/** Per difficulty averaged MRR. */
		byDifficulty: Record<string, { avgMrr: number; count: number }>;
	};
}
