import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { SessionResponse } from '@/lib/api-types';

export const sessionQueryKey = ['auth', 'session'] as const;

const PREVIEW_SESSION: SessionResponse = {
  user: {
    id: 'preview-user',
    email: 'preview@mulder.local',
    role: 'owner',
  },
  expires_at: '2099-01-01T00:00:00.000Z',
};

function shouldBypassAuthSession() {
  if (!import.meta.env.DEV) {
    return false;
  }

  return import.meta.env.VITE_PREVIEW_AUTH_BYPASS !== 'false';
}

export function useSession() {
  const bypassAuthSession = shouldBypassAuthSession();

  return useQuery({
    queryKey: sessionQueryKey,
    queryFn: () =>
      bypassAuthSession ? Promise.resolve(PREVIEW_SESSION) : apiFetch<SessionResponse>('/api/auth/session'),
    retry: false,
    staleTime: bypassAuthSession ? Number.POSITIVE_INFINITY : 0,
  });
}
