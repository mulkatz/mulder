import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { ContradictionsResponse } from '@/lib/api-types';

export function useContradictions() {
  return useQuery({
    queryKey: ['evidence', 'contradictions'],
    queryFn: () => apiFetch<ContradictionsResponse>('/api/evidence/contradictions?status=all&limit=100&offset=0'),
  });
}
