import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { EntityListResponse } from '@/lib/api-types';

interface UseEntitiesOptions {
  search?: string;
  type?: string;
  taxonomy_status?: string;
  limit?: number;
  enabled?: boolean;
}

function buildEntitiesQuery(options: UseEntitiesOptions, offset: number, pageSize: number) {
  const params = new URLSearchParams();
  params.set('limit', String(pageSize));
  params.set('offset', String(offset));

  if (options.search) {
    params.set('search', options.search);
  }

  if (options.type && options.type !== 'all') {
    params.set('type', options.type);
  }

  if (options.taxonomy_status) {
    params.set('taxonomy_status', options.taxonomy_status);
  }

  return `/api/entities?${params.toString()}`;
}

async function fetchAllEntities(options: UseEntitiesOptions): Promise<EntityListResponse> {
  const pageSize = options.limit ?? 100;
  let offset = 0;
  let total = Number.POSITIVE_INFINITY;
  const entities = [];

  while (offset < total && offset < 500) {
    const response = await apiFetch<EntityListResponse>(buildEntitiesQuery(options, offset, pageSize));
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

export function useEntities(options: UseEntitiesOptions = {}) {
  return useQuery({
    queryKey: ['entities', 'catalog', options],
    queryFn: () => fetchAllEntities(options),
    enabled: options.enabled ?? true,
    staleTime: 300_000,
  });
}
