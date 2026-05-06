import type { StepError, TranslatedDocument, TranslationOutputFormat, TranslationPipelinePath } from '@mulder/core';

export type TranslationOutcome = 'translated' | 'cached';

export interface TranslateInput {
	sourceId: string;
	targetLanguage?: string;
	sourceLanguage?: string;
	pipelinePath?: TranslationPipelinePath;
	content?: string;
	outputFormat?: TranslationOutputFormat;
	refresh?: boolean;
}

export interface TranslateData {
	sourceId: string;
	translationId: string;
	outcome: TranslationOutcome;
	sourceLanguage: string;
	targetLanguage: string;
	pipelinePath: TranslationPipelinePath;
	outputFormat: TranslationOutputFormat;
	contentHash: string;
	content: string;
	document: TranslatedDocument;
}

export interface TranslateResult {
	status: 'success';
	data: TranslateData;
	errors: StepError[];
	metadata: {
		duration_ms: number;
		items_processed: number;
		items_cached: number;
	};
}
