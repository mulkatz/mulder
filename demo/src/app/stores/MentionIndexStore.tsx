/* eslint-disable react-refresh/only-export-components */

import { createContext, useCallback, useContext, useMemo, useRef, type ReactNode } from 'react';
import { clearHighlights, highlightTerms } from '@/lib/mention-index';

interface MentionRootRegistration {
  key: string;
  element: HTMLElement;
}

interface MentionIndexContextValue {
  registerRoot: (key: string, element: HTMLElement) => () => void;
  highlight: (entityId: string, terms: string[]) => () => void;
  clear: () => void;
  activeEntityId: string | null;
}

const MentionIndexContext = createContext<MentionIndexContextValue | null>(null);

export function MentionIndexProvider({ children }: { children: ReactNode }) {
  const rootsRef = useRef<Map<string, MentionRootRegistration>>(new Map());
  const marksRef = useRef<HTMLElement[]>([]);
  const activeEntityIdRef = useRef<string | null>(null);

  const clear = useCallback(() => {
    clearHighlights(marksRef.current);
    marksRef.current = [];
    activeEntityIdRef.current = null;
  }, []);

  const registerRoot = useCallback((key: string, element: HTMLElement) => {
    rootsRef.current.set(key, { key, element });

    return () => {
      rootsRef.current.delete(key);
    };
  }, []);

  const highlight = useCallback(
    (entityId: string, terms: string[]) => {
      clear();
      activeEntityIdRef.current = entityId;

      for (const registration of rootsRef.current.values()) {
        marksRef.current.push(...highlightTerms(registration.element, terms));
      }

      return () => {
        if (activeEntityIdRef.current === entityId) {
          clear();
        }
      };
    },
    [clear],
  );

  const value = useMemo<MentionIndexContextValue>(
    () => ({
      registerRoot,
      highlight,
      clear,
      get activeEntityId() {
        return activeEntityIdRef.current;
      },
    }),
    [clear, highlight, registerRoot],
  );

  return <MentionIndexContext.Provider value={value}>{children}</MentionIndexContext.Provider>;
}

export function useMentionIndex() {
  const context = useContext(MentionIndexContext);

  if (!context) {
    throw new Error('useMentionIndex must be used within MentionIndexProvider.');
  }

  return context;
}
