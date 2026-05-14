import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { StateNotice } from '@/components/StateNotice';
import { useSession } from '@/features/auth/useSession';
import { ApiError } from '@/lib/api-client';
import { getErrorMessage } from '@/lib/query-state';

const SESSION_BOOTSTRAP_TIMEOUT_MS = 8_000;

export function AuthGate() {
	const { t } = useTranslation();
	const location = useLocation();
	const navigate = useNavigate();
	const sessionQuery = useSession();
	const [sessionTimedOut, setSessionTimedOut] = useState(false);

	useEffect(() => {
		if (!sessionQuery.isLoading) {
			setSessionTimedOut(false);
			return;
		}
		const timeout = window.setTimeout(() => setSessionTimedOut(true), SESSION_BOOTSTRAP_TIMEOUT_MS);
		return () => window.clearTimeout(timeout);
	}, [sessionQuery.isLoading]);

	function retrySession() {
		setSessionTimedOut(false);
		void sessionQuery.refetch();
	}

	if (sessionQuery.isLoading) {
		return (
			<div className="flex min-h-screen items-center justify-center bg-canvas p-4">
				<div className="w-full max-w-sm">
					{sessionTimedOut ? (
						<StateNotice tone="error" title={t('auth.sessionCheckDelayedTitle')}>
							<p>{t('auth.sessionCheckDelayedBody')}</p>
							<div className="mt-3 flex flex-wrap gap-2">
								<button
									className="inline-flex h-8 items-center rounded-md border border-border bg-panel px-3 text-sm text-text transition-colors hover:bg-field"
									onClick={retrySession}
									type="button"
								>
									{t('common.retry')}
								</button>
								<button
									className="inline-flex h-8 items-center rounded-md border border-border bg-panel px-3 text-sm text-text transition-colors hover:bg-field"
									onClick={() => navigate('/login', { replace: true, state: { from: location } })}
									type="button"
								>
									{t('auth.goToLogin')}
								</button>
							</div>
						</StateNotice>
					) : (
						<StateNotice tone="loading" title={t('auth.checkingSession')} />
					)}
				</div>
			</div>
		);
	}

	if (sessionQuery.error && !(sessionQuery.error instanceof ApiError && sessionQuery.error.status === 401)) {
		return (
			<div className="flex min-h-screen items-center justify-center bg-canvas p-4">
				<div className="w-full max-w-sm">
					<StateNotice tone="error" title={t('auth.sessionApiUnavailable')}>
						<p>{getErrorMessage(sessionQuery.error, t('common.apiRequestFailed'))}</p>
						<div className="mt-3 flex flex-wrap gap-2">
							<button
								className="inline-flex h-8 items-center rounded-md border border-border bg-panel px-3 text-sm text-text transition-colors hover:bg-field"
								onClick={retrySession}
								type="button"
							>
								{t('common.retry')}
							</button>
							<button
								className="inline-flex h-8 items-center rounded-md border border-border bg-panel px-3 text-sm text-text transition-colors hover:bg-field"
								onClick={() => navigate('/login', { replace: true, state: { from: location } })}
								type="button"
							>
								{t('auth.goToLogin')}
							</button>
						</div>
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
