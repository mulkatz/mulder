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
    onSettled: () => {
      queryClient.removeQueries({ queryKey: sessionQueryKey });
      queryClient.clear();
      window.localStorage.setItem('mulder-auth-sync', String(Date.now()));
    },
  });
}
