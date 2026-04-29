import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { EvidenceClustersResponse } from '@/lib/api-types';

export function useEvidenceClusters(
  clusterType?: 'temporal' | 'spatial' | 'spatio-temporal',
  options: { enabled?: boolean } = {},
) {
  const params = new URLSearchParams();
  if (clusterType) {
    params.set('cluster_type', clusterType);
  }

  return useQuery({
    queryKey: ['evidence', 'clusters', clusterType ?? 'all'],
    queryFn: () => apiFetch<EvidenceClustersResponse>(`/api/evidence/clusters${params.size > 0 ? `?${params.toString()}` : ''}`),
    enabled: options.enabled ?? true,
  });
}
