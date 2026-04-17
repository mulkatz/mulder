import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { ContradictionsResponse } from '@/lib/api-types';

interface UseContradictionsOptions {
  status?: 'potential' | 'confirmed' | 'dismissed' | 'all';
  limit?: number;
  offset?: number;
}

export function useContradictions(options: UseContradictionsOptions = {}) {
  const status = options.status ?? 'all';
  const limit = options.limit ?? 100;
  const offset = options.offset ?? 0;

  return useQuery({
    queryKey: ['evidence', 'contradictions', status, limit, offset],
    queryFn: () =>
      apiFetch<ContradictionsResponse>(
        `/api/evidence/contradictions?status=${status}&limit=${limit}&offset=${offset}`,
      ),
  });
}
