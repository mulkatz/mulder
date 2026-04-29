import { useMutation } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { InvitationResponse, UserRole } from '@/lib/api-types';

interface CreateInviteInput {
  email: string;
  role: UserRole;
}

export function useCreateInvite() {
  return useMutation({
    mutationFn: (input: CreateInviteInput) =>
      apiFetch<InvitationResponse>('/api/auth/invitations', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
  });
}
