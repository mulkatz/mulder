import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { DocumentStoriesResponse } from '@/lib/api-types';

export function useDocumentStories(sourceId?: string) {
	return useQuery({
		queryKey: ['documents', sourceId, 'stories'],
		queryFn: () => apiFetch<DocumentStoriesResponse>(`/api/documents/${sourceId}/stories`),
		enabled: Boolean(sourceId),
	});
}
