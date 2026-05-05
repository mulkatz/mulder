import type { DocumentQualityAssessment, StepError } from '@mulder/core';

export interface QualityInput {
	sourceId: string;
	force?: boolean;
}

export interface QualityData {
	sourceId: string;
	assessment: DocumentQualityAssessment;
	reusedExisting: boolean;
}

export interface QualityResult {
	status: 'success' | 'skipped' | 'failed';
	data: QualityData | null;
	errors: StepError[];
	metadata: {
		duration_ms: number;
		items_processed: number;
		items_skipped: number;
		items_cached: number;
	};
}
