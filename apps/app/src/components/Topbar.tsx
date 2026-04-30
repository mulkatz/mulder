import { useQueryClient } from '@tanstack/react-query';
import { Bell, HelpCircle, LogOut, Menu, Plus, RefreshCw } from 'lucide-react';
import { IconButton } from '@/components/IconButton';
import { SearchInput } from '@/components/SearchInput';
import { useLogout } from '@/features/auth/useLogout';
import { useSession } from '@/features/auth/useSession';

export function Topbar({ onOpenSidebar }: { onOpenSidebar: () => void }) {
	const queryClient = useQueryClient();
	const sessionQuery = useSession();
	const logout = useLogout();
	const user = sessionQuery.data?.data.user;

	return (
		<header className="sticky top-0 z-30 flex h-[var(--topbar-height)] min-w-0 items-center gap-3 overflow-hidden border-b border-border bg-panel/95 px-3 backdrop-blur sm:px-4">
			<IconButton className="lg:hidden" label="Open sidebar" onClick={onOpenSidebar}>
				<Menu className="size-4" />
			</IconButton>

			<div className="hidden min-w-0 flex-1 items-center gap-3 md:flex">
				<SearchInput className="max-w-md" placeholder="Search runs, claims, sources..." />
				<button
					className="field hidden h-9 items-center gap-2 px-3 text-sm text-text-muted transition-colors hover:bg-field-hover lg:inline-flex"
					type="button"
				>
					<span className="font-mono text-xs">⌘K</span>
					Command
				</button>
			</div>

			<div className="ml-auto flex items-center gap-2">
				<IconButton className="hidden sm:inline-flex" label="Refresh" onClick={() => queryClient.invalidateQueries()}>
					<RefreshCw className="size-4" />
				</IconButton>
				<IconButton className="hidden md:inline-flex" label="Notifications">
					<Bell className="size-4" />
				</IconButton>
				<IconButton className="hidden sm:inline-flex" label="Help">
					<HelpCircle className="size-4" />
				</IconButton>
				<button
					className="hidden h-9 items-center gap-2 rounded-md border border-border bg-panel px-3 text-sm text-text-subtle sm:inline-flex"
					disabled
					title="Run creation is gated until the product run contract is ready."
					type="button"
				>
					<Plus className="size-4 text-accent" />
					New run
				</button>
				<button
					className="hidden h-9 max-w-[220px] items-center gap-2 rounded-md border border-border bg-field px-2 text-sm text-text transition-colors hover:bg-field-hover min-[480px]:flex sm:px-3"
					disabled={logout.isPending}
					onClick={() => logout.mutate()}
					title={user ? `Signed in as ${user.email}. Click to sign out.` : 'Sign out'}
					type="button"
				>
					<span className="flex size-5 items-center justify-center rounded-sm bg-accent font-mono text-[11px] text-text-inverse">
						{user?.email.slice(0, 1).toUpperCase() ?? 'M'}
					</span>
					<span className="hidden truncate sm:inline">{user?.email ?? 'Account'}</span>
					<LogOut className="size-3.5 text-text-subtle" />
				</button>
			</div>
		</header>
	);
}
