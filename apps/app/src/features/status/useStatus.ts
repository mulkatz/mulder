import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { StatusResponse } from '@/lib/api-types';

export function useStatus() {
	return useQuery({
		queryKey: ['status'],
		queryFn: () => apiFetch<StatusResponse>('/api/status'),
	});
}
