import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { SessionResponse } from '@/lib/api-types';

export interface AcceptInvitationInput {
	token: string;
	password: string;
}

export function useAcceptInvitation() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (input: AcceptInvitationInput) =>
			apiFetch<SessionResponse>('/api/auth/invitations/accept', {
				method: 'POST',
				body: JSON.stringify(input),
			}),
		onSuccess: (session) => {
			queryClient.setQueryData(['auth', 'session'], session);
		},
	});
}
