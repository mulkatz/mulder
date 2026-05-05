import type { TFunction } from 'i18next';
import {
	ArrowLeft,
	BookOpen,
	FileText,
	Languages,
	PanelLeft,
	PanelRight,
	SplitSquareHorizontal,
	Workflow,
} from 'lucide-react';
import { lazy, type ReactNode, Suspense, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown, { type Components } from 'react-markdown';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { CodeBlock } from '@/components/CodeBlock';
import { InspectorPanel, InspectorSection } from '@/components/InspectorPanel';
import { PageHeader } from '@/components/PageHeader';
import { StateNotice } from '@/components/StateNotice';
import { StatusBadge } from '@/components/StatusBadge';
import { Toolbar } from '@/components/Toolbar';
import { requestStoryTranslation } from '@/features/documents/translation';
import { useDocumentLayout } from '@/features/documents/useDocumentLayout';
import { useDocumentObservability } from '@/features/documents/useDocumentObservability';
import { useDocumentPages } from '@/features/documents/useDocumentPages';
import { useDocumentStories } from '@/features/documents/useDocumentStories';
import { useContradictions } from '@/features/evidence/useContradictions';
import { type AppLocale, locales } from '@/i18n/resources';
import type { ContradictionRecord, DocumentStoryRecord, EntityRecord } from '@/lib/api-types';
import { cn } from '@/lib/cn';
import { getErrorMessage, isApiUnavailableError } from '@/lib/query-state';

type ReaderViewMode = 'split' | 'original' | 'story';

const READER_MODE_STORAGE_KEY = 'mulder.reader.viewMode';
const PdfDocumentPane = lazy(() =>
	import('@/features/documents/PdfDocumentPane').then((module) => ({ default: module.PdfDocumentPane })),
);

function readInitialReaderMode(): ReaderViewMode {
	if (typeof window === 'undefined') return 'split';
	const stored = window.localStorage.getItem(READER_MODE_STORAGE_KEY);
	return stored === 'split' || stored === 'original' || stored === 'story' ? stored : 'split';
}

function useCompactReader() {
	const [isCompact, setIsCompact] = useState(false);

	useEffect(() => {
		if (typeof window.matchMedia !== 'function') return;
		const media = window.matchMedia('(max-width: 1023px)');
		const handleChange = () => setIsCompact(media.matches);
		handleChange();
		media.addEventListener('change', handleChange);
		return () => media.removeEventListener('change', handleChange);
	}, []);

	return isCompact;
}

function formatPageRange(start: number | null, end: number | null, t: TFunction) {
	if (start === null && end === null) return t('common.notExposed');
	if (start !== null && end !== null && start !== end) return t('reader.pageRange', { start, end });
	return t('reader.singlePage', { page: start ?? end });
}

function formatPercent(value: number | null | undefined, t: TFunction) {
	if (typeof value !== 'number') return t('common.notExposed');
	return t('reader.percentValue', { value: Math.round(value * 100) });
}

function formatLanguage(value: string | null | undefined, locale: string, t: TFunction) {
	if (!value) return t('common.unknown');
	try {
		const displayNames = new Intl.DisplayNames([locale], { type: 'language' });
		return displayNames.of(value) ?? value;
	} catch {
		return value;
	}
}

function entityMatchCandidates(entities: EntityRecord[]) {
	const seen = new Set<string>();
	return entities
		.filter((entity) => entity.name.trim().length >= 3)
		.map((entity) => ({ entity, name: entity.name.trim(), key: entity.name.trim().toLowerCase() }))
		.filter((candidate) => {
			if (seen.has(candidate.key)) return false;
			seen.add(candidate.key);
			return true;
		})
		.sort((a, b) => b.name.length - a.name.length);
}

function isWordBoundary(value: string | undefined) {
	return !value || !/[\p{L}\p{N}_]/u.test(value);
}

function findNextEntityMatch(text: string, entities: ReturnType<typeof entityMatchCandidates>, fromIndex: number) {
	const lower = text.toLowerCase();
	let best: { entity: EntityRecord; start: number; end: number } | null = null;

	for (const candidate of entities) {
		let index = lower.indexOf(candidate.key, fromIndex);
		while (index >= 0) {
			const end = index + candidate.name.length;
			if (isWordBoundary(text[index - 1]) && isWordBoundary(text[end])) {
				if (!best || index < best.start || (index === best.start && end > best.end)) {
					best = { entity: candidate.entity, start: index, end };
				}
				break;
			}
			index = lower.indexOf(candidate.key, index + 1);
		}
	}

	return best;
}

function annotateText({
	entities,
	onSelect,
	selectedEntityId,
	text,
}: {
	entities: ReturnType<typeof entityMatchCandidates>;
	onSelect: (entity: EntityRecord) => void;
	selectedEntityId?: string;
	text: string;
}) {
	const parts: ReactNode[] = [];
	let cursor = 0;

	while (cursor < text.length) {
		const match = findNextEntityMatch(text, entities, cursor);
		if (!match) {
			parts.push(text.slice(cursor));
			break;
		}

		if (match.start > cursor) {
			parts.push(text.slice(cursor, match.start));
		}

		const label = text.slice(match.start, match.end);
		parts.push(
			<button
				className={cn(
					'rounded-sm border border-accent/20 bg-accent-soft px-1 text-accent transition-colors hover:border-accent hover:bg-panel',
					selectedEntityId === match.entity.id && 'border-accent bg-panel',
				)}
				key={`${match.entity.id}-${match.start}`}
				onClick={() => onSelect(match.entity)}
				type="button"
			>
				{label}
			</button>,
		);
		cursor = match.end;
	}

	return parts;
}

function AnnotatedMarkdown({
	entities,
	markdown,
	onSelectEntity,
	selectedEntityId,
}: {
	entities: EntityRecord[];
	markdown: string;
	onSelectEntity: (entity: EntityRecord) => void;
	selectedEntityId?: string;
}) {
	const candidates = useMemo(() => entityMatchCandidates(entities), [entities]);

	function annotateChildren(children: ReactNode) {
		return Array.isArray(children)
			? children.map((child, index) =>
					typeof child === 'string' ? (
						annotateText({ entities: candidates, onSelect: onSelectEntity, selectedEntityId, text: child })
					) : (
						// biome-ignore lint/suspicious/noArrayIndexKey: Markdown children have no durable keys.
						<span key={index}>{child}</span>
					),
				)
			: typeof children === 'string'
				? annotateText({ entities: candidates, onSelect: onSelectEntity, selectedEntityId, text: children })
				: children;
	}

	const components: Components = {
		blockquote: ({ children }) => (
			<blockquote className="border-l-2 border-border pl-4 text-text-muted">{annotateChildren(children)}</blockquote>
		),
		code: ({ children }) => (
			<code className="rounded-sm bg-field px-1 py-0.5 font-mono text-[0.9em] text-text">{children}</code>
		),
		h1: ({ children }) => <h1 className="text-2xl font-semibold text-text">{annotateChildren(children)}</h1>,
		h2: ({ children }) => <h2 className="text-xl font-semibold text-text">{annotateChildren(children)}</h2>,
		h3: ({ children }) => <h3 className="text-lg font-semibold text-text">{annotateChildren(children)}</h3>,
		li: ({ children }) => <li className="pl-1">{annotateChildren(children)}</li>,
		ol: ({ children }) => <ol className="list-decimal space-y-2 pl-5">{children}</ol>,
		p: ({ children }) => <p>{annotateChildren(children)}</p>,
		strong: ({ children }) => <strong className="font-semibold text-text">{annotateChildren(children)}</strong>,
		ul: ({ children }) => <ul className="list-disc space-y-2 pl-5">{children}</ul>,
	};

	return (
		<div className="space-y-4 text-sm leading-7 text-text">
			<ReactMarkdown components={components}>{markdown}</ReactMarkdown>
		</div>
	);
}

function ViewModeButton({
	children,
	isActive,
	onClick,
}: {
	children: ReactNode;
	isActive: boolean;
	onClick: () => void;
}) {
	return (
		<button
			className={cn(
				'inline-flex h-8 items-center gap-2 rounded-sm px-3 text-sm text-text-muted transition-colors hover:text-text',
				isActive && 'bg-panel text-text shadow-soft',
			)}
			onClick={onClick}
			type="button"
		>
			{children}
		</button>
	);
}

function OriginalPane({
	layoutError,
	layoutIsLoading,
	layoutText,
	pageCount,
	pagesError,
	pagesIsLoading,
	sourceId,
	story,
}: {
	layoutError: unknown;
	layoutIsLoading: boolean;
	layoutText?: string;
	pageCount?: number;
	pagesError: unknown;
	pagesIsLoading: boolean;
	sourceId: string;
	story?: DocumentStoryRecord;
}) {
	const { t } = useTranslation();

	return (
		<section className="panel flex min-h-[640px] min-w-0 flex-col overflow-hidden">
			<Toolbar>
				<div className="flex items-center gap-2">
					<FileText className="size-4 text-accent" />
					<h2 className="font-medium text-text">{t('reader.originalDocument')}</h2>
				</div>
				<span className="ml-auto text-xs text-text-subtle">
					{pagesIsLoading
						? t('reader.pagesLoading')
						: pagesError
							? t('reader.pagesUnavailable')
							: t('reader.pageCount', { count: pageCount ?? 0 })}
				</span>
			</Toolbar>
			<div className="grid min-h-0 flex-1 gap-3 p-3 xl:grid-rows-[minmax(420px,1fr)_220px]">
				<div className="min-h-[420px] overflow-hidden rounded-md border border-border bg-panel-raised">
					<Suspense
						fallback={
							<div className="h-full min-h-[420px] bg-panel-raised p-3">
								<StateNotice tone="loading" title={t('reader.pdfLoadingTitle')}>
									{t('reader.pdfLoadingBody')}
								</StateNotice>
							</div>
						}
					>
						<PdfDocumentPane sourceId={sourceId} storyStartPage={story?.page_start} />
					</Suspense>
				</div>
				<div className="min-h-0 overflow-hidden rounded-md border border-border bg-panel-raised">
					<div className="border-b border-border px-3 py-2 text-xs font-medium text-text-subtle">
						{t('reader.layoutPreview')}
					</div>
					<div className="h-full overflow-auto p-3">
						{layoutIsLoading ? <StateNotice tone="loading" title={t('reader.layoutLoadingTitle')} /> : null}
						{layoutError ? (
							<StateNotice
								tone="error"
								title={
									isApiUnavailableError(layoutError) ? t('reader.layoutUnavailableTitle') : t('reader.layoutErrorTitle')
								}
							>
								{getErrorMessage(layoutError, t('common.apiRequestFailed'))}
							</StateNotice>
						) : null}
						{layoutText ? (
							<pre className="whitespace-pre-wrap font-sans text-sm leading-6 text-text-muted">
								{layoutText.slice(0, 5000)}
							</pre>
						) : null}
					</div>
				</div>
			</div>
		</section>
	);
}

function StoryRail({
	onSelect,
	selectedStoryId,
	stories,
}: {
	onSelect: (storyId: string) => void;
	selectedStoryId?: string;
	stories: DocumentStoryRecord[];
}) {
	const { t, i18n } = useTranslation();

	return (
		<div className="space-y-2 border-b border-border p-3 lg:max-h-[640px] lg:overflow-auto lg:border-r lg:border-b-0">
			<p className="text-xs font-medium text-text-subtle">{t('reader.storyRailTitle')}</p>
			{stories.map((story) => (
				<button
					className={cn(
						'w-full rounded-md border border-border bg-panel-raised p-3 text-left transition-colors hover:border-border-strong hover:bg-field',
						selectedStoryId === story.id && 'border-accent bg-accent-soft',
					)}
					key={story.id}
					onClick={() => onSelect(story.id)}
					type="button"
				>
					<p className="line-clamp-2 text-sm font-medium text-text">{story.title}</p>
					<div className="mt-2 flex flex-wrap gap-1.5 text-[11px] text-text-subtle">
						<span>{formatPageRange(story.page_start, story.page_end, t)}</span>
						<span>{formatLanguage(story.language, i18n.language, t)}</span>
						{story.category ? <span>{story.category}</span> : null}
					</div>
					<div className="mt-2 flex items-center justify-between gap-2">
						<StatusBadge status={story.status} />
						<span className="font-mono text-[11px] text-text-subtle">
							{formatPercent(story.extraction_confidence, t)}
						</span>
					</div>
				</button>
			))}
		</div>
	);
}

function TranslationControls({
	onRequestTranslation,
	originalLanguage,
	targetLanguage,
	translationRequested,
	setTargetLanguage,
}: {
	onRequestTranslation: () => void;
	originalLanguage?: string | null;
	targetLanguage: AppLocale;
	translationRequested: boolean;
	setTargetLanguage: (language: AppLocale) => void;
}) {
	const { t, i18n } = useTranslation();

	return (
		<div className="rounded-md border border-border bg-panel-raised p-3">
			<div className="flex flex-wrap items-center gap-2">
				<Languages className="size-4 text-accent" />
				<span className="text-sm text-text-muted">
					{t('reader.originalLanguage', { language: formatLanguage(originalLanguage, i18n.language, t) })}
				</span>
				<label className="field inline-flex h-8 items-center gap-2 px-2 text-sm">
					<span className="text-text-subtle">{t('reader.targetLanguage')}</span>
					<select
						className="bg-transparent text-text outline-none"
						onChange={(event) => setTargetLanguage(event.target.value as AppLocale)}
						value={targetLanguage}
					>
						{locales.map((locale) => (
							<option key={locale} value={locale}>
								{formatLanguage(locale, i18n.language, t)}
							</option>
						))}
					</select>
				</label>
				<button
					className="inline-flex h-8 items-center rounded-md border border-border bg-panel px-3 text-sm text-text transition-colors hover:bg-field"
					onClick={onRequestTranslation}
					type="button"
				>
					{t('reader.translate')}
				</button>
			</div>
			<p className="mt-2 text-xs text-text-muted">
				{translationRequested ? t('reader.translationNotConnected') : t('reader.translationPrepareOnly')}
			</p>
		</div>
	);
}

function EntityContextPanel({ entity }: { entity?: EntityRecord }) {
	const { t } = useTranslation();

	if (!entity) {
		return (
			<StateNotice title={t('reader.noAnnotationSelectedTitle')}>{t('reader.noAnnotationSelectedBody')}</StateNotice>
		);
	}

	return (
		<div className="space-y-3">
			<div className="rounded-md border border-border bg-panel-raised p-3">
				<p className="text-sm font-medium text-text">{entity.name}</p>
				<p className="mt-1 text-xs text-text-muted">{entity.type}</p>
				<div className="mt-3 grid grid-cols-2 gap-2 text-xs">
					<div className="rounded-md bg-field p-2">
						<p className="text-text-subtle">{t('reader.corroboration')}</p>
						<p className="mt-1 font-mono text-text">{formatPercent(entity.corroboration_score, t)}</p>
					</div>
					<div className="rounded-md bg-field p-2">
						<p className="text-text-subtle">{t('reader.sourceCount')}</p>
						<p className="mt-1 font-mono text-text">{entity.source_count}</p>
					</div>
				</div>
				<p className="mt-3 text-xs text-text-muted">
					{t('reader.taxonomyStatus', { status: t(`reader.taxonomy_${entity.taxonomy_status}`) })}
				</p>
			</div>
			{Object.keys(entity.attributes).length > 0 ? (
				<CodeBlock label={t('reader.entityAttributes')} value={entity.attributes} />
			) : (
				<StateNotice title={t('reader.noAttributesTitle')}>{t('reader.noAttributesBody')}</StateNotice>
			)}
		</div>
	);
}

function EvidenceSignals({
	error,
	isLoading,
	signals,
}: {
	error: unknown;
	isLoading: boolean;
	signals: ContradictionRecord[];
}) {
	const { t } = useTranslation();

	if (isLoading) {
		return <StateNotice tone="loading" title={t('reader.evidenceSignalsLoadingTitle')} />;
	}

	if (error) {
		return (
			<StateNotice
				tone="error"
				title={
					isApiUnavailableError(error)
						? t('reader.evidenceSignalsUnavailableTitle')
						: t('reader.evidenceSignalsErrorTitle')
				}
			>
				{getErrorMessage(error, t('common.apiRequestFailed'))}
			</StateNotice>
		);
	}

	if (signals.length === 0) {
		return <StateNotice title={t('reader.noEvidenceSignalsTitle')}>{t('reader.noEvidenceSignalsBody')}</StateNotice>;
	}

	return (
		<div className="space-y-2">
			{signals.map((signal) => (
				<div className="rounded-md border border-border bg-panel-raised p-3" key={signal.id}>
					<div className="flex items-center justify-between gap-3">
						<p className="text-sm font-medium text-text">{signal.relationship}</p>
						<StatusBadge
							status={
								signal.edge_type === 'CONFIRMED_CONTRADICTION'
									? 'contradicted'
									: signal.edge_type === 'DISMISSED_CONTRADICTION'
										? 'unverified'
										: 'watching'
							}
						/>
					</div>
					<p className="mt-2 text-sm text-text-muted">
						{signal.analysis?.explanation ?? t('reader.contradictionNeedsReview')}
					</p>
				</div>
			))}
		</div>
	);
}

function StoryPane({
	contradictionsError,
	contradictionsIsLoading,
	onRequestTranslation,
	onSelectEntity,
	onSelectStory,
	selectedEntity,
	selectedStory,
	selectedStoryId,
	setTargetLanguage,
	signals,
	stories,
	storiesError,
	storiesIsLoading,
	targetLanguage,
	translationRequested,
}: {
	contradictionsError: unknown;
	contradictionsIsLoading: boolean;
	onRequestTranslation: () => void;
	onSelectEntity: (entity: EntityRecord) => void;
	onSelectStory: (storyId: string) => void;
	selectedEntity?: EntityRecord;
	selectedStory?: DocumentStoryRecord;
	selectedStoryId?: string;
	setTargetLanguage: (language: AppLocale) => void;
	signals: ContradictionRecord[];
	stories: DocumentStoryRecord[];
	storiesError: unknown;
	storiesIsLoading: boolean;
	targetLanguage: AppLocale;
	translationRequested: boolean;
}) {
	const { t } = useTranslation();

	return (
		<section className="panel min-w-0 overflow-hidden">
			<Toolbar>
				<div className="flex items-center gap-2">
					<BookOpen className="size-4 text-accent" />
					<h2 className="font-medium text-text">{t('reader.storyWorkspace')}</h2>
				</div>
			</Toolbar>
			{storiesIsLoading ? (
				<div className="border-b border-border p-3">
					<StateNotice tone="loading" title={t('reader.storiesLoadingTitle')} />
				</div>
			) : null}
			{storiesError ? (
				<div className="border-b border-border p-3">
					<StateNotice
						tone="error"
						title={
							isApiUnavailableError(storiesError) ? t('reader.storiesUnavailableTitle') : t('reader.storiesErrorTitle')
						}
					>
						{getErrorMessage(storiesError, t('common.apiRequestFailed'))}
					</StateNotice>
				</div>
			) : null}
			{!storiesIsLoading && !storiesError && stories.length === 0 ? (
				<div className="p-3">
					<StateNotice title={t('reader.noStoriesTitle')}>{t('reader.noStoriesBody')}</StateNotice>
				</div>
			) : null}
			{stories.length > 0 ? (
				<div className="grid min-h-[640px] lg:grid-cols-[250px_minmax(0,1fr)]">
					<StoryRail onSelect={onSelectStory} selectedStoryId={selectedStoryId} stories={stories} />
					<div className="grid min-w-0 gap-4 p-4 2xl:grid-cols-[minmax(0,1fr)_300px]">
						<div className="min-w-0 space-y-4">
							{selectedStory ? (
								<>
									<div className="space-y-3">
										<div className="flex flex-wrap items-start justify-between gap-3">
											<div className="min-w-0">
												<p className="text-xs text-text-subtle">
													{formatPageRange(selectedStory.page_start, selectedStory.page_end, t)}
												</p>
												<h2 className="mt-1 text-2xl font-semibold text-text">{selectedStory.title}</h2>
												{selectedStory.subtitle ? (
													<p className="mt-1 text-sm text-text-muted">{selectedStory.subtitle}</p>
												) : null}
											</div>
											<StatusBadge status={selectedStory.status} />
										</div>
										<TranslationControls
											onRequestTranslation={onRequestTranslation}
											originalLanguage={selectedStory.language}
											setTargetLanguage={setTargetLanguage}
											targetLanguage={targetLanguage}
											translationRequested={translationRequested}
										/>
									</div>
									<div className="rounded-md border border-border bg-panel-raised p-5">
										<AnnotatedMarkdown
											entities={selectedStory.entities}
											markdown={selectedStory.markdown}
											onSelectEntity={onSelectEntity}
											selectedEntityId={selectedEntity?.id}
										/>
									</div>
								</>
							) : (
								<StateNotice title={t('reader.noStorySelectedTitle')}>{t('reader.noStorySelectedBody')}</StateNotice>
							)}
						</div>
						<div className="space-y-4">
							<InspectorPanel title={t('reader.linkedContext')}>
								<InspectorSection title={t('reader.entityContext')}>
									<EntityContextPanel entity={selectedEntity} />
								</InspectorSection>
								<InspectorSection title={t('reader.evidenceSignals')}>
									<EvidenceSignals error={contradictionsError} isLoading={contradictionsIsLoading} signals={signals} />
								</InspectorSection>
							</InspectorPanel>
						</div>
					</div>
				</div>
			) : null}
		</section>
	);
}

function ProcessingBackground({
	error,
	isLoading,
	observability,
}: {
	error: unknown;
	isLoading: boolean;
	observability?: ReturnType<typeof useDocumentObservability>['data'];
}) {
	const { t } = useTranslation();

	return (
		<details className="panel p-4">
			<summary className="flex cursor-pointer items-center gap-2 text-sm font-medium text-text">
				<Workflow className="size-4 text-accent" />
				{t('reader.processingBackground')}
			</summary>
			<div className="mt-4 space-y-3">
				{isLoading ? <StateNotice tone="loading" title={t('reader.processingLoadingTitle')} /> : null}
				{error ? (
					<StateNotice
						tone="error"
						title={
							isApiUnavailableError(error) ? t('reader.processingUnavailableTitle') : t('reader.processingErrorTitle')
						}
					>
						{getErrorMessage(error, t('common.apiRequestFailed'))}
					</StateNotice>
				) : null}
				{observability ? (
					<div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
						{observability.data.source.steps.map((step) => (
							<div className="rounded-md bg-field p-3" key={step.step}>
								<p className="truncate text-sm text-text">{step.step}</p>
								<div className="mt-2">
									<StatusBadge status={step.status} />
								</div>
								{step.error_message ? <p className="mt-2 text-xs text-danger">{step.error_message}</p> : null}
							</div>
						))}
					</div>
				) : null}
			</div>
		</details>
	);
}

export function SourceReaderPage() {
	const { sourceId } = useParams<{ sourceId: string }>();
	const [searchParams] = useSearchParams();
	const { t, i18n } = useTranslation();
	const isCompact = useCompactReader();
	const [viewMode, setViewMode] = useState<ReaderViewMode>(readInitialReaderMode);
	const [selectedStoryId, setSelectedStoryId] = useState<string | undefined>(searchParams.get('story') ?? undefined);
	const [selectedEntity, setSelectedEntity] = useState<EntityRecord | undefined>();
	const [targetLanguage, setTargetLanguage] = useState<AppLocale>(i18n.language === 'de' ? 'de' : 'en');
	const [translationRequested, setTranslationRequested] = useState(false);
	const storiesQuery = useDocumentStories(sourceId);
	const layoutQuery = useDocumentLayout(sourceId);
	const pagesQuery = useDocumentPages(sourceId);
	const observabilityQuery = useDocumentObservability(sourceId);
	const contradictionsQuery = useContradictions({ status: 'all', limit: 100 });
	const stories = storiesQuery.data?.data.stories ?? [];
	const selectedStory = stories.find((story) => story.id === selectedStoryId) ?? stories[0];
	const source = observabilityQuery.data?.data.source;
	const effectiveViewMode = isCompact && viewMode === 'split' ? 'story' : viewMode;
	const pageCount = pagesQuery.data?.meta.count;
	const storySignals = selectedStory
		? (contradictionsQuery.data?.data ?? []).filter((record) => record.story_id === selectedStory.id)
		: [];

	useEffect(() => {
		const linkedStoryId = searchParams.get('story');
		if (linkedStoryId && linkedStoryId !== selectedStoryId) {
			setSelectedStoryId(linkedStoryId);
			setSelectedEntity(undefined);
			setTranslationRequested(false);
		}
	}, [searchParams, selectedStoryId]);

	useEffect(() => {
		if (stories.length > 0 && (!selectedStoryId || !stories.some((story) => story.id === selectedStoryId))) {
			setSelectedStoryId(stories[0].id);
			setSelectedEntity(undefined);
			setTranslationRequested(false);
		}
	}, [selectedStoryId, stories]);

	useEffect(() => {
		if (typeof window === 'undefined') return;
		window.localStorage.setItem(READER_MODE_STORAGE_KEY, viewMode);
	}, [viewMode]);

	useEffect(() => {
		if (isCompact && viewMode === 'split') {
			setViewMode('story');
		}
	}, [isCompact, viewMode]);

	function handleStorySelection(storyId: string) {
		setSelectedStoryId(storyId);
		setSelectedEntity(undefined);
		setTranslationRequested(false);
	}

	async function handleTranslateRequest() {
		if (!sourceId || !selectedStory) return;
		await requestStoryTranslation({ sourceId, storyId: selectedStory.id, targetLanguage });
		setTranslationRequested(true);
	}

	if (!sourceId) {
		return (
			<div className="p-4 sm:p-6">
				<StateNotice tone="error" title={t('reader.missingSourceTitle')}>
					{t('reader.missingSourceBody')}
				</StateNotice>
			</div>
		);
	}

	return (
		<>
			<PageHeader
				actions={
					<Link
						className="inline-flex h-9 items-center gap-2 rounded-md border border-border bg-panel px-3 text-sm text-text transition-colors hover:bg-field"
						to="/sources"
					>
						<ArrowLeft className="size-4" />
						{t('reader.backToSources')}
					</Link>
				}
				description={t('reader.description')}
				eyebrow={t('reader.eyebrow')}
				title={source?.filename ?? selectedStory?.title ?? t('reader.titleFallback')}
			/>

			<div className="space-y-4 p-4 sm:p-6">
				<Toolbar className="justify-between gap-3 rounded-md border border-border">
					<div className="inline-flex rounded-md border border-border bg-field p-0.5">
						{!isCompact ? (
							<ViewModeButton isActive={effectiveViewMode === 'split'} onClick={() => setViewMode('split')}>
								<SplitSquareHorizontal className="size-4" />
								{t('reader.viewSplit')}
							</ViewModeButton>
						) : null}
						<ViewModeButton isActive={effectiveViewMode === 'original'} onClick={() => setViewMode('original')}>
							<PanelLeft className="size-4" />
							{t('reader.viewOriginal')}
						</ViewModeButton>
						<ViewModeButton isActive={effectiveViewMode === 'story'} onClick={() => setViewMode('story')}>
							<PanelRight className="size-4" />
							{t('reader.viewStory')}
						</ViewModeButton>
					</div>
					{isCompact ? <span className="text-xs text-text-subtle">{t('reader.compactViewNote')}</span> : null}
				</Toolbar>

				<div
					className={cn(
						'grid gap-4',
						effectiveViewMode === 'split' && 'xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]',
					)}
				>
					{effectiveViewMode === 'split' || effectiveViewMode === 'original' ? (
						<OriginalPane
							layoutError={layoutQuery.error}
							layoutIsLoading={layoutQuery.isLoading}
							layoutText={layoutQuery.data}
							pageCount={pageCount}
							pagesError={pagesQuery.error}
							pagesIsLoading={pagesQuery.isLoading}
							sourceId={sourceId}
							story={selectedStory}
						/>
					) : null}

					{effectiveViewMode === 'split' || effectiveViewMode === 'story' ? (
						<StoryPane
							contradictionsError={contradictionsQuery.error}
							contradictionsIsLoading={contradictionsQuery.isLoading}
							onRequestTranslation={handleTranslateRequest}
							onSelectEntity={setSelectedEntity}
							onSelectStory={handleStorySelection}
							selectedEntity={selectedEntity}
							selectedStory={selectedStory}
							selectedStoryId={selectedStory?.id}
							setTargetLanguage={setTargetLanguage}
							signals={storySignals}
							stories={stories}
							storiesError={storiesQuery.error}
							storiesIsLoading={storiesQuery.isLoading}
							targetLanguage={targetLanguage}
							translationRequested={translationRequested}
						/>
					) : null}
				</div>

				<ProcessingBackground
					error={observabilityQuery.error}
					isLoading={observabilityQuery.isLoading}
					observability={observabilityQuery.data}
				/>
			</div>
		</>
	);
}
