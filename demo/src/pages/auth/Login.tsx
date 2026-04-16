import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Button } from '@/components/primitives/Button';
import { Input } from '@/components/primitives/Input';
import { useLogin } from '@/features/auth/useLogin';
import { useSession } from '@/features/auth/useSession';
import { ApiError } from '@/lib/api-client';
import { copy } from '@/lib/copy';
import { routes } from '@/lib/routes';

export function LoginCard({ expired = false }: { expired?: boolean }) {
  const navigate = useNavigate();
  const login = useLogin();
  const session = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    try {
      await login.mutateAsync({ email, password });
      await session.refetch();
      navigate(routes.desk(), { replace: true });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        toast.error(copy.auth.loginFailure);
        return;
      }

      toast.error(copy.errors.generic);
    }
  }

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-md items-center px-6">
      <div className="w-full rounded-xl border border-thread bg-surface p-8 shadow-lg">
        <p className="mb-3 font-mono text-xs uppercase tracking-[0.24em] text-amber">Mulder</p>
        <h1 className="mb-2 font-serif text-4xl text-ink">{copy.auth.loginTitle}</h1>
        <p className="mb-6 text-sm text-ink-muted">
          {expired ? copy.auth.sessionExpired : copy.auth.loginBody}
        </p>
        <form className="space-y-4" onSubmit={handleSubmit}>
          <label className="block text-sm text-ink-muted">
            <span className="mb-2 block font-mono text-xs uppercase tracking-[0.18em] text-ink-subtle">Email</span>
            <Input value={email} onChange={(event) => setEmail(event.target.value)} type="email" required />
          </label>
          <label className="block text-sm text-ink-muted">
            <span className="mb-2 block font-mono text-xs uppercase tracking-[0.18em] text-ink-subtle">Password</span>
            <Input value={password} onChange={(event) => setPassword(event.target.value)} type="password" required />
          </label>
          <Button className="w-full" disabled={login.isPending} type="submit">
            {login.isPending ? 'Opening archive…' : 'Enter'}
          </Button>
        </form>
        <p className="mt-4 text-sm text-ink-subtle">{copy.auth.forgotPassword}</p>
      </div>
    </div>
  );
}

export function LoginPage() {
  return <LoginCard />;
}
