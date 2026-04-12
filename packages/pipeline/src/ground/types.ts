/**
 * Type definitions for the Ground pipeline step.
 *
 * @see docs/specs/60_ground_step.spec.md §4.1
 * @see docs/functional-spec.md §2.5
 */

import type { StepError } from '@mulder/core';

export interface GroundInput {
	entityId: string;
	refresh?: boolean;
}

export type GroundOutcome = 'grounded' | 'cached' | 'skipped';

export interface GroundResult {
	status: 'success' | 'partial' | 'failed';
	data: GroundingData | null;
	errors: StepError[];
	metadata: {
		duration_ms: number;
		items_processed: number;
		items_skipped: number;
		items_cached: number;
	};
}

export interface GroundingData {
	entityId: string;
	entityType: string;
	outcome: GroundOutcome;
	refreshed: boolean;
	sourceUrlCount: number;
	coordinatesApplied: boolean;
}
