import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { EntityListResponse } from '@/lib/api-types';

interface UseEntitiesOptions {
  type?: string;
  search?: string;
  taxonomyStatus?: 'auto' | 'curated' | 'merged';
  limit?: number;
  offset?: number;
}

function buildEntitiesQuery(options: UseEntitiesOptions, limit: number, offset: number) {
  const params = new URLSearchParams();

  if (options.type) {
    params.set('type', options.type);
  }

  if (options.search) {
    params.set('search', options.search);
  }

  if (options.taxonomyStatus) {
    params.set('taxonomy_status', options.taxonomyStatus);
  }

  params.set('limit', String(limit));
  params.set('offset', String(offset));

  return `/api/entities?${params.toString()}`;
}

async function fetchEntitiesPage(options: UseEntitiesOptions): Promise<EntityListResponse> {
  return apiFetch<EntityListResponse>(
    buildEntitiesQuery(options, options.limit ?? 100, options.offset ?? 0),
  );
}

async function fetchAllEntities(): Promise<EntityListResponse> {
  const pageSize = 100;
  let offset = 0;
  let total = Number.POSITIVE_INFINITY;
  const entities: EntityListResponse['data'] = [];

  while (offset < total && offset < 500) {
    const response = await apiFetch<EntityListResponse>(buildEntitiesQuery({}, pageSize, offset));
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
  const queryFn =
    options.type || options.search || options.taxonomyStatus || options.limit || options.offset
      ? () => fetchEntitiesPage(options)
      : fetchAllEntities;

  return useQuery({
    queryKey: [
      'entities',
      'catalog',
      options.type ?? null,
      options.search ?? null,
      options.taxonomyStatus ?? null,
      options.limit ?? null,
      options.offset ?? null,
    ],
    queryFn,
    staleTime: 300_000,
  });
}
