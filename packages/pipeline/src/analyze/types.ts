/**
 * Type definitions for the Analyze pipeline step.
 *
 * @see docs/specs/61_contradiction_resolution.spec.md §4.1
 * @see docs/functional-spec.md §2.8
 */

import type { StepError } from '@mulder/core';

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
}

export interface ContradictionResolutionOutcome {
	edgeId: string;
	entityId: string;
	attribute: string;
	verdict: ContradictionVerdict;
	winningClaim: WinningClaim;
	confidence: number;
}

export interface ContradictionAnalyzeData {
	mode: 'contradictions';
	pendingCount: number;
	processedCount: number;
	confirmedCount: number;
	dismissedCount: number;
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

export type EvidenceChainThesisStatus = 'success' | 'failed';

export interface EvidenceChainThesisOutcome {
	thesis: string;
	status: EvidenceChainThesisStatus;
	seedCount: number;
	supportingCount: number;
	contradictionCount: number;
	writtenCount: number;
}

export interface EvidenceChainsAnalyzeData {
	mode: 'evidence-chains';
	thesisCount: number;
	processedCount: number;
	successCount: number;
	failedCount: number;
	supportingCount: number;
	contradictionCount: number;
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
