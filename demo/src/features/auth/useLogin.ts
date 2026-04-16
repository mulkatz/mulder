import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { SessionResponse } from '@/lib/api-types';
import { sessionQueryKey } from './useSession';

interface LoginInput {
  email: string;
  password: string;
}

export function useLogin() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: LoginInput) =>
      apiFetch<SessionResponse>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: async (session) => {
      queryClient.setQueryData(sessionQueryKey, session);
      await queryClient.invalidateQueries({ queryKey: sessionQueryKey });
    },
  });
}
