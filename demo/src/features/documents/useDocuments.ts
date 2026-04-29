import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { DocumentListResponse } from '@/lib/api-types';

interface UseDocumentsOptions {
  status?: string;
  search?: string;
  limit?: number;
  offset?: number;
  enabled?: boolean;
}

function buildDocumentsQuery(options: UseDocumentsOptions) {
  const params = new URLSearchParams();

  if (options.status) {
    params.set('status', options.status);
  }

  if (options.search) {
    params.set('search', options.search);
  }

  params.set('limit', String(options.limit ?? 100));
  params.set('offset', String(options.offset ?? 0));

  return `/api/documents?${params.toString()}`;
}

export function useDocuments(options: UseDocumentsOptions = {}) {
  return useQuery({
    queryKey: ['documents', 'list', options],
    queryFn: () => apiFetch<DocumentListResponse>(buildDocumentsQuery(options)),
    enabled: options.enabled ?? true,
  });
}
