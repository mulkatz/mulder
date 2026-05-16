import type { TFunction } from 'i18next';
import { AlertCircle, ChevronDown, ChevronRight, Clock, Download, Filter, PlayCircle } from 'lucide-react';
import { Fragment, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router-dom';
import { CodeBlock } from '@/components/CodeBlock';
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
import { cn } from '@/lib/cn';
import { getRetryAfterDelayMs, STABLE_POLL_INTERVAL_MS } from '@/lib/polling';
import {
	buildDocumentProcessingSteps,
	buildDocumentTranslationSteps,
	createDocumentProcessingGroups,
	currentStepForDocument,
	DOCUMENT_PROCESSING_STEPS,
	type DocumentProcessingCurrentStep,
	type DocumentProcessingGroup,
	type DocumentProcessingStepName,
	findDocumentGroupForJob,
	preferredJobIdForGroup,
	progressSourceForGroup,
} from '@/lib/processing-view-models';
import { getErrorMessage, isApiUnavailableError } from '@/lib/query-state';
import type { RunStatus } from '@/lib/types';
import { jobDetailToAnalysisRun } from '@/lib/view-models';

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

function formatPipelineStep(step: string, t: TFunction) {
	return t(`pipelineSteps.${step}`, { defaultValue: step });
}

function formatDocumentProcessingStep(step: DocumentProcessingStepName, t: TFunction) {
	if (step === 'upload') return t('runs.uploadStep');
	return formatPipelineStep(step, t);
}

function formatCurrentStep(step: DocumentProcessingCurrentStep, t: TFunction) {
	if (step === 'analyze_pending') return t('runs.analyzePendingStep');
	if (step === 'completed') return t('status.completed');
	if (step === 'processing') return t('runs.processingStep');
	if (step === 'translation') return t('runs.translationStep');
	if (step === 'unknown') return t('common.unknown');
	return formatDocumentProcessingStep(step, t);
}

function formatTranslationStepLabel(label: string, t: TFunction) {
	if (label === 'translate') return t('runs.translationStep');
	return label;
}

function formatRelativeActivity(value: string | null | undefined, locale: string) {
	if (!value) return '—';
	const startedAt = new Date(value).getTime();
	if (Number.isNaN(startedAt)) return '—';
	const totalMinutes = Math.max(1, Math.round((Date.now() - startedAt) / 60000));
	if (locale.startsWith('de')) {
		if (totalMinutes < 60) return `vor ${totalMinutes} Min.`;
		const hours = Math.floor(totalMinutes / 60);
		if (hours < 24) return `vor ${hours} Std.`;
		const days = Math.floor(hours / 24);
		return `vor ${days} T.`;
	}
	if (totalMinutes < 60) return `${totalMinutes} min ago`;
	const hours = Math.floor(totalMinutes / 60);
	if (hours < 24) return `${hours} h ago`;
	const days = Math.floor(hours / 24);
	return `${days} d ago`;
}

function buildDisplaySteps(steps: DocumentObservabilityResponse['data']['source']['steps']) {
	const byName = new Map(steps.map((step) => [step.step, step]));
	const ordered = DOCUMENT_PROCESSING_STEPS.filter((step) => step !== 'upload').map(
		(step) =>
			byName.get(step) ?? {
				completed_at: null,
				error_message: null,
				status: 'pending' as const,
				step,
			},
	);
	const extras = steps.filter(
		(step) => !DOCUMENT_PROCESSING_STEPS.includes(step.step as (typeof DOCUMENT_PROCESSING_STEPS)[number]),
	);
	return [...ordered, ...extras];
}

function Stepper({ group, progress }: { group: DocumentProcessingGroup; progress: JobProgress | null | undefined }) {
	const { t } = useTranslation();
	const progressSource = progressSourceForGroup(progress, group);
	const steps = buildDocumentProcessingSteps(group, { progressSource });

	return (
		<div className="flex flex-wrap gap-1.5" title={t('runs.pipelineSteps')}>
			{steps.map((step) => (
				<span
					aria-label={`${formatDocumentProcessingStep(step.name, t)}: ${t(`status.${step.status}`, {
						defaultValue: step.status,
					})}`}
					className={cn(
						'h-2.5 w-2.5 rounded-full bg-field ring-1 ring-border',
						step.status === 'completed' && 'bg-success ring-success/40',
						step.status === 'running' && 'bg-info ring-info/40',
						step.status === 'failed' && 'bg-danger ring-danger/40',
						step.status === 'skipped' && 'bg-warning ring-warning/40',
						step.status === 'partial' && 'bg-warning ring-warning/40',
					)}
					key={`${group.id}-${step.name}`}
					role="img"
					title={`${formatDocumentProcessingStep(step.name, t)}: ${t(`status.${step.status}`, {
						defaultValue: step.status,
					})}`}
				/>
			))}
		</div>
	);
}

function DocumentStepsPanel({
	group,
	locale,
	progress,
	steps,
}: {
	group: DocumentProcessingGroup;
	locale: string;
	progress: JobProgress | null | undefined;
	steps: DocumentObservabilityResponse['data']['source']['steps'];
}) {
	const { t } = useTranslation();
	const progressSource = progressSourceForGroup(progress, group);
	const displaySteps = buildDocumentProcessingSteps(group, {
		observabilitySteps: buildDisplaySteps(steps),
		progressSource,
	});
	const translationSteps = buildDocumentTranslationSteps(group);

	return (
		<div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_240px]">
			<div className="space-y-2">
				{displaySteps.map((step) => (
					<div
						className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 rounded-md bg-panel px-3 py-2"
						key={`${group.id}-${step.name}`}
					>
						<div className="min-w-0">
							<p className="truncate text-sm text-text">{formatDocumentProcessingStep(step.name, t)}</p>
							<p className="mt-1 text-xs text-text-subtle">
								{step.activityAt
									? `${formatDateTime(step.activityAt, locale)} · ${formatRelativeActivity(step.activityAt, locale)}`
									: t('runs.stepWaiting')}
							</p>
							{step.errorMessage ? <p className="mt-1 text-xs text-danger">{step.errorMessage}</p> : null}
						</div>
						<div className="flex items-center gap-2">
							{step.attempts ? <span className="font-mono text-xs text-text-subtle">{step.attempts}</span> : null}
							<StatusBadge status={step.status} />
						</div>
					</div>
				))}
				{translationSteps.length > 0 ? (
					<div className="mt-3 border-t border-border pt-3">
						<p className="mb-2 text-xs font-medium text-text-subtle">{t('runs.translationSteps')}</p>
						<div className="space-y-2">
							{translationSteps.map((step) => (
								<div className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 rounded-md bg-panel px-3 py-2" key={step.id}>
									<div className="min-w-0">
										<p className="truncate text-sm text-text">{formatTranslationStepLabel(step.label, t)}</p>
										<p className="mt-1 text-xs text-text-subtle">
											{formatDateTime(step.activityAt, locale)} · {formatRelativeActivity(step.activityAt, locale)}
										</p>
										{step.errorMessage ? <p className="mt-1 text-xs text-danger">{step.errorMessage}</p> : null}
									</div>
									<div className="flex items-center gap-2">
										<span className="font-mono text-xs text-text-subtle">{step.attempts}</span>
										<StatusBadge status={step.status} />
									</div>
								</div>
							))}
						</div>
					</div>
				) : null}
			</div>
			<div className="space-y-2">
				{group.sourceId ? (
					<Link
						className="block rounded-md border border-border bg-panel px-3 py-2 text-sm font-medium text-accent transition-colors hover:bg-field"
						to={`/sources/${group.sourceId}`}
					>
						{t('runs.openSource')}
					</Link>
				) : null}
				<button
					className="w-full rounded-md border border-border bg-panel px-3 py-2 text-left text-sm font-medium text-text-subtle"
					disabled
					title={t('runs.retryUnavailableTitle')}
					type="button"
				>
					{t('runs.retryProcessing')}
				</button>
				<div className="rounded-md border border-border bg-panel px-3 py-2">
					<p className="text-xs font-medium text-text-subtle">{t('runs.documentJobs')}</p>
					<p className="mt-1 font-mono text-sm text-text">{group.jobs.length}</p>
				</div>
			</div>
		</div>
	);
}

function DocumentProcessingTable({
	emptyMessage,
	expandedDocumentId,
	groups,
	locale,
	onOpenDetails,
	selectedDocumentId,
	selectedProgress,
}: {
	emptyMessage: string;
	expandedDocumentId?: string;
	groups: DocumentProcessingGroup[];
	locale: string;
	onOpenDetails: (group: DocumentProcessingGroup) => void;
	selectedDocumentId?: string;
	selectedProgress: JobProgress | null | undefined;
}) {
	const { t } = useTranslation();
	const expandedGroup = groups.find((group) => group.id === expandedDocumentId);
	const expandedSourceId = expandedGroup?.sourceId;
	const observabilityQuery = useDocumentObservability(expandedSourceId);
	const expandedSteps = observabilityQuery.data?.data.source.steps ?? [];

	if (groups.length === 0) {
		return <p className="px-4 py-8 text-center text-sm text-text-muted">{emptyMessage}</p>;
	}

	return (
		<div className="overflow-x-auto">
			<table className="w-full min-w-[980px] border-collapse text-left">
				<thead>
					<tr className="border-b border-border bg-panel-raised">
						<th className="px-4 py-3 text-xs font-medium text-text-subtle" scope="col">
							{t('runs.tableDocument')}
						</th>
						<th className="w-32 px-4 py-3 text-xs font-medium text-text-subtle" scope="col">
							{t('common.status')}
						</th>
						<th className="px-4 py-3 text-xs font-medium text-text-subtle" scope="col">
							{t('runs.tableCurrentStep')}
						</th>
						<th className="px-4 py-3 text-xs font-medium text-text-subtle" scope="col">
							{t('runs.tableProgress')}
						</th>
						<th className="w-36 px-4 py-3 text-xs font-medium text-text-subtle" scope="col">
							{t('runs.tableLastActivity')}
						</th>
						<th className="w-44 px-4 py-3 text-xs font-medium text-text-subtle" scope="col">
							{t('runs.tableActions')}
						</th>
					</tr>
				</thead>
				<tbody>
					{groups.map((group) => {
						const expanded = group.id === expandedDocumentId;
						const selected = group.id === selectedDocumentId;
						const rowProgress = selected || expanded ? selectedProgress : null;
						const progressSource = progressSourceForGroup(rowProgress, group);
						const currentStep = formatCurrentStep(
							currentStepForDocument(group, {
								observabilitySteps: expanded ? buildDisplaySteps(expandedSteps) : undefined,
								progressSource,
							}),
							t,
						);
						return (
							<Fragment key={group.id}>
								<tr
									className={cn(
										'border-b border-border transition-colors',
										selected && 'bg-accent-soft',
										expanded && 'border-b-0',
									)}
								>
									<td className="px-4 py-3 align-top">
										<div className="flex min-w-0 items-start gap-3">
											<button
												className="mt-0.5 rounded-sm text-text-subtle transition-colors hover:text-text"
												onClick={() => onOpenDetails(group)}
												title={expanded ? t('runs.collapseDetails') : t('runs.expandDetails')}
												type="button"
											>
												{expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
											</button>
											<div className="min-w-0">
												<p className="truncate text-sm font-medium text-text">{group.title}</p>
												<p className="mt-1 truncate font-mono text-xs text-text-subtle">
													{group.sourceId ?? group.latestJob.job.id}
												</p>
											</div>
										</div>
									</td>
									<td className="px-4 py-3 align-top">
										<StatusBadge status={group.status} />
									</td>
									<td className="px-4 py-3 align-top text-sm text-text-muted">
										<p>{currentStep}</p>
										{progressSource?.error_message ? (
											<p className="mt-1 text-xs text-danger">{progressSource.error_message}</p>
										) : null}
									</td>
									<td className="px-4 py-3 align-top">
										<Stepper group={group} progress={rowProgress} />
									</td>
									<td className="px-4 py-3 align-top">
										<p className="text-sm text-text">{formatRelativeActivity(group.lastActivity, locale)}</p>
										<p className="mt-1 font-mono text-xs text-text-subtle">
											{formatDateTime(group.lastActivity, locale)}
										</p>
									</td>
									<td className="px-4 py-3 align-top">
										<div className="flex flex-wrap items-center gap-2">
											<button
												className="rounded-md border border-border bg-panel px-2.5 py-1 text-xs font-medium text-text transition-colors hover:bg-field"
												onClick={() => onOpenDetails(group)}
												type="button"
											>
												{t('runs.details')}
											</button>
											{group.sourceId ? (
												<Link
													className="rounded-md border border-border bg-panel px-2.5 py-1 text-xs font-medium text-accent transition-colors hover:bg-field"
													to={`/sources/${group.sourceId}`}
												>
													{t('runs.openSource')}
												</Link>
											) : null}
											<button
												className="rounded-md border border-border bg-panel px-2.5 py-1 text-xs font-medium text-text-subtle"
												disabled
												title={t('runs.retryUnavailableTitle')}
												type="button"
											>
												{t('runs.retry')}
											</button>
										</div>
									</td>
								</tr>
								{expanded ? (
									<tr className="border-b border-border bg-panel-raised">
										<td className="px-4 py-4" colSpan={6}>
											{observabilityQuery.isLoading ? (
												<div className="mb-3">
													<StateNotice tone="loading" title={t('runs.detailLoadingTitle')} />
												</div>
											) : null}
											{observabilityQuery.error ? (
												<div className="mb-3">
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
												</div>
											) : null}
											<DocumentStepsPanel
												group={group}
												locale={locale}
												progress={selectedProgress}
												steps={expandedSteps}
											/>
										</td>
									</tr>
								) : null}
							</Fragment>
						);
					})}
				</tbody>
			</table>
		</div>
	);
}

export function AnalysisRunsPage() {
	const { t, i18n } = useTranslation();
	const [searchParams] = useSearchParams();
	const [status, setStatus] = useState<RunStatus | 'all'>('all');
	const [query, setQuery] = useState('');
	const [selectedDocumentId, setSelectedDocumentId] = useState<string | undefined>();
	const [expandedDocumentId, setExpandedDocumentId] = useState<string | undefined>();
	const [selectedJobId, setSelectedJobId] = useState<string | undefined>();
	const jobsQuery = useJobs({ limit: 50 });
	const viewModelContext = useMemo(() => ({ locale: i18n.language, t }), [i18n.language, t]);

	const documentGroups = useMemo(
		() => createDocumentProcessingGroups(jobsQuery.data?.data ?? [], viewModelContext),
		[jobsQuery.data, viewModelContext],
	);
	const tabs = useMemo(
		() => [
			{ value: 'all', label: t('runs.tabAll'), count: documentGroups.length },
			{
				value: 'queued',
				label: t('runs.tabQueued'),
				count: documentGroups.filter((group) => group.status === 'queued').length,
			},
			{
				value: 'running',
				label: t('runs.tabRunning'),
				count: documentGroups.filter((group) => group.status === 'running').length,
			},
			{
				value: 'completed',
				label: t('runs.tabCompleted'),
				count: documentGroups.filter((group) => group.status === 'completed').length,
			},
			{
				value: 'failed',
				label: t('runs.tabFailed'),
				count: documentGroups.filter((group) => group.status === 'failed').length,
			},
		],
		[documentGroups, t],
	);

	const filteredGroups = useMemo(() => {
		return documentGroups.filter((group) => {
			const statusMatch = status === 'all' || group.status === status;
			const haystack = [
				group.title,
				group.sourceId,
				group.currentStep,
				...group.jobs.flatMap(({ job, run }) => [job.id, job.type, run.mode]),
			]
				.filter(Boolean)
				.join(' ')
				.toLowerCase();
			const queryMatch = haystack.includes(query.toLowerCase());
			return statusMatch && queryMatch;
		});
	}, [documentGroups, query, status]);

	useEffect(() => {
		const jobId = searchParams.get('job');
		if (jobId) {
			setSelectedJobId(jobId);
		}
	}, [searchParams]);

	useEffect(() => {
		const jobId = searchParams.get('job');
		const group = findDocumentGroupForJob(documentGroups, jobId);
		if (!group) return;
		setSelectedDocumentId(group.id);
		setExpandedDocumentId(group.id);
		setSelectedJobId(jobId ?? preferredJobIdForGroup(group));
	}, [documentGroups, searchParams]);

	const selectedGroup =
		documentGroups.find((group) => group.id === selectedDocumentId) ?? filteredGroups[0] ?? documentGroups[0];
	const selectedJobBelongsToGroup = selectedGroup?.jobs.some(({ job }) => job.id === selectedJobId) ?? false;
	const selectedJobIdForQuery = selectedJobBelongsToGroup ? selectedJobId : preferredJobIdForGroup(selectedGroup);
	const selectedJobQuery = useJob(selectedJobIdForQuery, {
		refetchInterval: (query) => {
			if (!selectedJobIdForQuery) return false;
			if (query.state.error) return getRetryAfterDelayMs(query.state.error, STABLE_POLL_INTERVAL_MS);
			const status = query.state.data?.data.job.status;
			if (!status) return STABLE_POLL_INTERVAL_MS;
			return status === 'pending' || status === 'running' ? STABLE_POLL_INTERVAL_MS : false;
		},
	});
	const selectedRun = selectedJobQuery.data
		? jobDetailToAnalysisRun(selectedJobQuery.data.data, viewModelContext)
		: (selectedGroup?.jobs.find(({ job }) => job.id === selectedJobIdForQuery)?.run ?? selectedGroup?.latestJob.run);
	const selectedProgress = selectedJobQuery.data?.data.progress;
	const hasRunFilters = query.trim().length > 0 || status !== 'all';
	const documentTableRows = jobsQuery.error ? [] : filteredGroups;
	const documentTableEmptyMessage = jobsQuery.error
		? t('runs.processingUnavailableShort')
		: jobsQuery.isLoading
			? t('runs.noJobsLoaded')
			: documentGroups.length === 0
				? t('runs.noProcessingRecords')
				: hasRunFilters
					? t('runs.noMatchingJobs')
					: t('runs.noProcessingRecords');
	const openDetails = (group: DocumentProcessingGroup) => {
		setSelectedDocumentId(group.id);
		setSelectedJobId(preferredJobIdForGroup(group));
		setExpandedDocumentId(expandedDocumentId === group.id ? undefined : group.id);
	};

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

					<DocumentProcessingTable
						emptyMessage={documentTableEmptyMessage}
						expandedDocumentId={expandedDocumentId}
						groups={documentTableRows}
						locale={i18n.language}
						onOpenDetails={openDetails}
						selectedDocumentId={selectedGroup?.id}
						selectedProgress={selectedProgress}
					/>
				</section>

				{selectedRun ? (
					<InspectorPanel
						subtitle={selectedGroup?.sourceId ?? selectedRun.id}
						title={selectedGroup?.title ?? selectedRun.title}
					>
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
							{selectedGroup ? (
								<div className="mt-3 rounded-md border border-border bg-panel-raised p-3">
									<p className="text-xs text-text-subtle">{t('runs.documentJobs')}</p>
									<p className="mt-2 font-mono text-sm text-text">{selectedGroup.jobs.length}</p>
								</div>
							) : null}
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
