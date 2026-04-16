import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { EntityDetailResponse } from '@/lib/api-types';

export function useEntity(id: string | null) {
  return useQuery({
    queryKey: ['entities', 'detail', id],
    queryFn: () => apiFetch<EntityDetailResponse>(`/api/entities/${id}`),
    enabled: Boolean(id),
    staleTime: 300_000,
  });
}
