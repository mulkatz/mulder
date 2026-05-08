import { useQuery } from '@tanstack/react-query';
import { apiFetch, apiFetchText } from '@/lib/api-client';
import type { TaxonomyListResponse, TaxonomyStatus } from '@/lib/api-types';

export interface TaxonomyFilters {
	entityType?: string;
	status?: TaxonomyStatus;
	limit?: number;
	offset?: number;
}

function buildTaxonomySearchParams(filters: TaxonomyFilters) {
	const params = new URLSearchParams();
	if (filters.entityType) params.set('entity_type', filters.entityType);
	if (filters.status) params.set('status', filters.status);
	if (filters.limit !== undefined) params.set('limit', String(filters.limit));
	if (filters.offset !== undefined) params.set('offset', String(filters.offset));
	return params.toString();
}

export function useTaxonomyEntries(filters: TaxonomyFilters = {}) {
	return useQuery({
		queryFn: () => {
			const query = buildTaxonomySearchParams(filters);
			return apiFetch<TaxonomyListResponse>(`/api/taxonomy${query ? `?${query}` : ''}`);
		},
		queryKey: ['taxonomy', filters],
		staleTime: 60_000,
	});
}

export function useTaxonomyExport(entityType?: string) {
	return useQuery({
		queryFn: () => {
			const params = new URLSearchParams();
			if (entityType) params.set('entity_type', entityType);
			const query = params.toString();
			return apiFetchText(`/api/taxonomy/export${query ? `?${query}` : ''}`, {
				headers: { Accept: 'application/yaml, text/yaml, text/plain' },
			});
		},
		queryKey: ['taxonomy', 'export', entityType],
		staleTime: 60_000,
	});
}
