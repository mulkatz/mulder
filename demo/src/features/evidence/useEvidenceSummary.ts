import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { EvidenceSummary } from '@/lib/api-types';

export function useEvidenceSummary() {
  return useQuery({
    queryKey: ['evidence', 'summary'],
    queryFn: () => apiFetch<EvidenceSummary>('/api/evidence/summary'),
  });
}
