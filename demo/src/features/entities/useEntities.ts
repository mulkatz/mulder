import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { EntityListResponse } from '@/lib/api-types';

async function fetchAllEntities(): Promise<EntityListResponse> {
  const pageSize = 100;
  let offset = 0;
  let total = Number.POSITIVE_INFINITY;
  const entities = [];

  while (offset < total && offset < 500) {
    const response = await apiFetch<EntityListResponse>(`/api/entities?limit=${pageSize}&offset=${offset}`);
    entities.push(...response.data);
    total = response.meta.count;
    offset += response.meta.limit;
    if (response.data.length === 0) {
      break;
    }
  }

  return {
    data: entities,
    meta: {
      count: entities.length,
      limit: entities.length,
      offset: 0,
    },
  };
}

export function useEntities() {
  return useQuery({
    queryKey: ['entities', 'catalog'],
    queryFn: fetchAllEntities,
    staleTime: 300_000,
  });
}
