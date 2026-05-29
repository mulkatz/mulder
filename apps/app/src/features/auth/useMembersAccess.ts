import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { CreateInvitationRequest, CreateInvitationResponse, MembersAccessResponse } from '@/lib/api-types';

export function useMembersAccess() {
	return useQuery({
		queryFn: () => apiFetch<MembersAccessResponse>('/api/auth/members-access'),
		queryKey: ['auth', 'members-access'],
		staleTime: 30_000,
	});
}

export function useCreateInvitation() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (request: CreateInvitationRequest) =>
			apiFetch<CreateInvitationResponse>('/api/auth/invitations', {
				body: JSON.stringify(request),
				method: 'POST',
			}),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ['auth', 'members-access'] });
		},
	});
}
