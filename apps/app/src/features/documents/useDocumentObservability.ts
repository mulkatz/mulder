import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { DocumentObservabilityResponse } from '@/lib/api-types';

export function useDocumentObservability(sourceId?: string) {
	return useQuery({
		queryKey: ['documents', sourceId, 'observability'],
		queryFn: () => apiFetch<DocumentObservabilityResponse>(`/api/documents/${sourceId}/observability`),
		enabled: Boolean(sourceId),
	});
}
