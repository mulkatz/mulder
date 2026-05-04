import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { AuthFrame } from '@/components/AuthFrame';
import { StateNotice } from '@/components/StateNotice';
import { useAcceptInvitation } from '@/features/auth/useAcceptInvitation';
import { useSession } from '@/features/auth/useSession';
import { getErrorMessage } from '@/lib/query-state';

export function AcceptInvitationPage() {
	const { t } = useTranslation();
	const { token = '' } = useParams();
	const [password, setPassword] = useState('');
	const [confirmPassword, setConfirmPassword] = useState('');
	const acceptInvitation = useAcceptInvitation();
	const sessionQuery = useSession();
	const navigate = useNavigate();
	const passwordsMatch = password === confirmPassword;

	if (sessionQuery.data) {
		return <Navigate replace to="/" />;
	}

	function handleSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!token || !passwordsMatch) {
			return;
		}

		acceptInvitation.mutate(
			{ token, password },
			{
				onSuccess: () => {
					navigate('/', { replace: true });
				},
			},
		);
	}

	return (
		<AuthFrame description={t('auth.inviteDescription')} title={t('auth.inviteTitle')}>
			<form className="space-y-4" onSubmit={handleSubmit}>
				{token ? null : <StateNotice tone="error" title={t('auth.inviteMissingTitle')} />}

				<div>
					<label className="text-sm font-medium text-text" htmlFor="password">
						{t('common.password')}
					</label>
					<input
						autoComplete="new-password"
						className="field mt-2 h-10 w-full px-3 text-sm outline-none transition-colors focus:border-border-strong"
						id="password"
						minLength={12}
						onChange={(event) => setPassword(event.target.value)}
						required
						type="password"
						value={password}
					/>
				</div>

				<div>
					<label className="text-sm font-medium text-text" htmlFor="confirm-password">
						{t('common.confirmPassword')}
					</label>
					<input
						autoComplete="new-password"
						className="field mt-2 h-10 w-full px-3 text-sm outline-none transition-colors focus:border-border-strong"
						id="confirm-password"
						minLength={12}
						onChange={(event) => setConfirmPassword(event.target.value)}
						required
						type="password"
						value={confirmPassword}
					/>
				</div>

				{password && confirmPassword && !passwordsMatch ? (
					<StateNotice tone="error" title={t('auth.passwordsDoNotMatch')} />
				) : null}

				{acceptInvitation.error ? (
					<StateNotice tone="error" title={t('auth.inviteErrorTitle')}>
						{getErrorMessage(acceptInvitation.error, t('common.apiRequestFailed'))}
					</StateNotice>
				) : null}

				<button
					className="inline-flex h-10 w-full items-center justify-center rounded-md bg-accent px-4 text-sm font-medium text-text-inverse transition-colors hover:bg-accent-hover disabled:bg-field disabled:text-text-faint"
					disabled={!token || !passwordsMatch || acceptInvitation.isPending}
					type="submit"
				>
					{acceptInvitation.isPending ? t('auth.inviteSubmitting') : t('auth.inviteSubmit')}
				</button>
			</form>
		</AuthFrame>
	);
}
