import { Command } from 'cmdk';
import { FileText, LogOut, Moon, Search, ShieldCheck, UploadCloud, Workflow } from 'lucide-react';
import type React from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { useAuditDrawer } from '@/app/stores/AuditDrawerStore';
import { useCommandPalette } from '@/app/stores/CommandPaletteStore';
import { useEntityDrawer } from '@/app/stores/EntityDrawerStore';
import { useTheme } from '@/app/theme';
import { Dialog, DialogContent, DialogTitle } from '@/components/primitives/Dialog';
import { VisuallyHidden } from '@/components/primitives/VisuallyHidden';
import { useLogout } from '@/features/auth/useLogout';
import { useDocuments } from '@/features/documents/useDocuments';
import { useEntities } from '@/features/entities/useEntities';
import { routes } from '@/lib/routes';

export function CommandPalette() {
  const palette = useCommandPalette();
  const audit = useAuditDrawer();
  const entityDrawer = useEntityDrawer();
  const navigate = useNavigate();
  const logout = useLogout();
  const theme = useTheme();
  const documents = useDocuments({ limit: 20, enabled: palette.open });
  const entities = useEntities({ limit: 50, enabled: palette.open });

  function closeAfter(action: () => void | Promise<void>) {
    return async () => {
      await action();
      palette.close();
    };
  }

  return (
    <Dialog open={palette.open} onOpenChange={(open) => (open ? palette.openPalette() : palette.close())}>
      <DialogContent aria-describedby={undefined} className="overflow-hidden p-0" hideClose>
        <VisuallyHidden>
          <DialogTitle>Command palette</DialogTitle>
        </VisuallyHidden>
        <Command className="bg-raised text-ink" label="Command palette">
          <Command.Input
            className="w-full border-b border-thread bg-transparent px-5 py-4 text-lg outline-none placeholder:text-ink-faint"
            placeholder="Search documents, entities, and actions..."
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                palette.close();
              }
            }}
          />
          <Command.List className="max-h-[26rem] overflow-y-auto p-2">
            <Command.Empty className="px-3 py-8 text-center text-sm text-ink-muted">No command found.</Command.Empty>

            <Command.Group className="p-1" heading={<Heading>Navigation</Heading>}>
              <Item icon={<FileText />} label="Desk" onSelect={closeAfter(() => navigate(routes.desk()))} />
              <Item icon={<FileText />} label="Archive" onSelect={closeAfter(() => navigate(routes.archive()))} />
              <Item icon={<Workflow />} label="Board" onSelect={closeAfter(() => navigate(routes.board()))} />
              <Item icon={<Search />} label="Ask" onSelect={closeAfter(() => navigate(routes.ask()))} />
            </Command.Group>

            <Command.Group className="p-1" heading={<Heading>Actions</Heading>}>
              <Item
                icon={<UploadCloud />}
                label="Upload document"
                onSelect={closeAfter(() => {
                  navigate(routes.archive());
                  window.dispatchEvent(new Event('mulder:open-upload'));
                })}
              />
              <Item icon={<ShieldCheck />} label="Open Audit drawer" onSelect={closeAfter(() => audit.openAudit('summary'))} />
              <Item icon={<Moon />} label="Toggle theme" onSelect={closeAfter(theme.toggleTheme)} />
              <Item
                icon={<LogOut />}
                label="Log out"
                onSelect={closeAfter(async () => {
                  await logout.mutateAsync();
                  navigate(routes.login(), { replace: true });
                  toast.success('Signed out.');
                })}
              />
            </Command.Group>

            <Command.Group className="p-1" heading={<Heading>Documents</Heading>}>
              {(documents.data?.data ?? []).map((document) => (
                <Item
                  key={document.id}
                  icon={<FileText />}
                  label={document.filename}
                  onSelect={closeAfter(() => navigate(routes.caseFile(document.id)))}
                />
              ))}
            </Command.Group>

            <Command.Group className="p-1" heading={<Heading>Entities</Heading>}>
              {(entities.data?.data ?? []).map((entity) => (
                <Item
                  key={entity.id}
                  icon={<Workflow />}
                  label={entity.name}
                  onSelect={closeAfter(() => {
                    navigate(routes.board());
                    entityDrawer.openEntity(entity.id);
                  })}
                />
              ))}
            </Command.Group>
          </Command.List>
        </Command>
      </DialogContent>
    </Dialog>
  );
}

function Heading({ children }: { children: React.ReactNode }) {
  return <div className="px-2 py-1.5 font-mono text-[11px] uppercase tracking-[0.18em] text-ink-subtle">{children}</div>;
}

function Item({
  icon,
  label,
  onSelect,
}: {
  icon: React.ReactElement<{ className?: string }>;
  label: string;
  onSelect: () => void;
}) {
  return (
    <Command.Item
      className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-sm text-ink outline-none data-[selected=true]:bg-amber-faint"
      data-testid={`command-item-${label.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-')}`}
      value={label}
      onSelect={onSelect}
    >
      {icon}
      <span>{label}</span>
    </Command.Item>
  );
}
