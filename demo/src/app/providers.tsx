import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as Tooltip from '@radix-ui/react-tooltip';
import { useEffect, useState, type ReactNode } from 'react';
import { Toaster } from 'sonner';
import { AuditDrawerProvider, useAuditDrawer } from '@/app/stores/AuditDrawerStore';
import { CommandPaletteProvider, useCommandPalette } from '@/app/stores/CommandPaletteStore';
import { EntityDrawerProvider, useEntityDrawer } from '@/app/stores/EntityDrawerStore';
import { MentionIndexProvider } from '@/app/stores/MentionIndexStore';
import { ApiError } from '@/lib/api-client';

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        retry: (count, error) => {
          if (error instanceof ApiError && [401, 403, 404].includes(error.status)) {
            return false;
          }

          return count < 2;
        },
        refetchOnWindowFocus: false,
      },
      mutations: {
        onError: (error) => {
          if (error instanceof ApiError && error.status === 401) {
            window.dispatchEvent(new Event('auth:expired'));
          }
        },
      },
    },
  });
}

function DebugBridge() {
  const entityDrawer = useEntityDrawer();
  const auditDrawer = useAuditDrawer();
  const commandPalette = useCommandPalette();

  useEffect(() => {
    if (!import.meta.env.DEV) {
      return;
    }

    const debugApi = {
      entityDrawer,
      auditDrawer,
      commandPalette,
    };

    window.__MULDER_DEBUG__ = debugApi;

    return () => {
      delete window.__MULDER_DEBUG__;
    };
  }, [auditDrawer, commandPalette, entityDrawer]);

  return null;
}

declare global {
  interface Window {
    __MULDER_DEBUG__?: {
      entityDrawer: ReturnType<typeof useEntityDrawer>;
      auditDrawer: ReturnType<typeof useAuditDrawer>;
      commandPalette: ReturnType<typeof useCommandPalette>;
    };
  }
}

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(createQueryClient);

  return (
    <QueryClientProvider client={queryClient}>
      <Tooltip.Provider delayDuration={120}>
        <EntityDrawerProvider>
          <AuditDrawerProvider>
            <CommandPaletteProvider>
              <MentionIndexProvider>
                <DebugBridge />
                {children}
                <Toaster theme="dark" richColors position="bottom-right" />
              </MentionIndexProvider>
            </CommandPaletteProvider>
          </AuditDrawerProvider>
        </EntityDrawerProvider>
      </Tooltip.Provider>
    </QueryClientProvider>
  );
}
