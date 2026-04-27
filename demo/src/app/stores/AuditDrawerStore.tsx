/* eslint-disable react-refresh/only-export-components */

import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

interface AuditDrawerContextValue {
  open: boolean;
  tab: string | null;
  openAudit: (tab?: string) => void;
  close: () => void;
}

const AuditDrawerContext = createContext<AuditDrawerContextValue | null>(null);

export function AuditDrawerProvider({ children }: { children: ReactNode }) {
  const [tab, setTab] = useState<string | null>(null);

  const value = useMemo<AuditDrawerContextValue>(
    () => ({
      open: tab !== null,
      tab,
      openAudit: (nextTab) => setTab(nextTab ?? 'summary'),
      close: () => setTab(null),
    }),
    [tab],
  );

  return <AuditDrawerContext.Provider value={value}>{children}</AuditDrawerContext.Provider>;
}

export function useAuditDrawer() {
  const context = useContext(AuditDrawerContext);

  if (!context) {
    throw new Error('useAuditDrawer must be used within AuditDrawerProvider.');
  }

  return context;
}
