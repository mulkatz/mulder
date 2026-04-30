import { Bell, ChevronDown, HelpCircle, Menu, Plus, RefreshCw } from 'lucide-react';
import { IconButton } from '@/components/IconButton';
import { SearchInput } from '@/components/SearchInput';

export function Topbar({ onOpenSidebar }: { onOpenSidebar: () => void }) {
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
				<IconButton className="hidden sm:inline-flex" label="Refresh">
					<RefreshCw className="size-4" />
				</IconButton>
				<IconButton className="hidden md:inline-flex" label="Notifications">
					<Bell className="size-4" />
				</IconButton>
				<IconButton className="hidden sm:inline-flex" label="Help">
					<HelpCircle className="size-4" />
				</IconButton>
				<button
					className="hidden h-9 items-center gap-2 rounded-md border border-border bg-panel px-3 text-sm text-text transition-colors hover:bg-field sm:inline-flex"
					type="button"
				>
					<Plus className="size-4 text-accent" />
					New run
				</button>
				<button
					className="hidden h-9 items-center gap-2 rounded-md border border-border bg-field px-2 text-sm text-text min-[480px]:flex sm:px-3"
					type="button"
				>
					<span className="flex size-5 items-center justify-center rounded-sm bg-accent font-mono text-[11px] text-text-inverse">
						M
					</span>
					<span className="hidden sm:inline">Operator</span>
					<ChevronDown className="size-3.5 text-text-subtle" />
				</button>
			</div>
		</header>
	);
}
