import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { DocumentDetailResponse } from '@/lib/api-types';

export function useDocument(sourceId?: string, options: { refetchInterval?: number | false } = {}) {
	return useQuery({
		enabled: Boolean(sourceId),
		queryFn: () => apiFetch<DocumentDetailResponse>(`/api/documents/${sourceId}`),
		queryKey: ['documents', sourceId, 'detail'],
		refetchInterval: options.refetchInterval,
		staleTime: 30_000,
	});
}
