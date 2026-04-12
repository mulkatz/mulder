/**
 * Type definitions for the Analyze pipeline step.
 *
 * @see docs/specs/61_contradiction_resolution.spec.md §4.1
 * @see docs/functional-spec.md §2.8
 */

import type { StepError } from '@mulder/core';

export interface AnalyzeInput {
	contradictions: boolean;
}

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

export interface AnalyzeData {
	pendingCount: number;
	processedCount: number;
	confirmedCount: number;
	dismissedCount: number;
	failedCount: number;
	outcomes: ContradictionResolutionOutcome[];
}

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
