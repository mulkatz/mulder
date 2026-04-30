import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { ApiError } from '@/lib/api-client';

function createQueryClient() {
	return new QueryClient({
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
			mutations: {
				onError: (error) => {
					if (error instanceof ApiError && error.status === 401) {
						window.dispatchEvent(new Event('auth:expired'));
					}
				},
			},
		},
	});
}

export function Providers({ children }: { children: ReactNode }) {
	const [queryClient] = useState(createQueryClient);

	return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
