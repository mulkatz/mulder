import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { StateNotice } from '@/components/StateNotice';
import { useSession } from '@/features/auth/useSession';

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

	if (!sessionQuery.data) {
		return <Navigate replace state={{ from: location }} to="/login" />;
	}

	return <Outlet />;
}
