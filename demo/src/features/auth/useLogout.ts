import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import { sessionQueryKey } from './useSession';

export function useLogout() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () =>
      apiFetch<void>('/api/auth/logout', {
        method: 'POST',
      }),
    onSettled: async () => {
      queryClient.removeQueries({ queryKey: sessionQueryKey });
      await queryClient.invalidateQueries();
      window.localStorage.setItem('mulder-auth-sync', String(Date.now()));
    },
  });
}
