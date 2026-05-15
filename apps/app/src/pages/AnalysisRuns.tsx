import type { TFunction } from 'i18next';
import { AlertCircle, ChevronDown, ChevronRight, Clock, Download, Filter, PlayCircle } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router-dom';
import { CodeBlock } from '@/components/CodeBlock';
import { type DataColumn, DataTable } from '@/components/DataTable';
import { IconButton } from '@/components/IconButton';
import { InspectorPanel, InspectorSection } from '@/components/InspectorPanel';
import { PageHeader } from '@/components/PageHeader';
import { SearchInput } from '@/components/SearchInput';
import { StateNotice } from '@/components/StateNotice';
import { StatusBadge } from '@/components/StatusBadge';
import { Tabs } from '@/components/Tabs';
import { SelectControl, Toolbar } from '@/components/Toolbar';
import { useDocumentObservability } from '@/features/documents/useDocumentObservability';
import { useJob } from '@/features/jobs/useJob';
import { useJobs } from '@/features/jobs/useJobs';
import type { DocumentObservabilityResponse, JobProgress } from '@/lib/api-types';
import { getRetryAfterDelayMs, STABLE_POLL_INTERVAL_MS } from '@/lib/polling';
import { getErrorMessage, isApiUnavailableError } from '@/lib/query-state';
import type { AnalysisRun, RunStatus } from '@/lib/types';
import { jobDetailToAnalysisRun, jobToAnalysisRun } from '@/lib/view-models';

function formatElapsedSince(value: string | null | undefined, locale: string) {
	if (!value) return '—';
	const startedAt = new Date(value).getTime();
	if (Number.isNaN(startedAt)) return '—';
	const totalMinutes = Math.max(1, Math.round((Date.now() - startedAt) / 60000));
	if (locale.startsWith('de')) {
		if (totalMinutes < 60) return `${totalMinutes} Min.`;
		const hours = Math.floor(totalMinutes / 60);
		const minutes = totalMinutes % 60;
		if (hours < 24) return minutes > 0 ? `${hours} Std. ${minutes} Min.` : `${hours} Std.`;
		const days = Math.floor(hours / 24);
		const remainingHours = hours % 24;
		return remainingHours > 0 ? `${days} T. ${remainingHours} Std.` : `${days} T.`;
	}
	if (totalMinutes < 60) return `${totalMinutes} min`;
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	if (hours < 24) return minutes > 0 ? `${hours} h ${minutes} min` : `${hours} h`;
	const days = Math.floor(hours / 24);
	const remainingHours = hours % 24;
	return remainingHours > 0 ? `${days} d ${remainingHours} h` : `${days} d`;
}

function formatDateTime(value: string | null | undefined, locale: string) {
	if (!value) return '—';
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	return new Intl.DateTimeFormat(locale, {
		month: 'short',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
	}).format(date);
}

const orderedPipelineSteps = ['quality', 'extract', 'segment', 'enrich', 'embed', 'graph', 'analyze'] as const;

function formatPipelineStep(step: string, t: TFunction) {
	return t(`pipelineSteps.${step}`, { defaultValue: step });
}

function buildDisplaySteps(steps: DocumentObservabilityResponse['data']['source']['steps']) {
	const byName = new Map(steps.map((step) => [step.step, step]));
	const ordered = orderedPipelineSteps.map(
		(step) =>
			byName.get(step) ?? {
				completed_at: null,
				error_message: null,
				status: 'pending' as const,
				step,
			},
	);
	const extras = steps.filter(
		(step) => !orderedPipelineSteps.includes(step.step as (typeof orderedPipelineSteps)[number]),
	);
	return [...ordered, ...extras];
}

function ProcessingDocuments({
	expandedSourceId,
	locale,
	onToggleSource,
	progress,
}: {
	expandedSourceId?: string;
	locale: string;
	onToggleSource: (sourceId: string) => void;
	progress: JobProgress | null | undefined;
}) {
	const { t } = useTranslation();
	const observabilityQuery = useDocumentObservability(expandedSourceId);
	const expandedSteps = observabilityQuery.data?.data.source.steps ?? [];

	if (!progress || progress.sources.length === 0) {
		return <p className="text-sm text-text-muted">{t('runs.noDocumentProgress')}</p>;
	}

	return (
		<div className="space-y-2">
			{progress.sources.map((source) => {
				const expanded = expandedSourceId === source.source_id;
				const displaySteps = expanded ? buildDisplaySteps(expandedSteps) : [];
				return (
					<div className="rounded-md border border-border bg-panel-raised" key={source.source_id}>
						<button
							className="flex w-full items-start gap-3 p-3 text-left transition-colors hover:bg-field"
							onClick={() => onToggleSource(source.source_id)}
							type="button"
						>
							{expanded ? (
								<ChevronDown className="mt-0.5 size-4 shrink-0 text-text-subtle" />
							) : (
								<ChevronRight className="mt-0.5 size-4 shrink-0 text-text-subtle" />
							)}
							<div className="min-w-0 flex-1">
								<div className="flex flex-wrap items-center gap-2">
									<p className="truncate text-sm font-medium text-text">
										{source.source?.filename ?? t('runs.sourceNotVisible')}
									</p>
									<StatusBadge status={source.status} />
								</div>
								<p className="mt-1 truncate text-xs text-text-muted">
									{t('runs.currentStep')}: {formatPipelineStep(source.current_step, t)}
								</p>
								<p className="mt-1 text-xs text-text-subtle">
									{t('runs.lastActivity')}: {formatDateTime(source.updated_at, locale)} · {t('runs.elapsed')}:{' '}
									{formatElapsedSince(source.updated_at, locale)}
								</p>
								{source.error_message ? <p className="mt-1 text-xs text-danger">{source.error_message}</p> : null}
							</div>
						</button>
						{expanded ? (
							<div className="border-t border-border p-3">
								<div className="mb-3 flex items-center justify-between gap-3">
									<p className="text-xs font-medium text-text-subtle">{t('runs.pipelineSteps')}</p>
									<Link className="text-xs font-medium text-accent hover:underline" to={`/sources/${source.source_id}`}>
										{t('runs.openSource')}
									</Link>
								</div>
								{observabilityQuery.isLoading ? (
									<StateNotice tone="loading" title={t('runs.detailLoadingTitle')} />
								) : null}
								{observabilityQuery.error ? (
									<StateNotice
										tone="error"
										title={
											isApiUnavailableError(observabilityQuery.error)
												? t('runs.detailUnavailableTitle')
												: t('runs.detailErrorTitle')
										}
									>
										{getErrorMessage(observabilityQuery.error, t('common.apiRequestFailed'))}
									</StateNotice>
								) : null}
								{displaySteps.length > 0 ? (
									<div className="space-y-2">
										{displaySteps.map((step) => (
											<div
												className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 rounded-md bg-panel px-3 py-2"
												key={`${source.source_id}-${step.step}`}
											>
												<div className="min-w-0">
													<p className="truncate text-sm text-text">{formatPipelineStep(step.step, t)}</p>
													<p className="mt-1 text-xs text-text-subtle">
														{step.completed_at
															? `${t('runs.completed')}: ${formatDateTime(step.completed_at, locale)} · ${t('runs.elapsed')}: ${formatElapsedSince(step.completed_at, locale)}`
															: t('runs.stepWaiting')}
													</p>
													{step.error_message ? <p className="mt-1 text-xs text-danger">{step.error_message}</p> : null}
												</div>
												<StatusBadge status={step.status} />
											</div>
										))}
									</div>
								) : !observabilityQuery.isLoading && !observabilityQuery.error ? (
									<p className="text-sm text-text-muted">{t('runs.noPipelineSteps')}</p>
								) : null}
							</div>
						) : null}
					</div>
				);
			})}
		</div>
	);
}

function getRunColumns(t: TFunction): DataColumn<AnalysisRun>[] {
	return [
		{
			key: 'run',
			header: t('runs.tableRun'),
			render: (run) => (
				<div className="min-w-0">
					<p className="truncate font-medium text-text">{run.title}</p>
					<p className="mt-1 truncate font-mono text-xs text-text-subtle">{run.id}</p>
				</div>
			),
		},
		{
			key: 'status',
			header: t('common.status'),
			className: 'w-32',
			render: (run) => <StatusBadge status={run.status} />,
		},
		{ key: 'mode', header: t('common.mode'), render: (run) => <span className="text-text-muted">{run.mode}</span> },
		{
			key: 'corpus',
			header: t('runs.tableCorpus'),
			render: (run) => <span className="text-text-muted">{run.corpus}</span>,
		},
		{
			key: 'progress',
			header: t('runs.tableProgress'),
			render: (run) => (
				<div className="flex items-center gap-3">
					{run.progress === null ? (
						<span className="font-mono text-xs text-text-subtle">{t('common.notExposed')}</span>
					) : (
						<>
							<div className="h-1.5 w-24 overflow-hidden rounded-xs bg-field">
								<div className="h-full rounded-xs bg-accent" style={{ width: `${run.progress}%` }} />
							</div>
							<span className="font-mono text-xs text-text-muted">{run.progress}%</span>
						</>
					)}
				</div>
			),
		},
		{
			key: 'attempts',
			header: t('runs.tableAttempts'),
			className: 'w-24',
			render: (run) => <span className="font-mono">{run.attempts}</span>,
		},
		{
			key: 'started',
			header: t('common.started'),
			className: 'w-32',
			render: (run) => <span className="font-mono text-xs">{run.startedAt}</span>,
		},
	];
}

export function AnalysisRunsPage() {
	const { t, i18n } = useTranslation();
	const [searchParams] = useSearchParams();
	const [status, setStatus] = useState<RunStatus | 'all'>('all');
	const [query, setQuery] = useState('');
	const [selectedId, setSelectedId] = useState<string | undefined>();
	const [expandedSourceId, setExpandedSourceId] = useState<string | undefined>();
	const jobsQuery = useJobs({ limit: 50 });
	const viewModelContext = useMemo(() => ({ locale: i18n.language, t }), [i18n.language, t]);

	const runs = useMemo(
		() => (jobsQuery.data?.data ?? []).map((job) => jobToAnalysisRun(job, viewModelContext)),
		[jobsQuery.data, viewModelContext],
	);
	const tabs = useMemo(
		() => [
			{ value: 'all', label: t('runs.tabAll'), count: runs.length },
			{ value: 'queued', label: t('runs.tabQueued'), count: runs.filter((run) => run.status === 'queued').length },
			{ value: 'running', label: t('runs.tabRunning'), count: runs.filter((run) => run.status === 'running').length },
			{
				value: 'completed',
				label: t('runs.tabCompleted'),
				count: runs.filter((run) => run.status === 'completed').length,
			},
			{ value: 'failed', label: t('runs.tabFailed'), count: runs.filter((run) => run.status === 'failed').length },
		],
		[runs, t],
	);

	const filteredRuns = useMemo(() => {
		return runs.filter((run) => {
			const statusMatch = status === 'all' || run.status === status;
			const queryMatch = `${run.title} ${run.id} ${run.mode} ${run.corpus}`.toLowerCase().includes(query.toLowerCase());
			return statusMatch && queryMatch;
		});
	}, [query, runs, status]);

	useEffect(() => {
		const jobId = searchParams.get('job');
		if (jobId) {
			setSelectedId(jobId);
			setExpandedSourceId(undefined);
		}
	}, [searchParams]);

	const selectedListRun =
		filteredRuns.find((run) => run.id === selectedId) ?? runs.find((run) => run.id === selectedId) ?? filteredRuns[0];
	const selectedJobId = selectedListRun?.id ?? selectedId;
	const selectedJobQuery = useJob(selectedJobId, {
		refetchInterval: (query) => {
			if (!selectedJobId) return false;
			if (query.state.error) return getRetryAfterDelayMs(query.state.error, STABLE_POLL_INTERVAL_MS);
			const status = query.state.data?.data.job.status;
			if (!status) return STABLE_POLL_INTERVAL_MS;
			return status === 'pending' || status === 'running' ? STABLE_POLL_INTERVAL_MS : false;
		},
	});
	const selectedRun = selectedJobQuery.data
		? jobDetailToAnalysisRun(selectedJobQuery.data.data, viewModelContext)
		: selectedListRun;
	const selectedProgress = selectedJobQuery.data?.data.progress;
	const runColumns = getRunColumns(t);
	const hasRunFilters = query.trim().length > 0 || status !== 'all';
	const runTableRows = jobsQuery.error ? [] : filteredRuns;
	const runTableEmptyMessage = jobsQuery.error
		? t('runs.processingUnavailableShort')
		: jobsQuery.isLoading
			? t('runs.noJobsLoaded')
			: runs.length === 0
				? t('runs.noProcessingRecords')
				: hasRunFilters
					? t('runs.noMatchingJobs')
					: t('runs.noProcessingRecords');

	return (
		<>
			<PageHeader
				actions={
					<>
						<button
							className="inline-flex h-9 items-center gap-2 rounded-md border border-border bg-panel px-3 text-sm text-text transition-colors hover:bg-field"
							disabled
							title={t('runs.exportTitle')}
							type="button"
						>
							<Download className="size-4" />
							{t('runs.export')}
						</button>
						<button
							className="inline-flex h-9 items-center gap-2 rounded-md bg-field px-3 text-sm font-medium text-text-subtle"
							disabled
							title={t('runs.newRunTitle')}
							type="button"
						>
							<PlayCircle className="size-4" />
							{t('runs.processSources')}
						</button>
					</>
				}
				description={t('runs.description')}
				eyebrow={t('runs.eyebrow')}
				title={t('runs.title')}
			/>

			<div className="grid gap-4 p-4 sm:p-6 xl:grid-cols-[minmax(0,1fr)_340px]">
				<section className="panel min-w-0 overflow-hidden">
					{jobsQuery.isLoading ? (
						<div className="border-b border-border p-3">
							<StateNotice tone="loading" title={t('runs.loadingTitle')} />
						</div>
					) : null}
					{jobsQuery.error ? (
						<div className="border-b border-border p-3">
							<StateNotice
								tone="error"
								title={
									isApiUnavailableError(jobsQuery.error) ? t('runs.processingUnavailableTitle') : t('runs.errorTitle')
								}
							>
								{getErrorMessage(jobsQuery.error, t('common.apiRequestFailed'))}
							</StateNotice>
						</div>
					) : null}
					<Toolbar className="gap-3">
						<SearchInput
							className="w-full sm:max-w-sm"
							onChange={(event) => setQuery(event.target.value)}
							placeholder={t('runs.filterPlaceholder')}
							value={query}
						/>
						<SelectControl disabled label={t('common.mode')} title={t('runs.modeFilterTitle')}>
							{t('common.any')}
							<ChevronDown className="size-3.5 text-text-subtle" />
						</SelectControl>
						<SelectControl disabled label={t('common.owner')} title={t('runs.ownerFilterTitle')}>
							{t('common.all')}
							<ChevronDown className="size-3.5 text-text-subtle" />
						</SelectControl>
						<IconButton disabled label={t('common.advancedFilters')} title={t('runs.advancedFiltersTitle')}>
							<Filter className="size-4" />
						</IconButton>
					</Toolbar>

					<div className="border-b border-border p-3">
						<Tabs onChange={(value) => setStatus(value as RunStatus | 'all')} tabs={tabs} value={status} />
					</div>

					<DataTable
						columns={runColumns}
						emptyMessage={runTableEmptyMessage}
						getRowKey={(run) => run.id}
						onRowClick={(run) => {
							setSelectedId(run.id);
							setExpandedSourceId(undefined);
						}}
						rows={runTableRows}
						selectedKey={selectedRun?.id}
						minWidth={800}
					/>
				</section>

				{selectedRun ? (
					<InspectorPanel subtitle={selectedRun.id} title={selectedRun.title}>
						{selectedJobQuery.isLoading ? (
							<div className="mb-3">
								<StateNotice tone="loading" title={t('runs.detailLoadingTitle')} />
							</div>
						) : null}
						{selectedJobQuery.error ? (
							<div className="mb-3">
								<StateNotice
									tone="error"
									title={
										isApiUnavailableError(selectedJobQuery.error)
											? t('runs.detailUnavailableTitle')
											: t('runs.detailErrorTitle')
									}
								>
									{getErrorMessage(selectedJobQuery.error, t('common.apiRequestFailed'))}
								</StateNotice>
							</div>
						) : null}
						<InspectorSection title={t('runs.documents')}>
							<ProcessingDocuments
								expandedSourceId={expandedSourceId}
								locale={i18n.language}
								onToggleSource={(sourceId) => setExpandedSourceId(expandedSourceId === sourceId ? undefined : sourceId)}
								progress={selectedProgress}
							/>
						</InspectorSection>
						<InspectorSection title={t('runs.execution')}>
							<div className="grid grid-cols-2 gap-2">
								<div className="rounded-md bg-field p-3">
									<p className="text-xs text-text-subtle">{t('common.status')}</p>
									<div className="mt-2">
										<StatusBadge status={selectedRun.status} />
									</div>
								</div>
								<div className="rounded-md bg-field p-3">
									<p className="text-xs text-text-subtle">{t('runs.duration')}</p>
									<p className="mt-2 font-mono text-sm text-text">{selectedRun.duration}</p>
								</div>
								<div className="rounded-md bg-field p-3">
									<p className="text-xs text-text-subtle">{t('runs.confidence')}</p>
									<p className="mt-2 font-mono text-sm text-text">
										{selectedRun.confidence === null
											? t('common.notExposed')
											: `${Math.round(selectedRun.confidence * 100)}%`}
									</p>
								</div>
								<div className="rounded-md bg-field p-3">
									<p className="text-xs text-text-subtle">{t('runs.findings')}</p>
									<p className="mt-2 font-mono text-sm text-text">{selectedRun.findings ?? t('common.notExposed')}</p>
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

						<InspectorSection title={t('runs.timeline')}>
							<div className="space-y-3">
								{selectedRun.timeline.map((event) => (
									<div
										className="grid grid-cols-[44px_1fr] gap-3"
										key={`${selectedRun.id}-${event.time}-${event.label}`}
									>
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

						<InspectorSection title={t('runs.artifacts')}>
							{selectedRun.artifacts.length > 0 ? (
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
							) : (
								<p className="text-sm text-text-muted">{t('runs.noArtifacts')}</p>
							)}
						</InspectorSection>

						<InspectorSection title={t('runs.query')}>
							<p className="rounded-md border border-border bg-panel-raised p-3 text-sm text-text-muted">
								{selectedRun.query}
							</p>
						</InspectorSection>

						<InspectorSection title={t('runs.parameters')}>
							<CodeBlock label={t('runs.jobPayloadLabel')} value={selectedRun.params} />
						</InspectorSection>
					</InspectorPanel>
				) : (
					<InspectorPanel title={t('runs.noJobSelected')}>
						<StateNotice title={t('runs.noJobsLoadedTitle')}>{t('runs.noJobsLoadedBody')}</StateNotice>
					</InspectorPanel>
				)}
			</div>
		</>
	);
}
