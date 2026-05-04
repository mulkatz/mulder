import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { DocumentPagesResponse } from '@/lib/api-types';

export function useDocumentPages(sourceId?: string) {
	return useQuery({
		queryKey: ['documents', sourceId, 'pages'],
		queryFn: () => apiFetch<DocumentPagesResponse>(`/api/documents/${sourceId}/pages`),
		enabled: Boolean(sourceId),
	});
}
