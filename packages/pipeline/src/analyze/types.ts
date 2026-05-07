/**
 * Type definitions for the Analyze pipeline step.
 *
 * @see docs/specs/61_contradiction_resolution.spec.md §4.1
 * @see docs/functional-spec.md §2.8
 */

import type {
	ArtifactProvenanceInput,
	ClassificationCategoryRef,
	CoreSimilarityDimensions,
	DomainSimilarityDimension,
	ExternalCorrelation,
	ExternalCorrelationMethod,
	HotspotPersistence,
	ReplaceTemporalPatternSnapshotResult,
	SensitivityLevel,
	SensitivityMetadata,
	SimilarityCacheRecord,
	SimilarityResult,
	StepError,
	TaxonomyMappingReviewStatus,
	TaxonomyMappingSimilarityScore,
} from '@mulder/core';

export interface AnalyzeInput {
	full?: boolean;
	contradictions?: boolean;
	reliability?: boolean;
	evidenceChains?: boolean;
	spatioTemporal?: boolean;
	theses?: string[];
}

export type AnalyzePassName = 'contradictions' | 'reliability' | 'evidence-chains' | 'spatio-temporal';

export type AnalyzePassStatus = 'success' | 'partial' | 'failed' | 'skipped';

export type ContradictionVerdict = 'confirmed' | 'dismissed';

export type WinningClaim = 'A' | 'B' | 'neither';

export interface ContradictionResolutionResponse {
	verdict: ContradictionVerdict;
	winning_claim: WinningClaim;
	confidence: number;
	explanation: string;
	conflict_type?: 'factual' | 'interpretive' | 'taxonomic' | 'temporal' | 'spatial' | 'attributive';
	severity?: 'minor' | 'significant' | 'fundamental';
	severity_rationale?: string;
	resolution_type?:
		| 'different_vantage_point'
		| 'different_time'
		| 'measurement_error'
		| 'source_unreliable'
		| 'scope_difference'
		| 'genuinely_contradictory'
		| 'duplicate_misidentification'
		| 'other';
	evidence_refs?: string[];
}

export interface ContradictionResolutionOutcome {
	edgeId: string;
	entityId: string;
	attribute: string;
	verdict: ContradictionVerdict;
	winningClaim: WinningClaim;
	confidence: number;
	conflictNodeId: string | null;
	conflictResolutionWritten: boolean;
}

export interface ContradictionAnalyzeData {
	mode: 'contradictions';
	pendingCount: number;
	processedCount: number;
	confirmedCount: number;
	dismissedCount: number;
	conflictNodesLinked: number;
	conflictResolutionsWritten: number;
	failedCount: number;
	outcomes: ContradictionResolutionOutcome[];
}

export interface SourceReliabilityOutcome {
	sourceId: string;
	filename: string;
	rawScore: number;
	reliabilityScore: number;
	neighborCount: number;
	sharedEntityCount: number;
}

export interface ReliabilityAnalyzeData {
	mode: 'reliability';
	sourceCount: number;
	scoredCount: number;
	threshold: number;
	belowThreshold: boolean;
	outcomes: SourceReliabilityOutcome[];
}

export type EvidenceChainThesisStatus = 'success' | 'failed' | 'skipped';

export interface EvidenceChainThesisOutcome {
	thesis: string;
	status: EvidenceChainThesisStatus;
	seedCount: number;
	supportingCount: number;
	contradictionCount: number;
	writtenCount: number;
}

export interface EvidenceChainsAvailability {
	sourceCount: number;
	threshold: number;
	belowThreshold: boolean;
	warning: string | null;
}

export interface EvidenceChainsAnalyzeData {
	mode: 'evidence-chains';
	thesisCount: number;
	processedCount: number;
	successCount: number;
	skippedCount: number;
	failedCount: number;
	supportingCount: number;
	contradictionCount: number;
	sourceCount: number;
	threshold: number;
	belowThreshold: boolean;
	warning: string | null;
	outcomes: EvidenceChainThesisOutcome[];
}

export type SpatioTemporalClusterType = 'temporal' | 'spatial' | 'spatio-temporal';

export interface SpatioTemporalEvent {
	entityId: string;
	isoDate: string | null;
	occurredAt: Date | null;
	latitude: number | null;
	longitude: number | null;
}

export interface SpatioTemporalCluster {
	clusterType: SpatioTemporalClusterType;
	centerLat: number | null;
	centerLng: number | null;
	timeStart: Date | null;
	timeEnd: Date | null;
	eventCount: number;
	eventIds: string[];
}

export interface SpatioTemporalAnalyzeData {
	mode: 'spatio-temporal';
	eventCount: number;
	timestampEventCount: number;
	geometryEventCount: number;
	spatioTemporalEventCount: number;
	threshold: number;
	belowThreshold: boolean;
	nothingToAnalyze: boolean;
	persistedCount: number;
	temporalClusterCount: number;
	spatialClusterCount: number;
	spatioTemporalClusterCount: number;
	clusters: SpatioTemporalCluster[];
	warning: string | null;
}

export interface TemporalPatternAnomalySummary {
	regionKey: string;
	timeStart: Date;
	timeEnd: Date;
	entityCount: number;
	baselineRate: number;
	observedRate: number;
	rawSignificance: number;
	correctedSignificance: number;
	contributingEntityIds: string[];
}

export interface TemporalPatternHotspotSummary {
	regionKey: string;
	centroidLat: number;
	centroidLng: number;
	timeStart: Date;
	timeEnd: Date;
	entityCount: number;
	density: number;
	persistence: HotspotPersistence;
	contributingEntityIds: string[];
}

export interface ExternalCorrelationSummary {
	internalSeriesKey: string;
	externalSourceId: string;
	externalSeriesId: string;
	method: ExternalCorrelationMethod;
	coefficient: number;
	pValue: number;
	lagDays: number;
	timeStart: Date;
	timeEnd: Date;
	dataPointCount: number;
	contributingEntityIds: string[];
	interpretationCaveat: string;
}

export interface TemporalPatternAnalyzeData {
	mode: 'temporal-patterns';
	eventCount: number;
	timestampEventCount: number;
	geometryEventCount: number;
	anomalyComparisonCount: number;
	anomalyCount: number;
	hotspotCount: number;
	externalCorrelationCount: number;
	persistedAnomalyCount: number;
	persistedHotspotCount: number;
	persistedExternalCorrelationCount: number;
	warnings: string[];
	caveat: string;
	anomalies: TemporalPatternAnomalySummary[];
	hotspots: TemporalPatternHotspotSummary[];
	externalCorrelations: ExternalCorrelationSummary[];
}

export interface TemporalPatternDetectionResult {
	status: 'success' | 'skipped';
	data: TemporalPatternAnalyzeData;
	snapshot: ReplaceTemporalPatternSnapshotResult & { externalCorrelations: ExternalCorrelation[] };
}

export interface SimilarEntityDiscoveryOptions {
	entityId: string;
	candidateIds?: string[];
	maxResults?: number;
	persistResults?: boolean;
	autoDiscover?: boolean;
	maxSensitivityLevel?: SensitivityLevel;
	explanation?: string;
}

export interface TaxonomyMappingSimilarityInput {
	sourceRefs: ClassificationCategoryRef[];
	targetRefs: ClassificationCategoryRef[];
	reviewStatus?: TaxonomyMappingReviewStatus | TaxonomyMappingReviewStatus[];
	minConfidence?: number;
	maxSensitivityLevel?: SensitivityLevel;
}

export type TaxonomyMappingSimilarityResult = TaxonomyMappingSimilarityScore;

export interface SimilarEntityScore {
	entityId: string;
	entityTitle: string;
	overallRank: number;
	core: CoreSimilarityDimensions;
	domain: DomainSimilarityDimension[];
	explanation: string;
	sharedEntityIds: string[];
	keyDifferences: string[];
	/**
	 * Sort-only score used to rank candidates within a discovery run.
	 * This is not evidence strength, is not persisted to similarity_cache, and
	 * must not be surfaced as review/report trust metadata.
	 */
	weightedRankScore: number;
	provenance: ArtifactProvenanceInput;
	autoDiscoveryThreshold: number;
	sensitivityLevel: SensitivityLevel;
	sensitivityMetadata: SensitivityMetadata;
	cacheRecord: SimilarityCacheRecord | null;
	graphEdgeId: string | null;
	reviewArtifactId: string | null;
}

export interface SimilarEntityDiscoveryResult {
	entityId: string;
	candidatesScored: number;
	persistedCount: number;
	autoLinkCount: number;
	results: SimilarEntityScore[];
	cachedResults: SimilarityResult[];
}

export type SingleAnalyzeData =
	| ContradictionAnalyzeData
	| ReliabilityAnalyzeData
	| EvidenceChainsAnalyzeData
	| SpatioTemporalAnalyzeData;

export interface AnalyzePassResult {
	pass: AnalyzePassName;
	status: AnalyzePassStatus;
	summary: string;
	data: SingleAnalyzeData | null;
	errors: StepError[];
	metadata: {
		duration_ms: number;
		items_processed: number;
		items_skipped: number;
		items_cached: number;
	};
}

export interface FullAnalyzeData {
	mode: 'full';
	passCount: number;
	attemptedCount: number;
	successCount: number;
	partialCount: number;
	failedCount: number;
	skippedCount: number;
	passes: AnalyzePassResult[];
}

export type AnalyzeData = SingleAnalyzeData | FullAnalyzeData;

export interface AnalyzeResult {
	status: 'success' | 'partial' | 'failed';
	data: AnalyzeData;
	errors: StepError[];
	metadata: {
		duration_ms: number;
		items_processed: number;
		items_skipped: number;
		items_cached: number;
	};
}
