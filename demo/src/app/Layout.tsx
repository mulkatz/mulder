import { Archive, BookOpenText, Command, LogOut, Moon, Search, ShieldCheck, Sun, UploadCloud, UserPlus, Workflow } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { useAuditDrawer } from '@/app/stores/AuditDrawerStore';
import { useCommandPalette } from '@/app/stores/CommandPaletteStore';
import { RouteErrorBoundary } from '@/app/RouteErrorBoundary';
import { Button } from '@/components/primitives/Button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/primitives/DropdownMenu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/primitives/Tooltip';
import { AuditDrawer } from '@/components/Audit/AuditDrawer';
import { InviteDialog } from '@/components/Auth/InviteDialog';
import { CommandPalette } from '@/components/CommandPalette/CommandPalette';
import { EntityProfileDrawer } from '@/components/Entity/EntityProfileDrawer';
import { ShortcutsDialog } from '@/components/Shortcuts/ShortcutsDialog';
import { UploadDialog } from '@/components/Upload/UploadDialog';
import { useAuth } from '@/features/auth/useAuth';
import { useLogout } from '@/features/auth/useLogout';
import { useTheme } from '@/app/theme';
import { copy } from '@/lib/copy';
import { routes } from '@/lib/routes';
import { cn } from '@/lib/cn';
import { initials } from '@/lib/format';

const navItems = [
  { to: routes.desk(), label: copy.nav.desk, icon: BookOpenText },
  { to: routes.archive(), label: copy.nav.archive, icon: Archive },
  { to: routes.board(), label: copy.nav.board, icon: Workflow },
  { to: routes.ask(), label: copy.nav.ask, icon: Search },
];

export function Layout() {
  const navigate = useNavigate();
  const auth = useAuth();
  const logout = useLogout();
  const theme = useTheme();
  const audit = useAuditDrawer();
  const palette = useCommandPalette();
  const chordRef = useRef<string | null>(null);

  useEffect(() => {
    function isTypingTarget(target: EventTarget | null) {
      if (!(target instanceof HTMLElement)) {
        return false;
      }
      const tag = target.tagName.toLowerCase();
      return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (isTypingTarget(event.target)) {
        return;
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        palette.openPalette();
        return;
      }

      if ((event.metaKey || event.ctrlKey) && event.key === '.') {
        event.preventDefault();
        audit.openAudit('summary');
        return;
      }

      if (event.key === '?') {
        event.preventDefault();
        window.dispatchEvent(new Event('mulder:open-shortcuts'));
        return;
      }

      if (event.key.toLowerCase() === 'g') {
        chordRef.current = 'g';
        window.setTimeout(() => {
          chordRef.current = null;
        }, 1_200);
        return;
      }

      if (chordRef.current === 'g') {
        const key = event.key.toLowerCase();
        chordRef.current = null;
        if (key === 'd') navigate(routes.desk());
        if (key === 'a') navigate(routes.archive());
        if (key === 'b') navigate(routes.board());
        if (key === 's') navigate(routes.ask());
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [audit, navigate, palette]);

  async function handleLogout() {
    try {
      await logout.mutateAsync();
      navigate(routes.login(), { replace: true });
    } catch {
      toast.error('Could not end the current session.');
    }
  }

  return (
    <div className="min-h-screen bg-paper text-ink">
      <header className="sticky top-0 z-40 border-b border-thread bg-paper/90 backdrop-blur-md">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-4 gap-y-3 px-6 py-4 lg:flex-nowrap lg:px-10">
          <div className="min-w-[220px] flex-1">
            <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-amber">Mulder</p>
            <h1 className="font-serif text-2xl text-ink">The truth is in the documents.</h1>
          </div>
          <nav className="order-3 flex w-full min-w-0 items-center gap-1 overflow-x-auto lg:order-none lg:ml-2 lg:w-auto lg:flex-1">
            {navItems.map((item) => {
              const Icon = item.icon;

              return (
                <NavLink
                  key={item.to}
                  data-testid={`nav-${item.label.toLowerCase().replaceAll(/\s+/g, '-')}`}
                  className={({ isActive }) =>
                    cn(
                      'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-2 text-xs transition-colors sm:gap-2 sm:px-4 sm:text-sm',
                      isActive ? 'bg-surface text-ink shadow-xs' : 'text-ink-muted hover:bg-surface hover:text-ink',
                    )
                  }
                  to={item.to}
                >
                  <Icon className="size-4" />
                  <span>{item.label}</span>
                </NavLink>
              );
            })}
          </nav>
          <div className="ml-auto flex shrink-0 items-center gap-3">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button aria-label="Open command palette" onClick={palette.openPalette} variant="ghost">
                  <Command className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Command palette</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button aria-label="Upload document" onClick={() => window.dispatchEvent(new Event('mulder:open-upload'))} variant="ghost">
                  <UploadCloud className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Upload document</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button aria-label="Open Audit drawer" onClick={() => audit.openAudit('summary')} variant="ghost">
                  <ShieldCheck className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Audit drawer</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button aria-label="Toggle theme" onClick={theme.toggleTheme} variant="ghost">
                  {theme.theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{theme.theme === 'dark' ? 'Switch to light' : 'Switch to dark'}</TooltipContent>
            </Tooltip>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="flex items-center gap-3 rounded-full border border-thread bg-surface px-3 py-2 text-left">
                  <div className="flex size-9 items-center justify-center rounded-full bg-amber-soft font-mono text-xs uppercase tracking-[0.16em] text-amber">
                    {auth.user ? initials(auth.user.email) : '??'}
                  </div>
                  <div className="hidden sm:block">
                    <p className="text-sm text-ink">{auth.user?.email}</p>
                    <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-ink-subtle">{auth.role ?? 'member'}</p>
                  </div>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                {auth.isAdmin ? (
                  <DropdownMenuItem onSelect={() => window.dispatchEvent(new Event('mulder:open-invite'))}>
                    <UserPlus className="size-4" />
                    Create invitation
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuItem onSelect={() => void handleLogout()}>
                  <LogOut className="size-4" />
                  Log out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-[1600px] px-4 pb-10 pt-6 lg:px-8">
        <RouteErrorBoundary>
          <Outlet />
        </RouteErrorBoundary>
      </main>
      <UploadDialog />
      <InviteDialog />
      <CommandPalette />
      <AuditDrawer />
      <ShortcutsDialog />
      <EntityProfileDrawer />
    </div>
  );
}
