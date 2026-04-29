import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { EvidenceReliabilitySourcesResponse } from '@/lib/api-types';

export function useEvidenceReliabilitySources(options: { scoredOnly?: boolean; limit?: number; enabled?: boolean } = {}) {
  const params = new URLSearchParams();
  params.set('scored_only', String(options.scoredOnly ?? false));
  params.set('limit', String(options.limit ?? 50));
  params.set('offset', '0');

  return useQuery({
    queryKey: ['evidence', 'reliability-sources', options],
    queryFn: () => apiFetch<EvidenceReliabilitySourcesResponse>(`/api/evidence/reliability/sources?${params.toString()}`),
    enabled: options.enabled ?? true,
  });
}
