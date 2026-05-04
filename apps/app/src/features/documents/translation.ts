import type { AppLocale } from '@/i18n/resources';

export type TranslationStatus = 'not-connected';

export interface StoryTranslationRequest {
	sourceId: string;
	storyId: string;
	targetLanguage: AppLocale;
}

export interface StoryTranslationResult {
	status: TranslationStatus;
}

export async function requestStoryTranslation(_request: StoryTranslationRequest): Promise<StoryTranslationResult> {
	// TODO(M11 translation): call the persisted on-demand translation API when the contract exists.
	return { status: 'not-connected' };
}
