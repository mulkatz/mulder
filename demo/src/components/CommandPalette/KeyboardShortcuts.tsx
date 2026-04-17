import { useState } from 'react';
import { BookOpenText, Command, FolderSearch, Moon, Search, ShieldQuestion, Workflow } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuditDrawer } from '@/app/stores/AuditDrawerStore';
import { useCommandPalette } from '@/app/stores/CommandPaletteStore';
import { Button } from '@/components/primitives/Button';
import { Dialog, DialogContent } from '@/components/primitives/Dialog';
import { copy } from '@/lib/copy';
import { routes } from '@/lib/routes';
import { useShortcut, focusSearchInput } from '@/lib/shortcuts';

type ShortcutRow = {
  label: string;
  keys: string;
  icon: typeof Command;
};

export function KeyboardShortcuts() {
  const navigate = useNavigate();
  const palette = useCommandPalette();
  const audit = useAuditDrawer();
  const [helpOpen, setHelpOpen] = useState(false);

  useShortcut('mod+k', (event) => {
    event.preventDefault();
    if (palette.open) {
      palette.close();
      return;
    }

    palette.openPalette();
  });

  useShortcut('mod+.', () => {
    if (audit.open) {
      audit.close();
      return;
    }

    audit.openAudit('summary');
  });

  useShortcut('g d', () => {
    navigate(routes.desk());
  });

  useShortcut('g a', () => {
    navigate(routes.archive());
  });

  useShortcut('g b', () => {
    navigate(routes.board());
  });

  useShortcut('g s', () => {
    navigate(routes.ask());
  });

  useShortcut('/', () => {
    focusSearchInput();
  });

  useShortcut('?', () => {
    setHelpOpen(true);
  });

  useShortcut('esc', () => {
    if (helpOpen) {
      setHelpOpen(false);
    }
  });

  const shortcuts: ShortcutRow[] = [
    { label: 'Open command palette', keys: '⌘K / Ctrl+K', icon: Command },
    { label: 'Toggle audit drawer', keys: '⌘. / Ctrl+.', icon: ShieldQuestion },
    { label: 'Go to Ask', keys: 'G S', icon: Search },
    { label: 'Go to Desk', keys: 'G D', icon: BookOpenText },
    { label: 'Go to Archive', keys: 'G A', icon: FolderSearch },
    { label: 'Go to Board', keys: 'G B', icon: Workflow },
    { label: 'Toggle theme', keys: 'palette action', icon: Moon },
  ];

  return (
    <Dialog onOpenChange={setHelpOpen} open={helpOpen}>
      <DialogContent className="w-[min(92vw,34rem)]" hideClose>
        <div className="space-y-5">
          <div>
            <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-amber">{copy.shortcuts.title}</p>
            <h2 className="mt-2 font-serif text-3xl text-ink">{copy.shortcuts.body}</h2>
          </div>

          <div className="space-y-2">
            {shortcuts.map((shortcut) => {
              const Icon = shortcut.icon;

              return (
                <div
                  className="flex items-center justify-between gap-4 rounded-xl border border-thread bg-surface px-4 py-3"
                  key={shortcut.label}
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <Icon className="size-4 shrink-0 text-amber" />
                    <span className="text-sm text-ink">{shortcut.label}</span>
                  </div>
                  <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-ink-subtle">{shortcut.keys}</span>
                </div>
              );
            })}
          </div>

          <div className="flex items-center justify-end">
            <Button onClick={() => setHelpOpen(false)} variant="secondary">
              {copy.shortcuts.close}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
