import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { SessionResponse } from '@/lib/api-types';
import { sessionQueryKey } from './useSession';

interface AcceptInviteInput {
  token: string;
  password: string;
}

export function useAcceptInvite() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: AcceptInviteInput) =>
      apiFetch<SessionResponse>('/api/auth/invitations/accept', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: async (session) => {
      queryClient.setQueryData(sessionQueryKey, session);
      await queryClient.invalidateQueries({ queryKey: sessionQueryKey });
    },
  });
}
