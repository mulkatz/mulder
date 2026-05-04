import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { SessionResponse } from '@/lib/api-types';

export function useSession() {
	return useQuery({
		queryKey: ['auth', 'session'],
		queryFn: () => apiFetch<SessionResponse>('/api/auth/session'),
		retry: false,
	});
}
