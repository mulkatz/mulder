import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { RuntimeConfigResponse } from '@/lib/api-types';

export function useRuntimeConfig() {
	return useQuery({
		queryFn: () => apiFetch<RuntimeConfigResponse>('/api/runtime-config'),
		queryKey: ['runtime-config'],
		staleTime: 5 * 60_000,
	});
}
