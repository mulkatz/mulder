import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MotionConfig } from 'framer-motion';
import { type ReactNode, useEffect, useState } from 'react';
import { appTransition } from '@/app/motion';
import { PreferencesProvider } from '@/app/preferences';
import { ApiError } from '@/lib/api-client';

function emitAuthExpired(error: unknown) {
	if (error instanceof ApiError && error.status === 401) {
		if (typeof window === 'undefined') return;
		window.dispatchEvent(new Event('auth:expired'));
	}
}

function createQueryClient() {
	return new QueryClient({
		queryCache: new QueryCache({
			onError: emitAuthExpired,
		}),
		mutationCache: new MutationCache({
			onError: emitAuthExpired,
		}),
		defaultOptions: {
			queries: {
				staleTime: 30_000,
				retry: (count, error) => {
					if (error instanceof ApiError && [401, 403, 404].includes(error.status)) {
						return false;
					}

					return count < 2;
				},
				refetchOnWindowFocus: false,
			},
		},
	});
}

export function Providers({ children }: { children: ReactNode }) {
	const [queryClient] = useState(createQueryClient);

	useEffect(() => {
		function handleAuthExpired() {
			queryClient.removeQueries({ queryKey: ['auth'] });
		}

		window.addEventListener('auth:expired', handleAuthExpired);
		return () => window.removeEventListener('auth:expired', handleAuthExpired);
	}, [queryClient]);

	return (
		<PreferencesProvider>
			<MotionConfig reducedMotion="user" transition={appTransition}>
				<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
			</MotionConfig>
		</PreferencesProvider>
	);
}
