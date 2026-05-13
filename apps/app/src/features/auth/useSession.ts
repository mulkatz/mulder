import { useQuery } from '@tanstack/react-query';
import { ApiError, apiFetch } from '@/lib/api-client';
import type { SessionResponse } from '@/lib/api-types';

export function useSession() {
	return useQuery({
		queryKey: ['auth', 'session'],
		queryFn: async () => {
			try {
				return await apiFetch<SessionResponse>('/api/auth/session');
			} catch (error) {
				if (error instanceof ApiError && error.status === 401) {
					return null;
				}
				throw error;
			}
		},
		retry: false,
	});
}
