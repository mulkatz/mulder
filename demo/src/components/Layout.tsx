import { Link, useLocation } from 'react-router-dom';
import { LayoutDashboard, FileText, BookOpen, GitBranch, Shield, Kanban, Search, Moon, Sun, Command, Settings } from 'lucide-react';
import { useState, useEffect } from 'react';

const navItems = [
  { path: '/', label: 'Dashboard', icon: LayoutDashboard },
  { path: '/sources', label: 'Sources', icon: FileText },
  { path: '/stories', label: 'Stories', icon: BookOpen },
  { path: '/graph', label: 'Graph', icon: GitBranch },
  { path: '/evidence', label: 'Evidence', icon: Shield },
  { path: '/boards/1', label: 'Boards', icon: Kanban },
];

export default function Layout({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const [dark, setDark] = useState(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('mulder-dark') === 'true';
    }
    return false;
  });

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    localStorage.setItem('mulder-dark', String(dark));
  }, [dark]);

  const isActive = (path: string) => {
    if (path === '/') return location.pathname === '/';
    return location.pathname.startsWith(path.split('/').slice(0, 2).join('/'));
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Top Navigation */}
      <nav className="sticky top-0 z-50 border-b bg-card/95 backdrop-blur-sm">
        <div className="mx-auto flex h-12 max-w-full items-center px-4">
          {/* Logo */}
          <Link to="/" className="mr-8 flex items-center gap-2 no-underline">
            <div className="flex h-7 w-7 items-center justify-center rounded-[var(--radius)] border bg-primary text-primary-foreground">
              <span className="font-mono text-xs font-bold">M</span>
            </div>
            <span className="font-mono text-sm font-semibold tracking-tight text-foreground">mulder</span>
          </Link>

          {/* Nav Items */}
          <div className="flex items-center gap-0.5">
            {navItems.map(({ path, label, icon: Icon }) => (
              <Link
                key={path}
                to={path}
                className={`flex items-center gap-1.5 rounded-[var(--radius)] px-3 py-1.5 text-xs font-medium no-underline transition-colors ${
                  isActive(path)
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
                }`}
              >
                <Icon size={14} />
                {label}
              </Link>
            ))}
          </div>

          {/* Right side */}
          <div className="ml-auto flex items-center gap-2">
            <button className="flex items-center gap-2 rounded-[var(--radius)] border bg-secondary/50 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-secondary">
              <Search size={12} />
              <span>Search...</span>
              <kbd className="ml-2 flex items-center gap-0.5 rounded border bg-background px-1 py-0.5 font-mono text-[10px]">
                <Command size={9} />K
              </kbd>
            </button>

            <button
              onClick={() => setDark(!dark)}
              className="flex h-8 w-8 items-center justify-center rounded-[var(--radius)] border text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            >
              {dark ? <Sun size={14} /> : <Moon size={14} />}
            </button>

            <Link
              to="/settings"
              className={`flex h-8 w-8 items-center justify-center rounded-[var(--radius)] border transition-colors no-underline ${
                location.pathname === '/settings'
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
              }`}
            >
              <Settings size={14} />
            </Link>

            <div className="flex h-7 w-7 items-center justify-center rounded-full border bg-primary/10 font-mono text-xs font-medium text-primary">
              FL
            </div>
          </div>
        </div>
      </nav>

      {/* Main Content */}
      <main className="mx-auto max-w-full">
        {children}
      </main>
    </div>
  );
}
