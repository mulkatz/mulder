import type { TFunction } from 'i18next';
import { AlertTriangle, Archive, Network, Plus, ShieldCheck, Workflow } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { type DataColumn, DataTable } from '@/components/DataTable';
import { InspectorPanel, InspectorSection } from '@/components/InspectorPanel';
import { MetricCard } from '@/components/MetricCard';
import { PageHeader } from '@/components/PageHeader';
import { StateNotice } from '@/components/StateNotice';
import { StatusBadge } from '@/components/StatusBadge';
import { Toolbar } from '@/components/Toolbar';
import { useDocuments } from '@/features/documents/useDocuments';
import { useContradictions } from '@/features/evidence/useContradictions';
import { useEvidenceSummary } from '@/features/evidence/useEvidenceSummary';
import { useJobs } from '@/features/jobs/useJobs';
import { useStatus } from '@/features/status/useStatus';
import { getErrorMessage, isApiUnavailableError } from '@/lib/query-state';
import type { ActivityEvent, AnalysisRun, Finding } from '@/lib/types';
import { buildOverviewMetrics, contradictionsToFindings, jobsToActivity, jobToAnalysisRun } from '@/lib/view-models';

function getActiveRunColumns(t: TFunction): DataColumn<AnalysisRun>[] {
	return [
		{
			key: 'title',
			header: t('runs.tableRun'),
			render: (run) => (
				<div className="min-w-0">
					<p className="truncate font-medium text-text">{run.title}</p>
				</div>
			),
		},
		{ key: 'mode', header: t('common.mode'), render: (run) => <span className="text-text-muted">{run.mode}</span> },
		{ key: 'status', header: t('common.status'), render: (run) => <StatusBadge status={run.status} /> },
		{
			key: 'progress',
			header: t('runs.tableProgress'),
			render: (run) => (
				<div className="flex items-center gap-3">
					{run.progress === null ? (
						<span className="font-mono text-xs text-text-subtle">{t('common.notExposed')}</span>
					) : (
						<>
							<div className="h-1.5 w-28 overflow-hidden rounded-xs bg-field">
								<div className="h-full rounded-xs bg-accent" style={{ width: `${run.progress}%` }} />
							</div>
							<span className="font-mono text-xs text-text-muted">{run.progress}%</span>
						</>
					)}
				</div>
			),
		},
		{
			key: 'findings',
			header: t('runs.findings'),
			render: (run) => <span className="font-mono text-sm">{run.findings ?? '—'}</span>,
		},
	];
}

function getActivityColumns(t: TFunction): DataColumn<ActivityEvent>[] {
	return [
		{
			key: 'event',
			header: t('overview.activity'),
			render: (event) => (
				<div>
					<p className="font-medium text-text">{event.label}</p>
					<p className="mt-1 text-xs text-text-muted">{event.detail}</p>
				</div>
			),
		},
		{
			key: 'time',
			header: t('common.started'),
			className: 'w-24',
			render: (event) => <span className="font-mono text-xs">{event.time}</span>,
		},
		{
			key: 'status',
			header: t('common.status'),
			className: 'w-28',
			render: (event) => <StatusBadge status={event.status} />,
		},
	];
}

function FindingRow({ finding }: { finding: Finding }) {
	return (
		<div className="border-b border-border px-4 py-3 last:border-b-0">
			<div className="flex items-center justify-between gap-3">
				<StatusBadge status={finding.severity} />
				<span className="font-mono text-xs text-text-subtle">{finding.createdAt}</span>
			</div>
			<p className="mt-3 font-medium text-text">{finding.title}</p>
			<p className="mt-1 text-sm text-text-muted">{finding.summary}</p>
			<p className="mt-2 font-mono text-xs text-text-subtle">{finding.entity}</p>
		</div>
	);
}

function QueryNotice({
	error,
	errorFallback,
	errorTitle,
	isLoading,
	loadingTitle,
	unavailableTitle,
}: {
	error: unknown;
	errorFallback: string;
	errorTitle: string;
	isLoading: boolean;
	loadingTitle: string;
	unavailableTitle: string;
}) {
	if (isLoading) {
		return <StateNotice tone="loading" title={loadingTitle} />;
	}

	if (error) {
		return (
			<StateNotice tone="error" title={isApiUnavailableError(error) ? unavailableTitle : errorTitle}>
				{getErrorMessage(error, errorFallback)}
			</StateNotice>
		);
	}

	return null;
}

export function OverviewPage() {
	const { t, i18n } = useTranslation();
	const statusQuery = useStatus();
	const jobsQuery = useJobs({ limit: 8 });
	const documentsQuery = useDocuments({ limit: 5 });
	const evidenceQuery = useEvidenceSummary();
	const contradictionsQuery = useContradictions({ limit: 5 });
	const viewModelContext = { locale: i18n.language, t };

	const metrics = buildOverviewMetrics(
		{
			documents: documentsQuery.data,
			documentsError: documentsQuery.error,
			evidence: evidenceQuery.data,
			evidenceError: evidenceQuery.error,
			status: statusQuery.data,
			statusError: statusQuery.error,
		},
		viewModelContext,
	);
	const activeRuns = jobsQuery.error
		? []
		: (jobsQuery.data?.data ?? [])
				.map((job) => jobToAnalysisRun(job, viewModelContext))
				.filter((run) => run.status === 'running' || run.status === 'queued' || run.status === 'watching');
	const findings = contradictionsQuery.error
		? []
		: contradictionsToFindings(contradictionsQuery.data?.data ?? [], viewModelContext);
	const activity = jobsQuery.error ? [] : jobsToActivity(jobsQuery.data?.data ?? [], viewModelContext);
	const activeRunColumns = getActiveRunColumns(t);
	const activityColumns = getActivityColumns(t);
	const queue = statusQuery.data?.data.jobs;
	const sourceCount = documentsQuery.data?.meta.count;
	const scoredSources = evidenceQuery.data?.data.sources.scored;
	const openContradictions = evidenceQuery.data
		? evidenceQuery.data.data.contradictions.potential + evidenceQuery.data.data.contradictions.confirmed
		: undefined;
	const workspaceUnavailable = Boolean(statusQuery.error && !statusQuery.data);
	const sourceCountValue = documentsQuery.error ? t('common.unavailableShort') : (sourceCount ?? '—');
	const scoredSourcesValue = evidenceQuery.error ? t('common.unavailableShort') : (scoredSources ?? '—');
	const openContradictionsValue = evidenceQuery.error ? t('common.unavailableShort') : (openContradictions ?? '—');

	if (workspaceUnavailable) {
		return (
			<>
				<PageHeader
					actions={
						<button
							className="inline-flex h-9 items-center gap-2 rounded-md bg-field px-3 text-sm font-medium text-text-subtle"
							disabled
							title={t('overview.startAnalysisTitle')}
							type="button"
						>
							<Plus className="size-4" />
							{t('overview.startAnalysis')}
						</button>
					}
					description={t('overview.description')}
					eyebrow={t('overview.eyebrow')}
					title={t('overview.title')}
				/>

				<div className="p-4 sm:p-6">
					<StateNotice
						tone="error"
						title={
							isApiUnavailableError(statusQuery.error)
								? t('overview.workspaceUnavailableTitle')
								: t('overview.errorTitle')
						}
					>
						{getErrorMessage(statusQuery.error, t('overview.workspaceUnavailableBody'))}
					</StateNotice>
				</div>
			</>
		);
	}

	return (
		<>
			<PageHeader
				actions={
					<button
						className="inline-flex h-9 items-center gap-2 rounded-md bg-field px-3 text-sm font-medium text-text-subtle"
						disabled
						title={t('overview.startAnalysisTitle')}
						type="button"
					>
						<Plus className="size-4" />
						{t('overview.startAnalysis')}
					</button>
				}
				description={t('overview.description')}
				eyebrow={t('overview.eyebrow')}
				title={t('overview.title')}
			/>

			<div className="space-y-4 p-4 sm:p-6">
				{statusQuery.isLoading ? <StateNotice tone="loading" title={t('overview.loadingTitle')} /> : null}

				<div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
					<MetricCard icon={<Archive className="size-4" />} metric={metrics[0]} />
					<MetricCard icon={<Network className="size-4" />} metric={metrics[1]} />
					<MetricCard icon={<AlertTriangle className="size-4" />} metric={metrics[2]} />
					<MetricCard icon={<ShieldCheck className="size-4" />} metric={metrics[3]} />
				</div>

				<div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
					<section className="panel min-w-0 overflow-hidden">
						<Toolbar>
							<div className="flex items-center gap-2">
								<Workflow className="size-4 text-accent" />
								<h2 className="font-medium text-text">{t('overview.activeAnalyses')}</h2>
							</div>
							<span className="ml-auto font-mono text-xs text-text-subtle">
								{t('overview.liveCount', { count: activeRuns.length })}
							</span>
						</Toolbar>
						{jobsQuery.error || jobsQuery.isLoading ? (
							<div className="border-b border-border p-3">
								<QueryNotice
									error={jobsQuery.error}
									errorFallback={t('common.apiRequestFailed')}
									errorTitle={t('overview.processingErrorTitle')}
									isLoading={jobsQuery.isLoading}
									loadingTitle={t('overview.processingLoadingTitle')}
									unavailableTitle={t('overview.processingUnavailableTitle')}
								/>
							</div>
						) : null}
						<DataTable
							columns={activeRunColumns}
							emptyMessage={jobsQuery.error ? t('overview.processingUnavailableShort') : t('overview.noActiveJobs')}
							getRowKey={(run) => run.id}
							minWidth={660}
							rows={activeRuns}
						/>
					</section>

					<InspectorPanel subtitle={t('overview.findingsSubtitle')} title={t('overview.findingsTitle')}>
						<div className="-m-4">
							{contradictionsQuery.error || contradictionsQuery.isLoading ? (
								<div className="p-4">
									<QueryNotice
										error={contradictionsQuery.error}
										errorFallback={t('common.apiRequestFailed')}
										errorTitle={t('overview.findingsErrorTitle')}
										isLoading={contradictionsQuery.isLoading}
										loadingTitle={t('overview.findingsLoadingTitle')}
										unavailableTitle={t('overview.findingsUnavailableTitle')}
									/>
								</div>
							) : findings.length > 0 ? (
								findings.map((finding) => <FindingRow finding={finding} key={finding.id} />)
							) : (
								<div className="p-4 text-sm text-text-muted">{t('overview.noFindings')}</div>
							)}
						</div>
					</InspectorPanel>
				</div>

				<div className="grid gap-4 xl:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
					<InspectorPanel title={t('overview.sourceHealth')}>
						{documentsQuery.error || evidenceQuery.error || documentsQuery.isLoading || evidenceQuery.isLoading ? (
							<div className="mb-3 space-y-2">
								<QueryNotice
									error={documentsQuery.error}
									errorFallback={t('common.apiRequestFailed')}
									errorTitle={t('overview.sourcesErrorTitle')}
									isLoading={documentsQuery.isLoading}
									loadingTitle={t('overview.sourcesLoadingTitle')}
									unavailableTitle={t('overview.sourcesUnavailableTitle')}
								/>
								<QueryNotice
									error={evidenceQuery.error}
									errorFallback={t('common.apiRequestFailed')}
									errorTitle={t('overview.evidenceSummaryErrorTitle')}
									isLoading={evidenceQuery.isLoading}
									loadingTitle={t('overview.evidenceSummaryLoadingTitle')}
									unavailableTitle={t('overview.evidenceSummaryUnavailableTitle')}
								/>
							</div>
						) : null}
						<InspectorSection title={t('overview.sourceSignals')}>
							<div className="space-y-2">
								<div className="flex items-center justify-between gap-3 rounded-md bg-field p-3">
									<span className="text-sm text-text-muted">{t('overview.indexedSources')}</span>
									<span className="font-mono text-sm text-text">{sourceCountValue}</span>
								</div>
								<div className="flex items-center justify-between gap-3 rounded-md bg-field p-3">
									<span className="text-sm text-text-muted">{t('overview.scoredSources')}</span>
									<span className="font-mono text-sm text-text">{scoredSourcesValue}</span>
								</div>
								<div className="flex items-center justify-between gap-3 rounded-md bg-field p-3">
									<span className="text-sm text-text-muted">{t('overview.openContradictions')}</span>
									<span className="font-mono text-sm text-text">{openContradictionsValue}</span>
								</div>
							</div>
						</InspectorSection>
						<InspectorSection title={t('overview.backgroundWork')}>
							<div className="grid grid-cols-3 gap-2">
								<div className="rounded-md bg-field p-3">
									<p className="font-mono text-lg font-semibold">{queue?.running ?? '—'}</p>
									<p className="text-xs text-text-muted">{t('common.running')}</p>
								</div>
								<div className="rounded-md bg-field p-3">
									<p className="font-mono text-lg font-semibold">{queue?.pending ?? '—'}</p>
									<p className="text-xs text-text-muted">{t('common.queued')}</p>
								</div>
								<div className="rounded-md bg-field p-3">
									<p className="font-mono text-lg font-semibold">{queue ? queue.failed + queue.dead_letter : '—'}</p>
									<p className="text-xs text-text-muted">{t('common.blocked')}</p>
								</div>
							</div>
						</InspectorSection>
					</InspectorPanel>

					<section className="panel min-w-0 overflow-hidden">
						<Toolbar>
							<h2 className="font-medium text-text">{t('overview.activity')}</h2>
						</Toolbar>
						{jobsQuery.error || jobsQuery.isLoading ? (
							<div className="border-b border-border p-3">
								<QueryNotice
									error={jobsQuery.error}
									errorFallback={t('common.apiRequestFailed')}
									errorTitle={t('overview.activityErrorTitle')}
									isLoading={jobsQuery.isLoading}
									loadingTitle={t('overview.activityLoadingTitle')}
									unavailableTitle={t('overview.activityUnavailableTitle')}
								/>
							</div>
						) : null}
						<DataTable
							columns={activityColumns}
							emptyMessage={jobsQuery.error ? t('overview.activityUnavailableShort') : t('overview.noActivity')}
							getRowKey={(event) => event.id}
							minWidth={640}
							rows={activity}
						/>
					</section>
				</div>
			</div>
		</>
	);
}
