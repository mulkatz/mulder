import { useMutation } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { SearchResponse } from '@/lib/api-types';

interface SearchInput {
  query: string;
  topK?: number;
}

export function useSearch() {
  return useMutation({
    mutationFn: (input: SearchInput) =>
      apiFetch<SearchResponse>('/api/search?no_rerank=true', {
        method: 'POST',
        body: JSON.stringify({
          query: input.query,
          strategy: 'hybrid',
          top_k: input.topK ?? 8,
          explain: true,
        }),
      }),
  });
}
