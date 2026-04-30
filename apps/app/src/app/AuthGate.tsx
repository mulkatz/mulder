import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { StateNotice } from '@/components/StateNotice';
import { useSession } from '@/features/auth/useSession';
import { ApiError } from '@/lib/api-client';
import { getErrorMessage } from '@/lib/query-state';

export function AuthGate() {
	const location = useLocation();
	const sessionQuery = useSession();

	if (sessionQuery.isLoading) {
		return (
			<div className="flex min-h-screen items-center justify-center bg-canvas p-4">
				<div className="w-full max-w-sm">
					<StateNotice tone="loading" title="Checking session" />
				</div>
			</div>
		);
	}

	if (sessionQuery.error && !(sessionQuery.error instanceof ApiError && sessionQuery.error.status === 401)) {
		return (
			<div className="flex min-h-screen items-center justify-center bg-canvas p-4">
				<div className="w-full max-w-sm">
					<StateNotice tone="error" title="Session API unavailable">
						{getErrorMessage(sessionQuery.error)}
					</StateNotice>
				</div>
			</div>
		);
	}

	if (!sessionQuery.data) {
		return <Navigate replace state={{ from: location }} to="/login" />;
	}

	return <Outlet />;
}
