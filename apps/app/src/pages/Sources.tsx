import type { TFunction } from 'i18next';
import { BookOpen, ChevronLeft, ChevronRight, FileText, Image, Plus, ShieldCheck } from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type DataColumn, DataTable } from '@/components/DataTable';
import { IconButton } from '@/components/IconButton';
import { InspectorPanel, InspectorSection } from '@/components/InspectorPanel';
import { PageHeader } from '@/components/PageHeader';
import { SearchInput } from '@/components/SearchInput';
import { StateNotice } from '@/components/StateNotice';
import { StatusBadge } from '@/components/StatusBadge';
import { Toolbar } from '@/components/Toolbar';
import { useDocumentObservability } from '@/features/documents/useDocumentObservability';
import { useDocumentStories } from '@/features/documents/useDocumentStories';
import { useDocuments } from '@/features/documents/useDocuments';
import type { DocumentRecord, SourceStatus } from '@/lib/api-types';
import { cn } from '@/lib/cn';
import { getErrorMessage, isApiUnavailableError } from '@/lib/query-state';

const PAGE_SIZE = 25;

const sourceStatuses = ['ingested', 'extracted', 'segmented', 'enriched', 'embedded', 'graphed', 'analyzed'] as const;

function formatDate(value: string, locale: string) {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	return new Intl.DateTimeFormat(locale, {
		month: 'short',
		day: '2-digit',
		year: 'numeric',
	}).format(date);
}

function formatPageRange(start: number | null, end: number | null, t: TFunction) {
	if (start === null && end === null) return t('common.notExposed');
	if (start !== null && end !== null && start !== end) return t('sources.pageRange', { start, end });
	return t('sources.singlePage', { page: start ?? end });
}

function getSourceColumns(t: TFunction, locale: string): DataColumn<DocumentRecord>[] {
	return [
		{
			key: 'source',
			header: t('sources.tableSource'),
			render: (source) => (
				<div className="min-w-0">
					<p className="truncate font-medium text-text">{source.filename}</p>
					<p className="mt-1 text-xs text-text-subtle">
						{source.layout_available ? t('sources.contentAvailable') : t('sources.contentNotAvailable')}
					</p>
				</div>
			),
		},
		{
			key: 'readiness',
			header: t('sources.tableReadiness'),
			className: 'w-40',
			render: (source) => <StatusBadge status={source.status} />,
		},
		{
			key: 'pages',
			header: t('sources.tablePages'),
			className: 'w-24',
			render: (source) => <span className="font-mono text-xs">{source.page_count ?? t('common.notExposed')}</span>,
		},
		{
			key: 'text',
			header: t('sources.tableText'),
			className: 'w-36',
			render: (source) => (
				<span className="text-text-muted">
					{source.has_native_text ? t('sources.nativeText') : t('sources.ocrOrImageText')}
				</span>
			),
		},
		{
			key: 'content',
			header: t('sources.tableContent'),
			className: 'w-44',
			render: (source) => (
				<span className="text-text-muted">
					{source.layout_available
						? t('sources.extractedContent')
						: source.page_image_count > 0
							? t('sources.pageImages', { count: source.page_image_count })
							: t('sources.contentNotAvailable')}
				</span>
			),
		},
		{
			key: 'updated',
			header: t('sources.tableUpdated'),
			className: 'w-36',
			render: (source) => <span className="font-mono text-xs">{formatDate(source.updated_at, locale)}</span>,
		},
	];
}

function SourceMetric({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
	return (
		<div className="rounded-md bg-field p-3">
			<div className="flex items-center gap-2 text-xs text-text-subtle">
				{icon}
				<span>{label}</span>
			</div>
			<p className="mt-2 text-sm font-medium text-text">{value}</p>
		</div>
	);
}

function SelectedSourceInspector({ source }: { source?: DocumentRecord }) {
	const { t, i18n } = useTranslation();
	const storiesQuery = useDocumentStories(source?.id);
	const observabilityQuery = useDocumentObservability(source?.id);
	const stories = storiesQuery.data?.data.stories ?? [];
	const observability = observabilityQuery.data?.data;

	if (!source) {
		return (
			<InspectorPanel title={t('sources.noSourceSelected')}>
				<StateNotice title={t('sources.noSourceSelectedTitle')}>{t('sources.noSourceSelectedBody')}</StateNotice>
			</InspectorPanel>
		);
	}

	return (
		<InspectorPanel subtitle={source.id} title={source.filename}>
			<InspectorSection title={t('sources.sourceOverview')}>
				<div className="grid grid-cols-2 gap-2">
					<SourceMetric
						icon={<ShieldCheck className="size-3.5" />}
						label={t('sources.readiness')}
						value={t(`status.${source.status}`)}
					/>
					<SourceMetric
						icon={<FileText className="size-3.5" />}
						label={t('sources.pages')}
						value={source.page_count === null ? t('common.notExposed') : String(source.page_count)}
					/>
					<SourceMetric
						icon={<BookOpen className="size-3.5" />}
						label={t('sources.text')}
						value={source.has_native_text ? t('sources.nativeText') : t('sources.ocrOrImageText')}
					/>
					<SourceMetric
						icon={<Image className="size-3.5" />}
						label={t('sources.images')}
						value={t('sources.imageCount', { count: source.page_image_count })}
					/>
				</div>
				<div className="mt-3 rounded-md border border-border bg-panel-raised p-3 text-xs text-text-muted">
					<p>{t('sources.createdAt', { value: formatDate(source.created_at, i18n.language) })}</p>
					<p className="mt-1">{t('sources.updatedAt', { value: formatDate(source.updated_at, i18n.language) })}</p>
				</div>
			</InspectorSection>

			<InspectorSection title={t('sources.extractedStories')}>
				{storiesQuery.isLoading ? <StateNotice tone="loading" title={t('sources.storiesLoadingTitle')} /> : null}
				{storiesQuery.error ? (
					<StateNotice
						tone="error"
						title={
							isApiUnavailableError(storiesQuery.error)
								? t('sources.storiesUnavailableTitle')
								: t('sources.storiesErrorTitle')
						}
					>
						{getErrorMessage(storiesQuery.error, t('common.apiRequestFailed'))}
					</StateNotice>
				) : null}
				{storiesQuery.isSuccess && stories.length === 0 ? (
					<StateNotice title={t('sources.noStoriesTitle')}>{t('sources.noStoriesBody')}</StateNotice>
				) : null}
				{stories.length > 0 ? (
					<div className="space-y-2">
						{stories.slice(0, 3).map((story) => (
							<div className="rounded-md border border-border bg-panel-raised p-3" key={story.id}>
								<div className="flex items-start justify-between gap-3">
									<div className="min-w-0">
										<p className="truncate text-sm font-medium text-text">{story.title}</p>
										<p className="mt-1 text-xs text-text-subtle">
											{formatPageRange(story.page_start, story.page_end, t)}
										</p>
									</div>
									<StatusBadge status={story.status} />
								</div>
								{story.excerpt ? <p className="mt-2 line-clamp-3 text-sm text-text-muted">{story.excerpt}</p> : null}
							</div>
						))}
						{stories.length > 3 ? (
							<p className="text-xs text-text-subtle">{t('sources.moreStories', { count: stories.length - 3 })}</p>
						) : null}
					</div>
				) : null}
			</InspectorSection>

			<InspectorSection title={t('sources.processingBackground')}>
				{observabilityQuery.isLoading ? (
					<StateNotice tone="loading" title={t('sources.backgroundLoadingTitle')} />
				) : null}
				{observabilityQuery.error ? (
					<StateNotice
						tone="error"
						title={
							isApiUnavailableError(observabilityQuery.error)
								? t('sources.backgroundUnavailableTitle')
								: t('sources.backgroundErrorTitle')
						}
					>
						{getErrorMessage(observabilityQuery.error, t('common.apiRequestFailed'))}
					</StateNotice>
				) : null}
				{observability ? (
					<div className="space-y-3">
						<div className="space-y-2">
							{observability.source.steps.map((step) => (
								<div className="flex items-center justify-between gap-3 rounded-md bg-field p-2" key={step.step}>
									<div className="min-w-0">
										<p className="truncate text-sm text-text">{step.step}</p>
										{step.error_message ? <p className="mt-1 text-xs text-danger">{step.error_message}</p> : null}
									</div>
									<StatusBadge status={step.status} />
								</div>
							))}
						</div>
						{observability.progress ? (
							<div className="rounded-md border border-border bg-panel-raised p-3 text-xs text-text-muted">
								<p>{t('sources.currentStep', { step: observability.progress.current_step })}</p>
								<p className="mt-1 font-mono">{observability.progress.run_id}</p>
							</div>
						) : null}
					</div>
				) : null}
			</InspectorSection>
		</InspectorPanel>
	);
}

export function SourcesPage() {
	const { t, i18n } = useTranslation();
	const [query, setQuery] = useState('');
	const [status, setStatus] = useState<SourceStatus | 'all'>('all');
	const [offset, setOffset] = useState(0);
	const [selectedId, setSelectedId] = useState<string | undefined>();
	const documentsQuery = useDocuments({
		limit: PAGE_SIZE,
		offset,
		search: query,
		status: status === 'all' ? undefined : status,
	});
	const sources = documentsQuery.data?.data ?? [];
	const selectedSource = sources.find((source) => source.id === selectedId) ?? sources[0];
	const columns = useMemo(() => getSourceColumns(t, i18n.language), [i18n.language, t]);
	const total = documentsQuery.data?.meta.count ?? 0;
	const nextOffset = offset + PAGE_SIZE;
	const previousOffset = Math.max(0, offset - PAGE_SIZE);
	const hasPrevious = offset > 0;
	const hasNext = documentsQuery.data ? nextOffset < total : false;
	const hasFilters = query.trim().length > 0 || status !== 'all';
	const tableRows = documentsQuery.error ? [] : sources;
	const emptyMessage = documentsQuery.error
		? t('sources.listUnavailableShort')
		: documentsQuery.isLoading
			? t('sources.loadingRows')
			: total === 0 && !hasFilters
				? t('sources.emptyCorpus')
				: hasFilters
					? t('sources.noMatchingSources')
					: t('sources.emptyCorpus');

	function updateQuery(value: string) {
		setQuery(value);
		setOffset(0);
		setSelectedId(undefined);
	}

	function updateStatus(value: SourceStatus | 'all') {
		setStatus(value);
		setOffset(0);
		setSelectedId(undefined);
	}

	return (
		<>
			<PageHeader
				actions={
					<button
						className="inline-flex h-9 items-center gap-2 rounded-md bg-field px-3 text-sm font-medium text-text-subtle"
						disabled
						title={t('sources.addSourcesTitle')}
						type="button"
					>
						<Plus className="size-4" />
						{t('common.addSources')}
					</button>
				}
				description={t('sources.description')}
				eyebrow={t('sources.eyebrow')}
				title={t('sources.title')}
			/>

			<div className="grid gap-4 p-4 sm:p-6 xl:grid-cols-[minmax(0,1fr)_360px]">
				<section className="panel min-w-0 overflow-hidden">
					{documentsQuery.isLoading ? (
						<div className="border-b border-border p-3">
							<StateNotice tone="loading" title={t('sources.loadingTitle')} />
						</div>
					) : null}
					{documentsQuery.error ? (
						<div className="border-b border-border p-3">
							<StateNotice
								tone="error"
								title={
									isApiUnavailableError(documentsQuery.error)
										? t('sources.listUnavailableTitle')
										: t('sources.listErrorTitle')
								}
							>
								{getErrorMessage(documentsQuery.error, t('common.apiRequestFailed'))}
							</StateNotice>
						</div>
					) : null}
					<Toolbar className="gap-3">
						<SearchInput
							className="w-full sm:max-w-sm"
							onChange={(event) => updateQuery(event.target.value)}
							placeholder={t('sources.filterPlaceholder')}
							value={query}
						/>
						<label className="field inline-flex h-9 items-center gap-2 px-3 text-sm">
							<span className="text-text-subtle">{t('sources.readiness')}</span>
							<select
								className="bg-transparent text-text outline-none"
								onChange={(event) => updateStatus(event.target.value as SourceStatus | 'all')}
								value={status}
							>
								<option value="all">{t('sources.allReadinessStates')}</option>
								{sourceStatuses.map((sourceStatus) => (
									<option key={sourceStatus} value={sourceStatus}>
										{t(`status.${sourceStatus}`)}
									</option>
								))}
							</select>
						</label>
					</Toolbar>

					<DataTable
						columns={columns}
						emptyMessage={emptyMessage}
						getRowKey={(source) => source.id}
						minWidth={860}
						onRowClick={(source) => setSelectedId(source.id)}
						rows={tableRows}
						selectedKey={selectedSource?.id}
					/>

					<div className="flex flex-wrap items-center justify-between gap-3 border-t border-border p-3 text-sm text-text-muted">
						<span>
							{documentsQuery.data
								? t('sources.paginationRange', {
										start: total === 0 ? 0 : offset + 1,
										end: Math.min(offset + PAGE_SIZE, total),
										total,
									})
								: t('sources.paginationUnavailable')}
						</span>
						<div className="flex items-center gap-2">
							<IconButton
								disabled={!hasPrevious || documentsQuery.isLoading}
								label={t('sources.previousPage')}
								onClick={() => setOffset(previousOffset)}
							>
								<ChevronLeft className="size-4" />
							</IconButton>
							<IconButton
								disabled={!hasNext || documentsQuery.isLoading}
								label={t('sources.nextPage')}
								onClick={() => setOffset(nextOffset)}
							>
								<ChevronRight className="size-4" />
							</IconButton>
						</div>
					</div>
				</section>

				<div className={cn(!selectedSource && documentsQuery.isLoading && 'opacity-70')}>
					<SelectedSourceInspector source={documentsQuery.error ? undefined : selectedSource} />
				</div>
			</div>
		</>
	);
}
