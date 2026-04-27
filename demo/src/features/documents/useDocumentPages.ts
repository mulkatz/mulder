import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { DocumentPagesResponse } from '@/lib/api-types';

export function useDocumentPages(id: string) {
  return useQuery({
    queryKey: ['documents', 'pages', id],
    queryFn: () => apiFetch<DocumentPagesResponse>(`/api/documents/${id}/pages`),
    enabled: Boolean(id),
  });
}
