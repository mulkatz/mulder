import { type FormEvent, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { AuthFrame } from '@/components/AuthFrame';
import { StateNotice } from '@/components/StateNotice';
import { useLogin } from '@/features/auth/useLogin';
import { useSession } from '@/features/auth/useSession';
import { getErrorMessage } from '@/lib/query-state';

interface LocationState {
	from?: { pathname?: string };
}

export function LoginPage() {
	const [email, setEmail] = useState('');
	const [password, setPassword] = useState('');
	const login = useLogin();
	const sessionQuery = useSession();
	const navigate = useNavigate();
	const location = useLocation();
	const state = location.state as LocationState | null;
	const redirectTo = state?.from?.pathname && state.from.pathname !== '/login' ? state.from.pathname : '/';

	if (sessionQuery.data) {
		return <Navigate replace to={redirectTo} />;
	}

	function handleSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		login.mutate(
			{ email, password },
			{
				onSuccess: () => {
					navigate(redirectTo, { replace: true });
				},
			},
		);
	}

	return (
		<AuthFrame
			description="Use your Mulder account to access documents, evidence, jobs, and research workflows."
			title="Sign in to Mulder"
		>
			<form className="space-y-4" onSubmit={handleSubmit}>
				<div>
					<label className="text-sm font-medium text-text" htmlFor="email">
						Email
					</label>
					<input
						autoComplete="email"
						className="field mt-2 h-10 w-full px-3 text-sm outline-none transition-colors focus:border-border-strong"
						id="email"
						onChange={(event) => setEmail(event.target.value)}
						required
						type="email"
						value={email}
					/>
				</div>

				<div>
					<label className="text-sm font-medium text-text" htmlFor="password">
						Password
					</label>
					<input
						autoComplete="current-password"
						className="field mt-2 h-10 w-full px-3 text-sm outline-none transition-colors focus:border-border-strong"
						id="password"
						onChange={(event) => setPassword(event.target.value)}
						required
						type="password"
						value={password}
					/>
				</div>

				{login.error ? (
					<StateNotice tone="error" title="Could not sign in">
						{getErrorMessage(login.error)}
					</StateNotice>
				) : null}

				<button
					className="inline-flex h-10 w-full items-center justify-center rounded-md bg-accent px-4 text-sm font-medium text-text-inverse transition-colors hover:bg-accent-hover disabled:bg-field disabled:text-text-faint"
					disabled={login.isPending}
					type="submit"
				>
					{login.isPending ? 'Signing in...' : 'Sign in'}
				</button>
			</form>
		</AuthFrame>
	);
}
