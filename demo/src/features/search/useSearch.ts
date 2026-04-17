import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { SearchResponse } from '@/lib/api-types';

interface UseSearchOptions {
  strategy?: 'vector' | 'fulltext' | 'graph' | 'hybrid';
  explain?: boolean;
  noRerank?: boolean;
  enabled?: boolean;
  topK?: number;
}

function buildSearchUrl(noRerank: boolean) {
  return noRerank ? '/api/search?no_rerank=true' : '/api/search';
}

export function useSearch(query: string, options: UseSearchOptions = {}) {
  const trimmedQuery = query.trim();
  const enabled = options.enabled ?? trimmedQuery.length > 0;

  return useQuery({
    queryKey: ['search', trimmedQuery, options.strategy ?? 'hybrid', options.explain ?? false, options.noRerank ?? false],
    queryFn: () =>
      apiFetch<SearchResponse>(buildSearchUrl(options.noRerank ?? false), {
        method: 'POST',
        body: JSON.stringify({
          query: trimmedQuery,
          strategy: options.strategy ?? 'hybrid',
          top_k: options.topK ?? 8,
          explain: options.explain ?? false,
        }),
      }),
    enabled,
    retry: false,
    staleTime: 0,
  });
}
