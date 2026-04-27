import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { Button } from '@/components/primitives/Button';
import { Input } from '@/components/primitives/Input';
import { useAcceptInvite } from '@/features/auth/useAcceptInvite';
import { ApiError } from '@/lib/api-client';
import { copy } from '@/lib/copy';
import { routes } from '@/lib/routes';

export function AcceptInvitePage() {
  const navigate = useNavigate();
  const { token = '' } = useParams();
  const acceptInvite = useAcceptInvite();
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (password.length < 12) {
      toast.error('Use at least 12 characters for the first password.');
      return;
    }

    if (password !== confirmPassword) {
      toast.error('The passwords do not match.');
      return;
    }

    try {
      await acceptInvite.mutateAsync({ token, password });
      navigate(routes.desk(), { replace: true });
    } catch (error) {
      if (error instanceof ApiError && error.status === 410) {
        toast.error('This invitation has expired or has already been used.');
        return;
      }

      toast.error(copy.errors.generic);
    }
  }

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-md items-center px-6">
      <div className="w-full rounded-xl border border-thread bg-surface p-8 shadow-lg">
        <p className="mb-3 font-mono text-xs uppercase tracking-[0.24em] text-amber">Mulder</p>
        <h1 className="mb-2 font-serif text-4xl text-ink">{copy.auth.inviteTitle}</h1>
        <p className="mb-6 text-sm text-ink-muted">Choose the password for this browser session.</p>
        <form className="space-y-4" onSubmit={handleSubmit}>
          <label className="block text-sm text-ink-muted">
            <span className="mb-2 block font-mono text-xs uppercase tracking-[0.18em] text-ink-subtle">Password</span>
            <Input value={password} onChange={(event) => setPassword(event.target.value)} type="password" required />
          </label>
          <label className="block text-sm text-ink-muted">
            <span className="mb-2 block font-mono text-xs uppercase tracking-[0.18em] text-ink-subtle">Confirm password</span>
            <Input value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} type="password" required />
          </label>
          <Button className="w-full" disabled={acceptInvite.isPending} type="submit">
            {acceptInvite.isPending ? 'Securing session…' : 'Enter'}
          </Button>
        </form>
      </div>
    </div>
  );
}
