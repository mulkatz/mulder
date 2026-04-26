import { type FormEvent, useEffect, useState } from 'react';

const apiBase = import.meta.env.VITE_MULDER_API_BASE_URL ?? '';

interface AuthUser {
  id: string;
  email: string;
  role: 'owner' | 'admin' | 'member';
}

interface SessionResponse {
  data: {
    user: AuthUser;
    expires_at: string;
  };
}

function apiUrl(path: string): string {
  return path.startsWith('http') ? path : `${apiBase}${path}`;
}

async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    return body.error?.message ?? `Request failed (${response.status})`;
  } catch {
    return `Request failed (${response.status})`;
  }
}

export default function AuthGate({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<'login' | 'invite'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [inviteToken, setInviteToken] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(apiUrl('/api/auth/session'), {
      credentials: 'include',
    })
      .then(async (response) => {
        if (!response.ok) return null;
        return ((await response.json()) as SessionResponse).data.user;
      })
      .then((nextUser) => {
        if (!cancelled) {
          setUser(nextUser);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setUser(null);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);

    const response = await fetch(apiUrl(mode === 'login' ? '/api/auth/login' : '/api/auth/invitations/accept'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(mode === 'login' ? { email, password } : { token: inviteToken, password }),
    });

    if (!response.ok) {
      setError(await readError(response));
      return;
    }

    const body = (await response.json()) as SessionResponse;
    setUser(body.data.user);
    setPassword('');
    setInviteToken('');
  };

  const logout = async () => {
    await fetch(apiUrl('/api/auth/logout'), {
      method: 'POST',
      credentials: 'include',
    });
    setUser(null);
  };

  if (loading) {
    return <div className="flex min-h-screen items-center justify-center bg-background text-sm text-muted-foreground">Checking session...</div>;
  }

  if (user) {
    return (
      <>
        <div className="fixed bottom-4 right-4 z-[60] rounded-[var(--radius)] border bg-card px-3 py-2 text-xs shadow-lg">
          <span className="mr-3 text-muted-foreground">{user.email}</span>
          <button onClick={logout} className="font-medium text-primary hover:underline">
            Log out
          </button>
        </div>
        {children}
      </>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4">
      <form onSubmit={submit} className="w-full max-w-md rounded-2xl border bg-card p-8 shadow-xl">
        <p className="font-mono text-xs uppercase tracking-[0.25em] text-primary">mulder</p>
        <h1 className="mt-3 text-3xl font-semibold text-foreground">
          {mode === 'login' ? 'Sign in to the archive' : 'Accept your invitation'}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Browser access uses an HTTP-only session cookie. No API key is shipped to this app.
        </p>

        {mode === 'login' ? (
          <label className="mt-6 block text-sm font-medium text-foreground">
            Email
            <input
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              type="email"
              required
              className="mt-2 w-full rounded-[var(--radius)] border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
            />
          </label>
        ) : (
          <label className="mt-6 block text-sm font-medium text-foreground">
            Invitation token
            <input
              value={inviteToken}
              onChange={(event) => setInviteToken(event.target.value)}
              required
              className="mt-2 w-full rounded-[var(--radius)] border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
            />
          </label>
        )}

        <label className="mt-4 block text-sm font-medium text-foreground">
          Password
          <input
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            type="password"
            required
            minLength={mode === 'invite' ? 12 : 1}
            className="mt-2 w-full rounded-[var(--radius)] border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
          />
        </label>

        {error ? <p className="mt-4 rounded-[var(--radius)] border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{error}</p> : null}

        <button type="submit" className="mt-6 w-full rounded-[var(--radius)] bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground">
          {mode === 'login' ? 'Sign in' : 'Create account'}
        </button>

        <button
          type="button"
          onClick={() => {
            setMode(mode === 'login' ? 'invite' : 'login');
            setError(null);
          }}
          className="mt-4 w-full text-sm text-muted-foreground hover:text-foreground"
        >
          {mode === 'login' ? 'I have an invitation token' : 'Back to sign in'}
        </button>
      </form>
    </main>
  );
}
