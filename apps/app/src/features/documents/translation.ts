import type { AppLocale } from '@/i18n/resources';

export type TranslationStatus = 'not-connected';

export interface SourceTranslationRequest {
	sourceId: string;
	sourceLanguage?: string | null;
	targetLanguage: AppLocale;
	refresh?: boolean;
}

export interface SourceTranslationResult {
	status: TranslationStatus;
}

export async function requestSourceTranslation(_request: SourceTranslationRequest): Promise<SourceTranslationResult> {
	// TODO(translation API): call the persisted on-demand source translation API when the HTTP contract exists.
	return { status: 'not-connected' };
}
