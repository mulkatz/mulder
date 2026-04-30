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
import { useTranslation } from 'react-i18next';
import { NavLink } from 'react-router-dom';
import { IconButton } from '@/components/IconButton';
import { type CapabilityId, getCapability } from '@/lib/capabilities';
import { cn } from '@/lib/cn';

const navGroups: {
	labelKey: string;
	items: {
		to?: string;
		labelKey: string;
		icon: typeof Home;
		capability: CapabilityId;
	}[];
}[] = [
	{
		labelKey: 'navigation.research',
		items: [
			{ to: '/', labelKey: 'navigation.overview', icon: Home, capability: 'status.overview' },
			{
				to: '/evidence',
				labelKey: 'navigation.evidenceWorkspace',
				icon: ShieldCheck,
				capability: 'evidence.contradictions',
			},
			{ labelKey: 'navigation.documents', icon: FileText, capability: 'documents.viewer' },
			{ labelKey: 'navigation.search', icon: Search, capability: 'search.hybrid' },
		],
	},
	{
		labelKey: 'navigation.knowledge',
		items: [
			{ labelKey: 'navigation.entities', icon: KeyRound, capability: 'entities.list' },
			{ labelKey: 'navigation.graph', icon: Network, capability: 'graph.aggregate' },
		],
	},
	{
		labelKey: 'navigation.operations',
		items: [
			{ to: '/runs', labelKey: 'navigation.analysisRuns', icon: Workflow, capability: 'jobs.list' },
			{ labelKey: 'navigation.activity', icon: Activity, capability: 'activity.feed' },
			{ labelKey: 'navigation.usage', icon: BarChart3, capability: 'usage.cost' },
		],
	},
	{
		labelKey: 'navigation.admin',
		items: [{ labelKey: 'navigation.settings', icon: Settings, capability: 'settings.admin' }],
	},
];

function stateLabel(capability: CapabilityId, t: ReturnType<typeof useTranslation>['t']) {
	const state = getCapability(capability).state;
	if (state === 'mounted-api') return t('capabilityState.api');
	if (state === 'mounted-partial') return t('capabilityState.partial');
	if (state === 'missing') return t('capabilityState.gap');
	return t('capabilityState.soon');
}

function capabilityNoteKey(capability: CapabilityId) {
	return `capabilities.${capability.replace('.', '_')}`;
}

export function Sidebar({ onClose, mobile = false }: { onClose?: () => void; mobile?: boolean }) {
	const { t } = useTranslation();

	return (
		<aside className="flex h-full w-[var(--sidebar-width)] flex-col border-r border-border bg-panel">
			<div className="flex h-[var(--topbar-height)] items-center justify-between border-b border-border px-4">
				<div className="flex min-w-0 items-center gap-3">
					<div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-accent text-text-inverse">
						<Gauge className="size-4" />
					</div>
					<div className="min-w-0">
						<p className="truncate text-sm font-semibold text-text">{t('common.appName')}</p>
						<p className="truncate font-mono text-[11px] text-text-subtle">{t('navigation.brandSubtitle')}</p>
					</div>
				</div>
				{mobile && onClose ? (
					<IconButton className="lg:hidden" label={t('navigation.closeSidebar')} onClick={onClose}>
						<X className="size-4" />
					</IconButton>
				) : null}
			</div>

			<div className="border-b border-border p-3">
				<button
					className="flex w-full items-center justify-between rounded-md border border-border bg-field px-3 py-2 text-left text-sm text-text transition-colors hover:bg-field-hover"
					type="button"
				>
					<span>{t('common.app')}</span>
					<span className="rounded-sm bg-panel px-1.5 py-0.5 font-mono text-[11px] text-accent">{t('common.api')}</span>
				</button>
			</div>

			<nav className="flex-1 overflow-y-auto p-3">
				<div className="space-y-5">
					{navGroups.map((group) => (
						<div key={group.labelKey}>
							<p className="px-3 text-xs font-medium text-text-subtle">{t(group.labelKey)}</p>
							<div className="mt-2 space-y-1">
								{group.items.map((item) => {
									const Icon = item.icon;
									const label = t(item.labelKey);
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
												key={item.labelKey}
												onClick={onClose}
												to={item.to}
											>
												<Icon className="size-4 shrink-0" />
												<span>{label}</span>
											</NavLink>
										);
									}

									return (
										<button
											aria-disabled="true"
											className="flex h-9 w-full items-center justify-between gap-3 rounded-md px-3 text-left text-sm text-text-faint"
											disabled
											key={item.labelKey}
											title={t(capabilityNoteKey(item.capability), {
												defaultValue: getCapability(item.capability).note,
											})}
											type="button"
										>
											<span className="flex items-center gap-3">
												<Icon className="size-4 shrink-0" />
												{label}
											</span>
											<span className="font-mono text-[10px] text-text-faint">{stateLabel(item.capability, t)}</span>
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
