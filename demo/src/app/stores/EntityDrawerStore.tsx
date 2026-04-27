/* eslint-disable react-refresh/only-export-components */

import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

interface EntityDrawerContextValue {
  entityId: string | null;
  open: boolean;
  openEntity: (entityId: string) => void;
  close: () => void;
}

const EntityDrawerContext = createContext<EntityDrawerContextValue | null>(null);

export function EntityDrawerProvider({ children }: { children: ReactNode }) {
  const [entityId, setEntityId] = useState<string | null>(null);

  const value = useMemo<EntityDrawerContextValue>(
    () => ({
      entityId,
      open: entityId !== null,
      openEntity: (nextEntityId) => setEntityId(nextEntityId),
      close: () => setEntityId(null),
    }),
    [entityId],
  );

  return <EntityDrawerContext.Provider value={value}>{children}</EntityDrawerContext.Provider>;
}

export function useEntityDrawer() {
  const context = useContext(EntityDrawerContext);

  if (!context) {
    throw new Error('useEntityDrawer must be used within EntityDrawerProvider.');
  }

  return context;
}
