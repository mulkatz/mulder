import type { SensitivityLevel, SensitivityMetadata } from '../../shared/sensitivity.js';

export type TranslationStatus = 'current' | 'stale';
export type TranslationPipelinePath = 'full' | 'translation_only';
export type TranslationOutputFormat = 'markdown' | 'html';

export interface TranslatedDocument {
	id: string;
	sourceDocumentId: string;
	sourceLanguage: string;
	targetLanguage: string;
	translationEngine: string;
	translationDate: Date;
	content: string;
	contentHash: string;
	status: TranslationStatus;
	pipelinePath: TranslationPipelinePath;
	outputFormat: TranslationOutputFormat;
	sensitivityLevel: SensitivityLevel;
	sensitivityMetadata: SensitivityMetadata;
	createdAt: Date;
	updatedAt: Date;
}

export interface CreateCurrentTranslatedDocumentInput {
	sourceDocumentId: string;
	sourceLanguage: string;
	targetLanguage: string;
	translationEngine: string;
	content: string;
	contentHash: string;
	pipelinePath: TranslationPipelinePath;
	outputFormat: TranslationOutputFormat;
	sensitivityLevel?: SensitivityLevel;
	sensitivityMetadata?: unknown;
	translationDate?: Date;
}

export interface ListTranslatedDocumentsOptions {
	targetLanguage?: string;
	status?: TranslationStatus;
	includeDeletedSources?: boolean;
	limit?: number;
	offset?: number;
}
