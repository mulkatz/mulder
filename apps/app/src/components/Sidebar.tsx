import {
	Activity,
	BarChart3,
	FileText,
	Gauge,
	Home,
	KeyRound,
	Network,
	Search,
	Settings,
	ShieldCheck,
	Workflow,
	X,
} from 'lucide-react';
import { NavLink } from 'react-router-dom';
import { IconButton } from '@/components/IconButton';
import { cn } from '@/lib/cn';

const activeNav = [
	{ to: '/', label: 'Overview', icon: Home },
	{ to: '/runs', label: 'Analysis Runs', icon: Workflow },
	{ to: '/evidence', label: 'Evidence Workspace', icon: ShieldCheck },
];

const futureNav = [
	{ label: 'Documents', icon: FileText },
	{ label: 'Entities', icon: KeyRound },
	{ label: 'Graph', icon: Network },
	{ label: 'Search', icon: Search },
	{ label: 'Activity', icon: Activity },
	{ label: 'Usage', icon: BarChart3 },
	{ label: 'Settings', icon: Settings },
];

export function Sidebar({ onClose, mobile = false }: { onClose?: () => void; mobile?: boolean }) {
	return (
		<aside className="flex h-full w-[var(--sidebar-width)] flex-col border-r border-border bg-panel">
			<div className="flex h-[var(--topbar-height)] items-center justify-between border-b border-border px-4">
				<div className="flex min-w-0 items-center gap-3">
					<div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-accent text-text-inverse">
						<Gauge className="size-4" />
					</div>
					<div className="min-w-0">
						<p className="truncate text-sm font-semibold text-text">Mulder</p>
						<p className="truncate font-mono text-[11px] text-text-subtle">analysis workbench</p>
					</div>
				</div>
				{mobile && onClose ? (
					<IconButton className="lg:hidden" label="Close sidebar" onClick={onClose}>
						<X className="size-4" />
					</IconButton>
				) : null}
			</div>

			<div className="border-b border-border p-3">
				<button
					className="flex w-full items-center justify-between rounded-md border border-border bg-field px-3 py-2 text-left text-sm text-text transition-colors hover:bg-field-hover"
					type="button"
				>
					<span>Research Ops</span>
					<span className="rounded-sm bg-panel px-1.5 py-0.5 font-mono text-[11px] text-accent">PRO</span>
				</button>
			</div>

			<nav className="flex-1 overflow-y-auto p-3">
				<div className="space-y-1">
					{activeNav.map((item) => {
						const Icon = item.icon;
						return (
							<NavLink
								className={({ isActive }) =>
									cn(
										'flex h-9 items-center gap-3 rounded-md px-3 text-sm text-text-muted transition-colors hover:bg-field hover:text-text',
										isActive && 'bg-accent-soft text-accent',
									)
								}
								end={item.to === '/'}
								key={item.to}
								onClick={onClose}
								to={item.to}
							>
								<Icon className="size-4 shrink-0" />
								<span>{item.label}</span>
							</NavLink>
						);
					})}
				</div>

				<div className="mt-5 border-t border-border pt-4">
					<p className="px-3 text-xs font-medium text-text-subtle">Next</p>
					<div className="mt-2 space-y-1">
						{futureNav.map((item) => {
							const Icon = item.icon;
							return (
								<button
									aria-disabled="true"
									className="flex h-9 w-full items-center justify-between gap-3 rounded-md px-3 text-left text-sm text-text-faint"
									disabled
									key={item.label}
									type="button"
								>
									<span className="flex items-center gap-3">
										<Icon className="size-4 shrink-0" />
										{item.label}
									</span>
									<span className="font-mono text-[10px] text-text-faint">soon</span>
								</button>
							);
						})}
					</div>
				</div>
			</nav>

			<div className="border-t border-border p-3">
				<div className="rounded-md border border-accent-line bg-accent-soft p-3">
					<p className="text-sm font-medium text-text">Live pipeline</p>
					<div className="mt-3 flex items-center gap-2">
						<span className="size-2 rounded-full bg-success" />
						<span className="text-sm text-text-muted">4 workers available</span>
					</div>
				</div>
			</div>
		</aside>
	);
}
