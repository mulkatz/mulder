import { useQuery } from '@tanstack/react-query';
import { apiFetchText } from '@/lib/api-client';

export function useDocumentLayout(id: string) {
  return useQuery({
    queryKey: ['documents', 'layout', id],
    queryFn: () => apiFetchText(`/api/documents/${id}/layout`),
    enabled: Boolean(id),
  });
}
