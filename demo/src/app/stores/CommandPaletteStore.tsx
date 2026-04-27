/* eslint-disable react-refresh/only-export-components */

import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

interface CommandPaletteContextValue {
  open: boolean;
  openPalette: () => void;
  close: () => void;
}

const CommandPaletteContext = createContext<CommandPaletteContextValue | null>(null);

export function CommandPaletteProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);

  const value = useMemo<CommandPaletteContextValue>(
    () => ({
      open,
      openPalette: () => setOpen(true),
      close: () => setOpen(false),
    }),
    [open],
  );

  return <CommandPaletteContext.Provider value={value}>{children}</CommandPaletteContext.Provider>;
}

export function useCommandPalette() {
  const context = useContext(CommandPaletteContext);

  if (!context) {
    throw new Error('useCommandPalette must be used within CommandPaletteProvider.');
  }

  return context;
}
