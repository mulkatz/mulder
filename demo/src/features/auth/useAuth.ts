import { useSession } from './useSession';

export function useAuth() {
  const session = useSession();
  const user = session.data?.data.user ?? null;
  const role = user?.role ?? null;

  return {
    ...session,
    user,
    role,
    isAdmin: role === 'owner' || role === 'admin',
  };
}
