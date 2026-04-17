import { useEffect, useMemo, useState } from 'react';
import { Command as CommandPrimitive } from 'cmdk';
import { Archive, BookOpenText, FileText, LogOut, Moon, Search, Sun, UploadCloud, Workflow } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { useCommandPalette } from '@/app/stores/CommandPaletteStore';
import { useEntityDrawer } from '@/app/stores/EntityDrawerStore';
import { useTheme } from '@/app/theme';
import { useDocuments } from '@/features/documents/useDocuments';
import { useEntities } from '@/features/entities/useEntities';
import { useLogout } from '@/features/auth/useLogout';
import { Dialog, DialogContent } from '@/components/primitives/Dialog';
import { cn } from '@/lib/cn';
import { copy } from '@/lib/copy';
import { routes } from '@/lib/routes';

function useDebouncedValue(value: string, delayMs: number) {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedValue(value), delayMs);
    return () => window.clearTimeout(timeout);
  }, [delayMs, value]);

  return debouncedValue;
}

function ShortcutKey({ children }: { children: string }) {
  return <kbd className="rounded border border-thread bg-surface px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.16em] text-ink-subtle">{children}</kbd>;
}

export function CommandPalette() {
  const navigate = useNavigate();
  const entityDrawer = useEntityDrawer();
  const theme = useTheme();
  const logout = useLogout();
  const palette = useCommandPalette();
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebouncedValue(query.trim(), 160);

  const documents = useDocuments({
    search: debouncedQuery.length > 0 ? debouncedQuery : undefined,
    limit: 8,
    enabled: debouncedQuery.length > 0,
  });
  const entities = useEntities({
    search: debouncedQuery.length > 0 ? debouncedQuery : undefined,
    limit: 8,
    enabled: debouncedQuery.length > 0,
  });

  const documentItems = useMemo(() => documents.data?.data ?? [], [documents.data?.data]);
  const entityItems = useMemo(() => entities.data?.data ?? [], [entities.data?.data]);

  function closePalette() {
    palette.close();
    setQuery('');
  }

  async function handleLogout() {
    try {
      await logout.mutateAsync();
      closePalette();
      navigate(routes.login(), { replace: true });
    } catch {
      toast.error('Could not end the current session.');
    }
  }

  return (
    <Dialog
      onOpenChange={(open) => {
        if (open) {
          palette.openPalette();
        } else {
          closePalette();
        }
      }}
      open={palette.open}
    >
      <DialogContent className="w-[min(92vw,48rem)] overflow-hidden p-0" hideClose>
        <CommandPrimitive
          className="bg-raised text-ink"
          filter={(value, search, keywords) => {
            const tokens = [value, ...(keywords ?? [])].join(' ').toLowerCase();
            return tokens.includes(search.toLowerCase()) ? 1 : 0;
          }}
          shouldFilter={false}
        >
          <div className="flex items-center gap-3 border-b border-thread px-4 py-3">
            <Search className="size-4 text-ink-subtle" />
            <CommandPrimitive.Input
              autoFocus
              className="h-10 flex-1 bg-transparent text-sm text-ink placeholder:text-ink-faint focus:outline-none"
              onValueChange={setQuery}
              placeholder={copy.commandPalette.placeholder}
              value={query}
            />
            <ShortcutKey>Esc</ShortcutKey>
          </div>

          <CommandPrimitive.List className="max-h-[min(64vh,38rem)] overflow-y-auto px-2 py-2">
            <CommandPrimitive.Empty className="px-3 py-8 text-center text-sm text-ink-muted">
              {copy.commandPalette.empty}
            </CommandPrimitive.Empty>
            {debouncedQuery.length > 0 ? (
              <>
                <CommandPrimitive.Group heading={copy.commandPalette.groups.documents}>
                  {documentItems.map((document) => (
                    <CommandPrimitive.Item
                      className={cn(
                        'flex cursor-pointer items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-sm outline-none',
                        'aria-selected:bg-amber-faint aria-selected:text-ink',
                      )}
                      key={document.id}
                      keywords={[document.filename, document.id]}
                      onSelect={() => {
                        closePalette();
                        navigate(routes.caseFile(document.id));
                      }}
                      value={document.filename}
                    >
                      <div className="flex min-w-0 items-center gap-3">
                        <FileText className="size-4 shrink-0 text-cobalt" />
                        <span className="truncate">{document.filename}</span>
                      </div>
                      <ShortcutKey>↵</ShortcutKey>
                    </CommandPrimitive.Item>
                  ))}
                </CommandPrimitive.Group>

                <CommandPrimitive.Group heading={copy.commandPalette.groups.entities}>
                  {entityItems.map((entity) => (
                    <CommandPrimitive.Item
                      className={cn(
                        'flex cursor-pointer items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-sm outline-none',
                        'aria-selected:bg-amber-faint aria-selected:text-ink',
                      )}
                      key={entity.id}
                      keywords={[entity.name, entity.type, entity.canonical_id ?? '']}
                      onSelect={() => {
                        closePalette();
                        entityDrawer.openEntity(entity.id);
                      }}
                      value={entity.name}
                    >
                      <div className="flex min-w-0 items-center gap-3">
                        <Workflow className="size-4 shrink-0 text-sage" />
                        <span className="truncate">{entity.name}</span>
                      </div>
                      <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink-subtle">{entity.type}</span>
                    </CommandPrimitive.Item>
                  ))}
                </CommandPrimitive.Group>
              </>
            ) : null}

            <CommandPrimitive.Group heading={copy.commandPalette.groups.goTo}>
              {[
                { label: 'Go to Desk', icon: BookOpenText, shortcut: 'G D', onSelect: () => navigate(routes.desk()) },
                { label: 'Go to Archive', icon: Archive, shortcut: 'G A', onSelect: () => navigate(routes.archive()) },
                { label: 'Go to Board', icon: Workflow, shortcut: 'G B', onSelect: () => navigate(routes.board()) },
                { label: 'Go to Ask', icon: Search, shortcut: 'G S', onSelect: () => navigate(routes.ask()) },
              ].map((item) => (
                <CommandPrimitive.Item
                  className={cn(
                    'flex cursor-pointer items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-sm outline-none',
                    'aria-selected:bg-amber-faint aria-selected:text-ink',
                  )}
                  key={item.label}
                  onSelect={() => {
                    closePalette();
                    item.onSelect();
                  }}
                  value={item.label}
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <item.icon className="size-4 shrink-0 text-amber" />
                    <span>{item.label}</span>
                  </div>
                  <ShortcutKey>{item.shortcut}</ShortcutKey>
                </CommandPrimitive.Item>
              ))}
            </CommandPrimitive.Group>

            <CommandPrimitive.Group heading={copy.commandPalette.groups.actions}>
              {[
                {
                  label: 'Upload document',
                  icon: UploadCloud,
                  shortcut: '↵',
                  onSelect: () => navigate(routes.archive(), { state: { openUpload: true } }),
                },
                {
                  label: theme.theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme',
                  icon: theme.theme === 'dark' ? Sun : Moon,
                  shortcut: '↵',
                  onSelect: () => theme.toggleTheme(),
                },
                {
                  label: 'Log out',
                  icon: LogOut,
                  shortcut: '↵',
                  onSelect: () => void handleLogout(),
                },
              ].map((item) => (
                <CommandPrimitive.Item
                  className={cn(
                    'flex cursor-pointer items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-sm outline-none',
                    'aria-selected:bg-amber-faint aria-selected:text-ink',
                  )}
                  key={item.label}
                  onSelect={() => {
                    closePalette();
                    item.onSelect();
                  }}
                  value={item.label}
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <item.icon className="size-4 shrink-0 text-carmine" />
                    <span>{item.label}</span>
                  </div>
                  <ShortcutKey>{item.shortcut}</ShortcutKey>
                </CommandPrimitive.Item>
              ))}
            </CommandPrimitive.Group>
          </CommandPrimitive.List>
        </CommandPrimitive>
      </DialogContent>
    </Dialog>
  );
}
