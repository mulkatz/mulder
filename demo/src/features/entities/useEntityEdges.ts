import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { EntityEdgesResponse } from '@/lib/api-types';

export function useEntityEdges(id: string | null) {
  return useQuery({
    queryKey: ['entities', 'edges', id],
    queryFn: () => apiFetch<EntityEdgesResponse>(`/api/entities/${id}/edges`),
    enabled: Boolean(id),
    staleTime: 300_000,
  });
}
