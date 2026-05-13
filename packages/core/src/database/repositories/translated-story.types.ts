import type { SensitivityLevel, SensitivityMetadata } from '../../shared/sensitivity.js';
import type { Entity } from './entity.types.js';

export type TranslatedMentionMethod = 'llm_structured_verified';

export interface TranslatedStoryEntityMention {
	id: string;
	translatedStoryId: string;
	entityId: string;
	surfaceText: string;
	startOffset: number;
	endOffset: number;
	confidence: number | null;
	method: TranslatedMentionMethod;
	createdAt: Date;
	entity?: Entity;
}

export interface TranslatedStory {
	id: string;
	translationId: string;
	storyId: string;
	sourceDocumentId: string;
	sourceLanguage: string;
	targetLanguage: string;
	title: string;
	subtitle: string | null;
	markdown: string;
	contentHash: string;
	sensitivityLevel: SensitivityLevel;
	sensitivityMetadata: SensitivityMetadata;
	createdAt: Date;
	updatedAt: Date;
	mentions: TranslatedStoryEntityMention[];
}

export interface CreateTranslatedStoryInput {
	translationId: string;
	storyId: string;
	sourceDocumentId: string;
	sourceLanguage: string;
	targetLanguage: string;
	title: string;
	subtitle?: string | null;
	markdown: string;
	contentHash: string;
	sensitivityLevel?: SensitivityLevel;
	sensitivityMetadata?: unknown;
}

export interface CreateTranslatedStoryMentionInput {
	translatedStoryId: string;
	entityId: string;
	surfaceText: string;
	startOffset: number;
	endOffset: number;
	confidence?: number | null;
	method: TranslatedMentionMethod;
}

export interface CreateTranslatedStoryBundleInput extends CreateTranslatedStoryInput {
	mentions?: Omit<CreateTranslatedStoryMentionInput, 'translatedStoryId'>[];
}
