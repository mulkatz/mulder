import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { DocumentListResponse, DocumentRecord } from '@/lib/api-types';

async function fetchDocumentById(id: string): Promise<DocumentRecord> {
  const response = await apiFetch<DocumentListResponse>('/api/documents?limit=100&offset=0');
  const document = response.data.find((item) => item.id === id);

  if (!document) {
    throw new Error(`Document not found: ${id}`);
  }

  return document;
}

export function useDocument(id: string) {
  const queryClient = useQueryClient();

  return useQuery({
    queryKey: ['documents', 'detail', id],
    queryFn: async () => {
      const cachedLists = queryClient.getQueriesData<DocumentListResponse>({ queryKey: ['documents', 'list'] });

      for (const [, response] of cachedLists) {
        const document = response?.data.find((item) => item.id === id);
        if (document) {
          return document;
        }
      }

      return fetchDocumentById(id);
    },
    enabled: Boolean(id),
  });
}
