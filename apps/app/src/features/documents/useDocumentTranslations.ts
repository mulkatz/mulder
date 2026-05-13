import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
	CreateTranslationRequest,
	TranslationAcceptedResponse,
	TranslationDetailResponse,
	TranslationListResponse,
	TranslationStatus,
	TranslationStoriesResponse,
} from '@/lib/api-types';

export interface DocumentTranslationFilters {
	targetLanguage?: string;
	status?: TranslationStatus;
	limit?: number;
	offset?: number;
}

function buildTranslationSearchParams(filters: DocumentTranslationFilters) {
	const params = new URLSearchParams();
	if (filters.targetLanguage) params.set('target_language', filters.targetLanguage);
	if (filters.status) params.set('status', filters.status);
	if (filters.limit !== undefined) params.set('limit', String(filters.limit));
	if (filters.offset !== undefined) params.set('offset', String(filters.offset));
	return params.toString();
}

export function useDocumentTranslations(sourceId?: string, filters: DocumentTranslationFilters = {}) {
	return useQuery({
		enabled: Boolean(sourceId),
		queryFn: () => {
			const query = buildTranslationSearchParams(filters);
			return apiFetch<TranslationListResponse>(`/api/documents/${sourceId}/translations${query ? `?${query}` : ''}`);
		},
		queryKey: ['documents', sourceId, 'translations', filters],
		staleTime: 30_000,
	});
}

export function useRequestDocumentTranslation(sourceId?: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (request: CreateTranslationRequest) => {
			if (!sourceId) {
				throw new Error('sourceId is required to request a translation');
			}
			return apiFetch<TranslationDetailResponse | TranslationAcceptedResponse>(
				`/api/documents/${sourceId}/translations`,
				{
					body: JSON.stringify(request),
					method: 'POST',
				},
			);
		},
		onSuccess: () => {
			if (sourceId) {
				void queryClient.invalidateQueries({ queryKey: ['documents', sourceId, 'translations'] });
			}
		},
	});
}

export function useTranslationDetail(translationId?: string) {
	return useQuery({
		enabled: Boolean(translationId),
		queryFn: () => apiFetch<TranslationDetailResponse>(`/api/translations/${translationId}`),
		queryKey: ['translations', translationId],
		staleTime: 30_000,
	});
}

export function useTranslationStories(translationId?: string) {
	return useQuery({
		enabled: Boolean(translationId),
		queryFn: () => apiFetch<TranslationStoriesResponse>(`/api/translations/${translationId}/stories`),
		queryKey: ['translations', translationId, 'stories'],
		staleTime: 30_000,
	});
}
