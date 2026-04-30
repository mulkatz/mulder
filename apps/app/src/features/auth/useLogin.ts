import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { SessionResponse } from '@/lib/api-types';

export interface LoginInput {
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
		onSuccess: (session) => {
			queryClient.setQueryData(['auth', 'session'], session);
		},
	});
}
