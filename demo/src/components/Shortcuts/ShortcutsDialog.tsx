import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogTitle } from '@/components/primitives/Dialog';

const shortcuts = [
  ['Cmd/Ctrl K', 'Open command palette'],
  ['Cmd/Ctrl .', 'Open Audit drawer'],
  ['?', 'Show this shortcut sheet'],
  ['G then D', 'Go to Desk'],
  ['G then A', 'Go to Archive'],
  ['G then B', 'Go to Board'],
  ['G then S', 'Go to Ask'],
  ['Escape', 'Close drawers and reading mode'],
];

export function ShortcutsDialog() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function handleOpen() {
      setOpen(true);
    }

    window.addEventListener('mulder:open-shortcuts', handleOpen);
    return () => window.removeEventListener('mulder:open-shortcuts', handleOpen);
  }, []);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent aria-describedby={undefined}>
        <div>
          <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-amber">Shortcuts</p>
          <DialogTitle className="mt-2 font-serif text-3xl text-ink">Move through the archive quickly.</DialogTitle>
        </div>
        <div className="mt-5 divide-y divide-thread rounded-xl border border-thread bg-surface">
          {shortcuts.map(([keys, description]) => (
            <div key={keys} className="flex items-center justify-between gap-4 px-4 py-3">
              <kbd className="rounded bg-raised px-2 py-1 font-mono text-xs text-ink">{keys}</kbd>
              <span className="text-sm text-ink-muted">{description}</span>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
