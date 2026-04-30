import { AlertCircle, ChevronDown, Clock, Download, Filter, PlayCircle } from 'lucide-react';
import { useMemo, useState } from 'react';
import { CodeBlock } from '@/components/CodeBlock';
import { type DataColumn, DataTable } from '@/components/DataTable';
import { IconButton } from '@/components/IconButton';
import { InspectorPanel, InspectorSection } from '@/components/InspectorPanel';
import { PageHeader } from '@/components/PageHeader';
import { SearchInput } from '@/components/SearchInput';
import { StatusBadge } from '@/components/StatusBadge';
import { Tabs } from '@/components/Tabs';
import { SelectControl, Toolbar } from '@/components/Toolbar';
import { runs } from '@/lib/fixtures';
import type { AnalysisRun } from '@/lib/types';

const tabs = [
	{ value: 'all', label: 'All', count: runs.length },
	{ value: 'running', label: 'Running', count: runs.filter((run) => run.status === 'running').length },
	{ value: 'completed', label: 'Completed', count: runs.filter((run) => run.status === 'completed').length },
	{ value: 'watching', label: 'Watching', count: runs.filter((run) => run.status === 'watching').length },
	{ value: 'failed', label: 'Failed', count: runs.filter((run) => run.status === 'failed').length },
];

const runColumns: DataColumn<AnalysisRun>[] = [
	{
		key: 'run',
		header: 'Run',
		render: (run) => (
			<div className="min-w-0">
				<p className="truncate font-medium text-text">{run.title}</p>
				<p className="mt-1 truncate font-mono text-xs text-text-subtle">{run.id}</p>
			</div>
		),
	},
	{ key: 'status', header: 'Status', className: 'w-32', render: (run) => <StatusBadge status={run.status} /> },
	{ key: 'mode', header: 'Mode', render: (run) => <span className="text-text-muted">{run.mode}</span> },
	{ key: 'corpus', header: 'Corpus', render: (run) => <span className="text-text-muted">{run.corpus}</span> },
	{
		key: 'progress',
		header: 'Progress',
		render: (run) => (
			<div className="flex items-center gap-3">
				<div className="h-1.5 w-24 overflow-hidden rounded-xs bg-field">
					<div className="h-full rounded-xs bg-accent" style={{ width: `${run.progress}%` }} />
				</div>
				<span className="font-mono text-xs text-text-muted">{run.progress}%</span>
			</div>
		),
	},
	{
		key: 'credits',
		header: 'Credits',
		className: 'w-24',
		render: (run) => <span className="font-mono">{run.credits}</span>,
	},
	{
		key: 'started',
		header: 'Started',
		className: 'w-32',
		render: (run) => <span className="font-mono text-xs">{run.startedAt}</span>,
	},
];

export function AnalysisRunsPage() {
	const [status, setStatus] = useState('all');
	const [query, setQuery] = useState('');
	const [selectedId, setSelectedId] = useState(runs[0].id);

	const filteredRuns = useMemo(() => {
		return runs.filter((run) => {
			const statusMatch = status === 'all' || run.status === status;
			const queryMatch = `${run.title} ${run.id} ${run.mode} ${run.corpus}`.toLowerCase().includes(query.toLowerCase());
			return statusMatch && queryMatch;
		});
	}, [query, status]);

	const selectedRun = filteredRuns.find((run) => run.id === selectedId) ?? filteredRuns[0] ?? runs[0];

	return (
		<>
			<PageHeader
				actions={
					<>
						<button
							className="inline-flex h-9 items-center gap-2 rounded-md border border-border bg-panel px-3 text-sm text-text transition-colors hover:bg-field"
							type="button"
						>
							<Download className="size-4" />
							Export
						</button>
						<button
							className="inline-flex h-9 items-center gap-2 rounded-md bg-accent px-3 text-sm font-medium text-text-inverse transition-colors hover:bg-accent-hover"
							type="button"
						>
							<PlayCircle className="size-4" />
							New run
						</button>
					</>
				}
				description="Run queue, execution history, artifacts, and failure details."
				eyebrow="Analysis Runs"
				title="Monitor analysis jobs"
			/>

			<div className="grid gap-4 p-4 sm:p-6 xl:grid-cols-[minmax(0,1fr)_340px]">
				<section className="panel min-w-0 overflow-hidden">
					<Toolbar className="gap-3">
						<SearchInput
							className="w-full sm:max-w-sm"
							onChange={(event) => setQuery(event.target.value)}
							placeholder="Filter runs..."
							value={query}
						/>
						<SelectControl label="Mode">
							Any
							<ChevronDown className="size-3.5 text-text-subtle" />
						</SelectControl>
						<SelectControl label="Owner">
							All
							<ChevronDown className="size-3.5 text-text-subtle" />
						</SelectControl>
						<IconButton label="Advanced filters">
							<Filter className="size-4" />
						</IconButton>
					</Toolbar>

					<div className="border-b border-border p-3">
						<Tabs onChange={setStatus} tabs={tabs} value={status} />
					</div>

					<DataTable
						columns={runColumns}
						emptyMessage="No runs match the current filters"
						getRowKey={(run) => run.id}
						onRowClick={(run) => setSelectedId(run.id)}
						rows={filteredRuns}
						selectedKey={selectedRun.id}
						minWidth={800}
					/>
				</section>

				<InspectorPanel subtitle={selectedRun.id} title={selectedRun.title}>
					<InspectorSection title="Execution">
						<div className="grid grid-cols-2 gap-2">
							<div className="rounded-md bg-field p-3">
								<p className="text-xs text-text-subtle">Status</p>
								<div className="mt-2">
									<StatusBadge status={selectedRun.status} />
								</div>
							</div>
							<div className="rounded-md bg-field p-3">
								<p className="text-xs text-text-subtle">Duration</p>
								<p className="mt-2 font-mono text-sm text-text">{selectedRun.duration}</p>
							</div>
							<div className="rounded-md bg-field p-3">
								<p className="text-xs text-text-subtle">Confidence</p>
								<p className="mt-2 font-mono text-sm text-text">{Math.round(selectedRun.confidence * 100)}%</p>
							</div>
							<div className="rounded-md bg-field p-3">
								<p className="text-xs text-text-subtle">Findings</p>
								<p className="mt-2 font-mono text-sm text-text">{selectedRun.findings}</p>
							</div>
						</div>
						{selectedRun.error ? (
							<div className="mt-3 rounded-md border border-danger/20 bg-danger-soft p-3 text-sm text-danger">
								<div className="flex items-start gap-2">
									<AlertCircle className="mt-0.5 size-4 shrink-0" />
									<p>{selectedRun.error}</p>
								</div>
							</div>
						) : null}
					</InspectorSection>

					<InspectorSection title="Timeline">
						<div className="space-y-3">
							{selectedRun.timeline.map((event) => (
								<div className="grid grid-cols-[44px_1fr] gap-3" key={`${selectedRun.id}-${event.time}-${event.label}`}>
									<span className="font-mono text-xs text-text-subtle">{event.time}</span>
									<div className="border-l border-border pl-3">
										<div className="flex items-center gap-2">
											<Clock className="size-3.5 text-text-subtle" />
											<p className="text-sm font-medium text-text">{event.label}</p>
										</div>
										<p className="mt-1 text-xs text-text-muted">{event.detail}</p>
									</div>
								</div>
							))}
						</div>
					</InspectorSection>

					<InspectorSection title="Artifacts">
						<div className="space-y-2">
							{selectedRun.artifacts.map((artifact) => (
								<div
									className="flex items-center justify-between gap-3 rounded-md border border-border bg-panel-raised px-3 py-2"
									key={artifact.name}
								>
									<div className="min-w-0">
										<p className="truncate font-mono text-xs text-text">{artifact.name}</p>
										<p className="text-xs text-text-subtle">{artifact.type}</p>
									</div>
									<span className="font-mono text-xs text-text-muted">{artifact.size}</span>
								</div>
							))}
						</div>
					</InspectorSection>

					<InspectorSection title="Query">
						<p className="rounded-md border border-border bg-panel-raised p-3 text-sm text-text-muted">
							{selectedRun.query}
						</p>
					</InspectorSection>

					<InspectorSection title="Parameters">
						<CodeBlock value={selectedRun.params} />
					</InspectorSection>
				</InspectorPanel>
			</div>
		</>
	);
}
