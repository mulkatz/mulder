import { useSession } from './useSession';

export function useAuth() {
  const session = useSession();
  const role = session.data?.user.role;

  return {
    ...session,
    user: session.data?.user ?? null,
    role: role ?? null,
    isAdmin: role === 'owner' || role === 'admin',
  };
}
