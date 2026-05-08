import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
	DocumentCredibilityResponse,
	DocumentQualityResponse,
	SourceCredibilityListResponse,
} from '@/lib/api-types';

export interface SourceCredibilityFilters {
	sourceType?: 'government' | 'academic' | 'journalist' | 'witness' | 'organization' | 'anonymous' | 'other';
	reviewStatus?: 'draft' | 'reviewed' | 'contested';
	limit?: number;
	offset?: number;
}

function buildSourceCredibilitySearchParams(filters: SourceCredibilityFilters) {
	const params = new URLSearchParams();
	if (filters.sourceType) params.set('source_type', filters.sourceType);
	if (filters.reviewStatus) params.set('review_status', filters.reviewStatus);
	if (filters.limit !== undefined) params.set('limit', String(filters.limit));
	if (filters.offset !== undefined) params.set('offset', String(filters.offset));
	return params.toString();
}

export function useDocumentQuality(sourceId?: string) {
	return useQuery({
		enabled: Boolean(sourceId),
		queryFn: () => apiFetch<DocumentQualityResponse>(`/api/documents/${sourceId}/quality`),
		queryKey: ['documents', sourceId, 'quality'],
		staleTime: 30_000,
	});
}

export function useDocumentCredibility(sourceId?: string) {
	return useQuery({
		enabled: Boolean(sourceId),
		queryFn: () => apiFetch<DocumentCredibilityResponse>(`/api/documents/${sourceId}/credibility`),
		queryKey: ['documents', sourceId, 'credibility'],
		staleTime: 30_000,
	});
}

export function useSourceCredibility(filters: SourceCredibilityFilters = {}) {
	return useQuery({
		queryFn: () => {
			const query = buildSourceCredibilitySearchParams(filters);
			return apiFetch<SourceCredibilityListResponse>(`/api/source-credibility${query ? `?${query}` : ''}`);
		},
		queryKey: ['source-credibility', filters],
		staleTime: 30_000,
	});
}
