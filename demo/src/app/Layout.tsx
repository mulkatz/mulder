import { Archive, BookOpenText, LogOut, Moon, Search, Sun, Workflow } from 'lucide-react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Button } from '@/components/primitives/Button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/primitives/Tooltip';
import { EntityProfileDrawer } from '@/components/Entity/EntityProfileDrawer';
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
        <div className="mx-auto flex max-w-[1600px] items-center gap-6 px-6 py-4 lg:px-10">
          <div className="min-w-0">
            <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-amber">Mulder</p>
            <h1 className="font-serif text-2xl text-ink">The truth is in the documents.</h1>
          </div>
          <nav className="ml-4 flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
            {navItems.map((item) => {
              const Icon = item.icon;

              return (
                <NavLink
                  key={item.to}
                  className={({ isActive }) =>
                    cn(
                      'inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm transition-colors',
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
          <div className="flex items-center gap-3">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button aria-label="Toggle theme" onClick={theme.toggleTheme} variant="ghost">
                  {theme.theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{theme.theme === 'dark' ? 'Switch to light' : 'Switch to dark'}</TooltipContent>
            </Tooltip>
            <div className="flex items-center gap-3 rounded-full border border-thread bg-surface px-3 py-2">
              <div className="flex size-9 items-center justify-center rounded-full bg-amber-soft font-mono text-xs uppercase tracking-[0.16em] text-amber">
                {auth.user ? initials(auth.user.email) : '??'}
              </div>
              <div className="hidden sm:block">
                <p className="text-sm text-ink">{auth.user?.email}</p>
                <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-ink-subtle">{auth.role ?? 'member'}</p>
              </div>
              <Button aria-label="Log out" className="rounded-full px-3 py-2" onClick={handleLogout} variant="ghost">
                <LogOut className="size-4" />
              </Button>
            </div>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-[1600px] px-4 pb-10 pt-6 lg:px-8">
        <Outlet />
      </main>
      <EntityProfileDrawer />
    </div>
  );
}
