import { AlertTriangle, Archive, Database, Network, Play, ShieldCheck } from 'lucide-react';
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
import { getErrorMessage, hasQueryError } from '@/lib/query-state';
import type { ActivityEvent, AnalysisRun, Finding } from '@/lib/types';
import { buildOverviewMetrics, contradictionsToFindings, jobsToActivity, jobToAnalysisRun } from '@/lib/view-models';

const activeRunColumns: DataColumn<AnalysisRun>[] = [
	{
		key: 'title',
		header: 'Run',
		render: (run) => (
			<div className="min-w-0">
				<p className="truncate font-medium text-text">{run.title}</p>
				<p className="mt-1 truncate font-mono text-xs text-text-subtle">{run.id}</p>
			</div>
		),
	},
	{ key: 'mode', header: 'Mode', render: (run) => <span className="text-text-muted">{run.mode}</span> },
	{ key: 'status', header: 'Status', render: (run) => <StatusBadge status={run.status} /> },
	{
		key: 'progress',
		header: 'Progress',
		render: (run) => (
			<div className="flex items-center gap-3">
				{run.progress === null ? (
					<span className="font-mono text-xs text-text-subtle">not exposed</span>
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
		header: 'Findings',
		render: (run) => <span className="font-mono text-sm">{run.findings ?? '—'}</span>,
	},
];

const activityColumns: DataColumn<ActivityEvent>[] = [
	{
		key: 'event',
		header: 'Event',
		render: (event) => (
			<div>
				<p className="font-medium text-text">{event.label}</p>
				<p className="mt-1 text-xs text-text-muted">{event.detail}</p>
			</div>
		),
	},
	{
		key: 'time',
		header: 'Time',
		className: 'w-24',
		render: (event) => <span className="font-mono text-xs">{event.time}</span>,
	},
	{ key: 'status', header: 'Status', className: 'w-28', render: (event) => <StatusBadge status={event.status} /> },
];

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

export function OverviewPage() {
	const statusQuery = useStatus();
	const jobsQuery = useJobs({ limit: 8 });
	const documentsQuery = useDocuments({ limit: 5 });
	const evidenceQuery = useEvidenceSummary();
	const contradictionsQuery = useContradictions({ limit: 5 });

	const metrics = buildOverviewMetrics({
		documents: documentsQuery.data,
		evidence: evidenceQuery.data,
		status: statusQuery.data,
	});
	const activeRuns = (jobsQuery.data?.data ?? [])
		.map(jobToAnalysisRun)
		.filter((run) => run.status === 'running' || run.status === 'queued' || run.status === 'watching');
	const findings = contradictionsToFindings(contradictionsQuery.data?.data ?? []);
	const activity = jobsToActivity(jobsQuery.data?.data ?? []);
	const hasError = hasQueryError([
		statusQuery.error,
		jobsQuery.error,
		documentsQuery.error,
		evidenceQuery.error,
		contradictionsQuery.error,
	]);
	const firstError =
		statusQuery.error ?? jobsQuery.error ?? documentsQuery.error ?? evidenceQuery.error ?? contradictionsQuery.error;
	const isLoading =
		statusQuery.isLoading ||
		jobsQuery.isLoading ||
		documentsQuery.isLoading ||
		evidenceQuery.isLoading ||
		contradictionsQuery.isLoading;
	const queue = statusQuery.data?.data.jobs;

	return (
		<>
			<PageHeader
				actions={
					<button
						className="inline-flex h-9 items-center gap-2 rounded-md bg-field px-3 text-sm font-medium text-text-subtle"
						disabled
						title="Pipeline actions will be wired after the API foundation is in place."
						type="button"
					>
						<Play className="size-4" />
						Start analysis
					</button>
				}
				description="System pulse, corpus health, active analyses, and high-signal findings."
				eyebrow="Overview"
				title="Analysis control plane"
			/>

			<div className="space-y-4 p-4 sm:p-6">
				{isLoading ? <StateNotice tone="loading" title="Loading API-backed overview" /> : null}
				{hasError ? (
					<StateNotice tone="error" title="Overview API unavailable">
						{getErrorMessage(firstError)}
					</StateNotice>
				) : null}

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
								<Database className="size-4 text-accent" />
								<h2 className="font-medium text-text">Active analyses</h2>
							</div>
							<span className="ml-auto font-mono text-xs text-text-subtle">{activeRuns.length} live</span>
						</Toolbar>
						<DataTable
							columns={activeRunColumns}
							emptyMessage="No active jobs returned by the API"
							getRowKey={(run) => run.id}
							minWidth={660}
							rows={activeRuns}
						/>
					</section>

					<InspectorPanel subtitle="Claims and entities needing attention" title="Recent findings">
						<div className="-m-4">
							{findings.length > 0 ? (
								findings.map((finding) => <FindingRow finding={finding} key={finding.id} />)
							) : (
								<div className="p-4 text-sm text-text-muted">No contradiction findings returned by the API.</div>
							)}
						</div>
					</InspectorPanel>
				</div>

				<div className="grid gap-4 xl:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
					<InspectorPanel title="API readiness">
						<InspectorSection title="Read models">
							<div className="space-y-2">
								<div className="flex items-center justify-between gap-3 rounded-md bg-field p-3">
									<span className="text-sm text-text-muted">Status</span>
									<StatusBadge status={statusQuery.isSuccess ? 'mounted-api' : 'missing'} />
								</div>
								<div className="flex items-center justify-between gap-3 rounded-md bg-field p-3">
									<span className="text-sm text-text-muted">Jobs</span>
									<StatusBadge status={jobsQuery.isSuccess ? 'mounted-api' : 'missing'} />
								</div>
								<div className="flex items-center justify-between gap-3 rounded-md bg-field p-3">
									<span className="text-sm text-text-muted">Evidence</span>
									<StatusBadge status={evidenceQuery.isSuccess ? 'mounted-api' : 'missing'} />
								</div>
							</div>
						</InspectorSection>
						<InspectorSection title="Queue">
							<div className="grid grid-cols-3 gap-2">
								<div className="rounded-md bg-field p-3">
									<p className="font-mono text-lg font-semibold">{queue?.running ?? '—'}</p>
									<p className="text-xs text-text-muted">Running</p>
								</div>
								<div className="rounded-md bg-field p-3">
									<p className="font-mono text-lg font-semibold">{queue?.pending ?? '—'}</p>
									<p className="text-xs text-text-muted">Queued</p>
								</div>
								<div className="rounded-md bg-field p-3">
									<p className="font-mono text-lg font-semibold">{queue ? queue.failed + queue.dead_letter : '—'}</p>
									<p className="text-xs text-text-muted">Blocked</p>
								</div>
							</div>
						</InspectorSection>
					</InspectorPanel>

					<section className="panel min-w-0 overflow-hidden">
						<Toolbar>
							<h2 className="font-medium text-text">Activity</h2>
						</Toolbar>
						<DataTable
							columns={activityColumns}
							emptyMessage="No job activity returned by the API"
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
