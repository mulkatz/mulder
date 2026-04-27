import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { EvidenceChainsResponse } from '@/lib/api-types';

export function useEvidenceChains(thesis?: string, options: { enabled?: boolean } = {}) {
  const params = new URLSearchParams();
  if (thesis?.trim()) {
    params.set('thesis', thesis.trim());
  }

  return useQuery({
    queryKey: ['evidence', 'chains', thesis ?? 'all'],
    queryFn: () => apiFetch<EvidenceChainsResponse>(`/api/evidence/chains${params.size > 0 ? `?${params.toString()}` : ''}`),
    enabled: options.enabled ?? true,
  });
}
