import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

export function useLogout() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: () =>
			apiFetch<void>('/api/auth/logout', {
				method: 'POST',
			}),
		onSettled: () => {
			queryClient.removeQueries({ queryKey: ['auth'] });
			queryClient.removeQueries({ queryKey: ['status'] });
			queryClient.removeQueries({ queryKey: ['jobs'] });
			queryClient.removeQueries({ queryKey: ['documents'] });
			queryClient.removeQueries({ queryKey: ['evidence'] });
		},
	});
}
