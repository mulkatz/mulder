import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { ContradictionsResponse } from '@/lib/api-types';

interface UseContradictionsOptions {
  status?: 'potential' | 'confirmed' | 'dismissed' | 'all';
  limit?: number;
  offset?: number;
  enabled?: boolean;
}

function buildContradictionsQuery(options: UseContradictionsOptions) {
  const params = new URLSearchParams();
  params.set('status', options.status ?? 'all');
  params.set('limit', String(options.limit ?? 100));
  params.set('offset', String(options.offset ?? 0));
  return `/api/evidence/contradictions?${params.toString()}`;
}

export function useContradictions(options: UseContradictionsOptions = {}) {
  return useQuery({
    queryKey: ['evidence', 'contradictions', options],
    queryFn: () => apiFetch<ContradictionsResponse>(buildContradictionsQuery(options)),
    enabled: options.enabled ?? true,
  });
}
