import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { AssertionType, ClaimDetailResponse, ClaimListResponse } from '@/lib/api-types';

export interface ClaimFilters {
	sourceId?: string;
	storyId?: string;
	assertionType?: AssertionType;
	limit?: number;
	offset?: number;
}

function buildClaimSearchParams(filters: ClaimFilters) {
	const params = new URLSearchParams();
	if (filters.sourceId) params.set('source_id', filters.sourceId);
	if (filters.storyId) params.set('story_id', filters.storyId);
	if (filters.assertionType) params.set('assertion_type', filters.assertionType);
	if (filters.limit !== undefined) params.set('limit', String(filters.limit));
	if (filters.offset !== undefined) params.set('offset', String(filters.offset));
	return params.toString();
}

export function useClaims(filters: ClaimFilters = {}) {
	return useQuery({
		queryFn: () => {
			const query = buildClaimSearchParams(filters);
			return apiFetch<ClaimListResponse>(`/api/claims${query ? `?${query}` : ''}`);
		},
		queryKey: ['claims', filters],
		staleTime: 30_000,
	});
}

export function useDocumentClaims(sourceId?: string, filters: Omit<ClaimFilters, 'sourceId'> = {}) {
	return useQuery({
		enabled: Boolean(sourceId),
		queryFn: () => {
			const query = buildClaimSearchParams(filters);
			return apiFetch<ClaimListResponse>(`/api/documents/${sourceId}/claims${query ? `?${query}` : ''}`);
		},
		queryKey: ['documents', sourceId, 'claims', filters],
		staleTime: 30_000,
	});
}

export function useStoryClaims(storyId?: string, filters: Omit<ClaimFilters, 'storyId'> = {}) {
	return useQuery({
		enabled: Boolean(storyId),
		queryFn: () => {
			const query = buildClaimSearchParams(filters);
			return apiFetch<ClaimListResponse>(`/api/stories/${storyId}/claims${query ? `?${query}` : ''}`);
		},
		queryKey: ['stories', storyId, 'claims', filters],
		staleTime: 30_000,
	});
}

export function useClaim(claimId?: string) {
	return useQuery({
		enabled: Boolean(claimId),
		queryFn: () => apiFetch<ClaimDetailResponse>(`/api/claims/${claimId}`),
		queryKey: ['claims', claimId],
		staleTime: 30_000,
	});
}
