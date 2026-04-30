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
import { type CapabilityId, getCapability } from '@/lib/capabilities';
import { cn } from '@/lib/cn';

const navGroups: {
	label: string;
	items: {
		to?: string;
		label: string;
		icon: typeof Home;
		capability: CapabilityId;
	}[];
}[] = [
	{
		label: 'Research',
		items: [
			{ to: '/', label: 'Overview', icon: Home, capability: 'status.overview' },
			{ to: '/evidence', label: 'Evidence Workspace', icon: ShieldCheck, capability: 'evidence.contradictions' },
			{ label: 'Documents', icon: FileText, capability: 'documents.viewer' },
			{ label: 'Search', icon: Search, capability: 'search.hybrid' },
		],
	},
	{
		label: 'Knowledge',
		items: [
			{ label: 'Entities', icon: KeyRound, capability: 'entities.list' },
			{ label: 'Graph', icon: Network, capability: 'graph.aggregate' },
		],
	},
	{
		label: 'Operations',
		items: [
			{ to: '/runs', label: 'Analysis Runs', icon: Workflow, capability: 'jobs.list' },
			{ label: 'Activity', icon: Activity, capability: 'activity.feed' },
			{ label: 'Usage', icon: BarChart3, capability: 'usage.cost' },
		],
	},
	{
		label: 'Admin',
		items: [{ label: 'Settings', icon: Settings, capability: 'settings.admin' }],
	},
];

function stateLabel(capability: CapabilityId) {
	const state = getCapability(capability).state;
	if (state === 'mounted-api') return 'api';
	if (state === 'mounted-partial') return 'partial';
	if (state === 'missing') return 'gap';
	return 'soon';
}

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
					<span>App</span>
					<span className="rounded-sm bg-panel px-1.5 py-0.5 font-mono text-[11px] text-accent">API</span>
				</button>
			</div>

			<nav className="flex-1 overflow-y-auto p-3">
				<div className="space-y-5">
					{navGroups.map((group) => (
						<div key={group.label}>
							<p className="px-3 text-xs font-medium text-text-subtle">{group.label}</p>
							<div className="mt-2 space-y-1">
								{group.items.map((item) => {
									const Icon = item.icon;
									if (item.to) {
										return (
											<NavLink
												className={({ isActive }) =>
													cn(
														'flex h-9 items-center gap-3 rounded-md px-3 text-sm text-text-muted transition-colors hover:bg-field hover:text-text',
														isActive && 'bg-accent-soft text-accent',
													)
												}
												end={item.to === '/'}
												key={item.label}
												onClick={onClose}
												to={item.to}
											>
												<Icon className="size-4 shrink-0" />
												<span>{item.label}</span>
											</NavLink>
										);
									}

									return (
										<button
											aria-disabled="true"
											className="flex h-9 w-full items-center justify-between gap-3 rounded-md px-3 text-left text-sm text-text-faint"
											disabled
											key={item.label}
											title={getCapability(item.capability).note}
											type="button"
										>
											<span className="flex items-center gap-3">
												<Icon className="size-4 shrink-0" />
												{item.label}
											</span>
											<span className="font-mono text-[10px] text-text-faint">{stateLabel(item.capability)}</span>
										</button>
									);
								})}
							</div>
						</div>
					))}
				</div>
			</nav>
		</aside>
	);
}
