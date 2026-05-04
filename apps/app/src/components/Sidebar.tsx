import {
	Activity,
	AlertCircle,
	AlertTriangle,
	BarChart3,
	Bell,
	BookOpen,
	Download,
	FileText,
	Gauge,
	Home,
	KeyRound,
	Link2,
	Network,
	Plus,
	Search,
	Settings,
	ShieldCheck,
	Workflow,
	X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { NavLink } from 'react-router-dom';
import { IconButton } from '@/components/IconButton';
import type { CapabilityId } from '@/lib/capabilities';
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
		labelKey: 'navigation.workspace',
		items: [
			{ to: '/', labelKey: 'navigation.researchDesk', icon: Home, capability: 'status.overview' },
			{ labelKey: 'navigation.reviewQueue', icon: ShieldCheck, capability: 'workspace.reviewQueue' },
			{ labelKey: 'navigation.watchlist', icon: Bell, capability: 'workspace.watchlist' },
			{ labelKey: 'navigation.researchAgent', icon: Gauge, capability: 'workspace.agent' },
		],
	},
	{
		labelKey: 'navigation.searchGroup',
		items: [{ labelKey: 'navigation.search', icon: Search, capability: 'search.hybrid' }],
	},
	{
		labelKey: 'navigation.sources',
		items: [
			{ to: '/sources', labelKey: 'navigation.allSources', icon: FileText, capability: 'documents.list' },
			{ labelKey: 'navigation.addSources', icon: Plus, capability: 'sources.add' },
			{ labelKey: 'navigation.archive', icon: BookOpen, capability: 'documents.viewer' },
			{ labelKey: 'navigation.sourceQuality', icon: AlertTriangle, capability: 'm10.provenance' },
		],
	},
	{
		labelKey: 'navigation.findings',
		items: [
			{
				to: '/evidence',
				labelKey: 'navigation.claimsAndEvidence',
				icon: ShieldCheck,
				capability: 'evidence.contradictions',
			},
			{ labelKey: 'navigation.contradictions', icon: AlertTriangle, capability: 'evidence.contradictions' },
			{ labelKey: 'navigation.sourceReliability', icon: BarChart3, capability: 'evidence.reliability' },
			{ labelKey: 'navigation.evidenceChains', icon: Link2, capability: 'evidence.chains' },
			{ labelKey: 'navigation.clustersAndTimelines', icon: Network, capability: 'evidence.clusters' },
		],
	},
	{
		labelKey: 'navigation.knowledgeBase',
		items: [
			{ labelKey: 'navigation.entities', icon: KeyRound, capability: 'entities.list' },
			{ labelKey: 'navigation.relationships', icon: Link2, capability: 'relationships.list' },
			{ labelKey: 'navigation.knowledgeMap', icon: Network, capability: 'graph.aggregate' },
			{ labelKey: 'navigation.claimRegistry', icon: ShieldCheck, capability: 'evidence.claims' },
			{ labelKey: 'navigation.taxonomy', icon: BookOpen, capability: 'taxonomy.manage' },
			{ labelKey: 'navigation.stories', icon: FileText, capability: 'stories.list' },
		],
	},
	{
		labelKey: 'navigation.operations',
		items: [
			{ to: '/runs', labelKey: 'navigation.processing', icon: Workflow, capability: 'jobs.list' },
			{ labelKey: 'navigation.activity', icon: Activity, capability: 'activity.feed' },
			{ labelKey: 'navigation.recovery', icon: AlertCircle, capability: 'operations.recovery' },
			{ labelKey: 'navigation.usageAndCost', icon: BarChart3, capability: 'usage.cost' },
			{ labelKey: 'navigation.exports', icon: Download, capability: 'exports.list' },
		],
	},
	{
		labelKey: 'navigation.admin',
		items: [
			{ labelKey: 'navigation.settings', icon: Settings, capability: 'settings.admin' },
			{ labelKey: 'navigation.membersAndAccess', icon: KeyRound, capability: 'admin.members' },
			{ labelKey: 'navigation.policies', icon: ShieldCheck, capability: 'admin.policies' },
			{ labelKey: 'navigation.integrations', icon: Network, capability: 'admin.integrations' },
		],
	},
];

function capabilityNoteKey(capability: CapabilityId) {
	return `capabilities.${capability.replaceAll('.', '_')}`;
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
						<p className="truncate text-[11px] text-text-subtle">{t('navigation.brandSubtitle')}</p>
					</div>
				</div>
				{mobile && onClose ? (
					<IconButton className="lg:hidden" label={t('navigation.closeSidebar')} onClick={onClose}>
						<X className="size-4" />
					</IconButton>
				) : null}
			</div>

			<div className="border-b border-border p-3">
				<div className="rounded-md border border-border bg-field px-3 py-2">
					<p className="truncate text-sm font-medium text-text">{t('navigation.workspaceScope')}</p>
					<p className="mt-0.5 truncate text-xs text-text-subtle">{t('navigation.workspaceScopeDetail')}</p>
				</div>
			</div>

			<nav className="flex-1 overflow-y-auto p-3">
				<div className="space-y-4">
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
												<span className="truncate">{label}</span>
											</NavLink>
										);
									}

									return (
										<button
											aria-disabled="true"
											className="flex h-9 w-full items-center gap-3 rounded-md px-3 text-left text-sm text-text-faint"
											disabled
											key={item.labelKey}
											title={t(capabilityNoteKey(item.capability))}
											type="button"
										>
											<Icon className="size-4 shrink-0" />
											<span className="truncate">{label}</span>
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
