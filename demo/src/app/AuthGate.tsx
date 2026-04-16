import { useEffect, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { LoginCard } from '@/pages/auth/Login';
import { useSession } from '@/features/auth/useSession';
import { ApiError } from '@/lib/api-client';
import { Skeleton } from '@/components/shared/Skeleton';

export function AuthGate({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const session = useSession();
  const [expired, setExpired] = useState(false);
  const previewMode = import.meta.env.DEV && session.error instanceof ApiError && session.error.status === 404;

  useEffect(() => {
    function handleExpired() {
      queryClient.removeQueries({ queryKey: ['auth'] });
      setExpired(true);
    }

    function handleStorage(event: StorageEvent) {
      if (event.key === 'mulder-auth-sync') {
        handleExpired();
      }
    }

    window.addEventListener('auth:expired', handleExpired);
    window.addEventListener('storage', handleStorage);

    return () => {
      window.removeEventListener('auth:expired', handleExpired);
      window.removeEventListener('storage', handleStorage);
    };
  }, [queryClient]);

  if (session.isLoading) {
    return (
      <div className="mx-auto flex min-h-screen w-full max-w-md items-center px-6">
        <div className="w-full rounded-xl border border-thread bg-surface p-8 shadow-lg">
          <Skeleton className="mb-4 h-8 w-40" />
          <Skeleton className="mb-3 h-4 w-full" />
          <Skeleton className="mb-6 h-4 w-5/6" />
          <Skeleton className="mb-3 h-11 w-full" />
          <Skeleton className="mb-3 h-11 w-full" />
          <Skeleton className="h-11 w-full" />
        </div>
      </div>
    );
  }

  if (session.error instanceof ApiError && session.error.status === 401) {
    return <LoginCard expired={expired} />;
  }

  if (previewMode) {
    return <>{children}</>;
  }

  if (!session.data) {
    return <LoginCard expired={expired} />;
  }

  return <>{children}</>;
}
