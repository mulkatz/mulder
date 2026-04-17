import { useQueryClient, useQueries } from '@tanstack/react-query';
import { ChevronDown, ChevronUp, Filter, UploadCloud } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { Button } from '@/components/primitives/Button';
import { Dialog, DialogContent } from '@/components/primitives/Dialog';
import { EmptyArchiveIllustration } from '@/components/shared/Illustration/EmptyArchive';
import { PipelineBadge } from '@/components/shared/PipelineBadge';
import { Skeleton } from '@/components/shared/Skeleton';
import { StatusLight } from '@/components/shared/StatusLight';
import { Timestamp } from '@/components/shared/Timestamp';
import { useDocuments } from '@/features/documents/useDocuments';
import { useJob } from '@/features/jobs/useJobs';
import { useUploadDocument } from '@/features/documents/useUploadDocument';
import { apiFetch, ApiError } from '@/lib/api-client';
import type { DocumentObservabilityResponse, DocumentRecord } from '@/lib/api-types';
import { cn } from '@/lib/cn';
import { copy } from '@/lib/copy';
import { routes } from '@/lib/routes';

const PAGE_SIZE = 25;
const STATUS_OPTIONS = ['all', 'ingested', 'extracted', 'segmented', 'enriched', 'embedded', 'graphed', 'analyzed'] as const;
const SORT_OPTIONS = ['recent', 'alphabetical', 'size', 'density'] as const;

type ArchiveStatusFilter = (typeof STATUS_OPTIONS)[number];
type ArchiveSort = (typeof SORT_OPTIONS)[number];
type UploadStage = 'preparing' | 'uploading' | 'queued' | 'parsing' | 'extracted' | 'failed';
const EMPTY_DOCUMENTS: DocumentRecord[] = [];

function formatCount(value: number) {
  return new Intl.NumberFormat('en-US').format(value);
}

function countEntities(response: DocumentObservabilityResponse | undefined) {
  if (!response) {
    return null;
  }

  return response.data.stories.reduce((total, story) => total + (story.projection?.entities_extracted ?? 0), 0);
}

function sortDocuments(
  documents: Array<DocumentRecord & { entityCount: number | null }>,
  sort: ArchiveSort,
) {
  const sorted = [...documents];

  if (sort === 'alphabetical') {
    sorted.sort((left, right) => left.filename.localeCompare(right.filename));
  } else if (sort === 'size') {
    sorted.sort((left, right) => (right.page_count ?? 0) - (left.page_count ?? 0));
  } else if (sort === 'density') {
    sorted.sort((left, right) => (right.entityCount ?? 0) - (left.entityCount ?? 0));
  } else {
    sorted.sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at));
  }

  return sorted;
}

function isPdfFile(file: File) {
  return file.name.toLowerCase().endsWith('.pdf') || file.type === 'application/pdf';
}

function hasFiles(event: { dataTransfer?: DataTransfer | null }) {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files');
}

function useArchiveDropZone(onDropFile: (file: File) => void) {
  const dragDepth = useRef(0);
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    function onWindowDragOver(event: globalThis.DragEvent) {
      if (!hasFiles(event)) {
        return;
      }

      event.preventDefault();
    }

    window.addEventListener('dragover', onWindowDragOver);
    return () => window.removeEventListener('dragover', onWindowDragOver);
  }, []);

  return {
    isDragging,
    bind: {
      onDragEnter: (event: DragEvent<HTMLElement>) => {
        if (!hasFiles(event)) {
          return;
        }

        event.preventDefault();
        dragDepth.current += 1;
        setIsDragging(true);
      },
      onDragOver: (event: DragEvent<HTMLElement>) => {
        if (!hasFiles(event)) {
          return;
        }

        event.preventDefault();
      },
      onDragLeave: (event: DragEvent<HTMLElement>) => {
        if (!hasFiles(event)) {
          return;
        }

        event.preventDefault();
        dragDepth.current -= 1;
        if (dragDepth.current <= 0) {
          dragDepth.current = 0;
          setIsDragging(false);
        }
      },
      onDrop: (event: DragEvent<HTMLElement>) => {
        event.preventDefault();
        dragDepth.current = 0;
        setIsDragging(false);
        const file = event.dataTransfer.files.item(0);
        if (file) {
          onDropFile(file);
        }
      },
    },
  };
}

function ArchiveUploadDialog({
  open,
  file,
  stage,
  supported,
  error,
  maxBytes,
  jobStatus,
  onOpenChange,
  onChooseAnother,
}: {
  open: boolean;
  file: File | null;
  stage: UploadStage;
  supported: boolean;
  error: string | null;
  maxBytes: number | null;
  jobStatus: string | null;
  onOpenChange: (open: boolean) => void;
  onChooseAnother: () => void;
}) {
  const stageIndex: Record<UploadStage, number> = {
    preparing: 0,
    uploading: 1,
    queued: 2,
    parsing: 3,
    extracted: 4,
    failed: 0,
  };

  const progress = `${Math.min(100, Math.max(8, stageIndex[stage] * 25 + 8))}%`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(92vw,28rem)]">
        <div className="space-y-4">
          <div className="flex items-start gap-3">
            <div className="flex size-10 items-center justify-center rounded-full bg-amber-faint text-amber">
              <UploadCloud className="size-5" />
            </div>
            <div className="min-w-0">
              <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-amber">{copy.archive.upload.label}</p>
              <h2 className="mt-1 font-serif text-3xl text-ink">{copy.archive.upload.title}</h2>
              <p className="mt-2 text-sm text-ink-muted">{copy.archive.upload.body}</p>
            </div>
          </div>

          <div className="rounded-xl border border-thread bg-surface p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate font-serif text-xl text-ink">{file?.name ?? copy.archive.upload.label}</p>
                <p className="mt-1 text-sm text-ink-muted">
                  {stage === 'failed' ? copy.archive.upload.failed : copy.archive.upload[stage]}
                </p>
              </div>
              <StatusLight tone={stage === 'failed' ? 'carmine' : 'amber'} />
            </div>
            <div className="mt-4 h-2 rounded-full bg-thread">
              <div className="h-full rounded-full bg-amber transition-[width] duration-base ease-out" style={{ width: progress }} />
            </div>
            {jobStatus ? <p className="mt-3 font-mono text-[11px] uppercase tracking-[0.16em] text-ink-subtle">{jobStatus}</p> : null}
          </div>

          {error ? <p className="rounded-xl border border-carmine/30 bg-carmine-faint px-4 py-3 text-sm text-carmine">{error}</p> : null}
          {maxBytes ? <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-ink-subtle">{copy.archive.upload.bytesLimit(maxBytes)}</p> : null}
          {!supported ? <p className="text-sm text-ink-muted">{copy.archive.upload.unsupported}</p> : null}

          <div className="flex flex-wrap items-center justify-end gap-3">
            <Button onClick={onChooseAnother} variant="secondary">
              {copy.archive.upload.chooseAnother}
            </Button>
            <Button onClick={() => onOpenChange(false)} variant="ghost">
              {copy.archive.upload.close}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function ArchivePage() {
  const queryClient = useQueryClient();
  const upload = useUploadDocument();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [now] = useState(() => Date.now());
  const [statusFilter, setStatusFilter] = useState<ArchiveStatusFilter>('all');
  const [sort, setSort] = useState<ArchiveSort>('recent');
  const [daysBack, setDaysBack] = useState(180);
  const [filtersOpen, setFiltersOpen] = useState(true);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [uploadSupported, setUploadSupported] = useState(true);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadStage, setUploadStage] = useState<UploadStage>('preparing');
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadJobId, setUploadJobId] = useState<string | null>(null);
  const [uploadMaxBytes, setUploadMaxBytes] = useState<number | null>(null);
  const queryStatus = statusFilter === 'all' ? undefined : statusFilter;
  const documentsQuery = useDocuments({ limit: visibleCount, offset: 0, status: queryStatus });
  const documents = documentsQuery.data?.data ?? EMPTY_DOCUMENTS;
  const job = useJob(uploadJobId);

  async function startUpload(file: File) {
    setUploadFile(file);
    setUploadStage('preparing');
    setUploadError(null);
    setUploadOpen(true);
    setUploadSupported(true);

    try {
      const result = await upload.uploadDocument(file, {
        onStage: (stage) => setUploadStage(stage),
      });

      setUploadMaxBytes(result.maxBytes);
      setUploadJobId(result.jobId);
      setUploadStage('queued');
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        setUploadSupported(false);
        setUploadOpen(false);
        setUploadStage('failed');
        toast.error(copy.archive.upload.unsupported);
        return;
      }

      setUploadStage('failed');
      setUploadError(error instanceof Error ? error.message : copy.errors.generic);
      toast.error(copy.errors.generic);
    }
  }

  const dragZone = useArchiveDropZone(async (file) => {
    if (!isPdfFile(file)) {
      toast.error(copy.archive.upload.selectPdf);
      return;
    }

    await startUpload(file);
  });

  const observabilityQueries = useQueries({
    queries: documents.map((document) => ({
      queryKey: ['documents', 'observability', document.id],
      queryFn: () => apiFetch<DocumentObservabilityResponse>(`/api/documents/${document.id}/observability`),
      staleTime: 300_000,
    })),
  });

  const rankedDocuments = useMemo(() => {
    const earliestVisibleDate = now - daysBack * 24 * 60 * 60 * 1000;

    const rows = documents
      .map((document, index) => ({
        ...document,
        entityCount: countEntities(observabilityQueries[index]?.data),
      }))
      .filter((document) => Date.parse(document.created_at) >= earliestVisibleDate);

    return sortDocuments(rows, sort);
  }, [daysBack, documents, now, observabilityQueries, sort]);

  const jobStatus = job.data?.data.job.status ?? null;
  const displayedUploadStage: UploadStage =
    jobStatus === 'pending'
      ? 'queued'
      : jobStatus === 'running'
        ? 'parsing'
        : jobStatus === 'completed'
          ? 'extracted'
          : jobStatus === 'failed' || jobStatus === 'dead_letter'
            ? 'failed'
            : uploadStage;
  const displayedUploadError =
    jobStatus === 'failed' || jobStatus === 'dead_letter'
      ? uploadError ?? copy.archive.upload.workerFailed
      : uploadError;

  useEffect(() => {
    if (jobStatus === 'completed') {
      queryClient.invalidateQueries({ queryKey: ['documents', 'list'] });
      const timeout = window.setTimeout(() => {
        setUploadOpen(false);
        setUploadFile(null);
        setUploadJobId(null);
        setUploadError(null);
        setUploadStage('preparing');
      }, 1000);

      return () => window.clearTimeout(timeout);
    }
  }, [jobStatus, queryClient]);

  function handleFilePicker() {
    fileInputRef.current?.click();
  }

  function handleUploadDialogChange(nextOpen: boolean) {
    if (!nextOpen && uploadStage !== 'extracted' && uploadStage !== 'failed') {
      return;
    }

    setUploadOpen(nextOpen);

    if (!nextOpen) {
      setUploadFile(null);
      setUploadJobId(null);
      setUploadError(null);
      setUploadStage('preparing');
    }
  }

  function handleFileSelection(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) {
      return;
    }

    void startUpload(file);
  }

  const overlayVisible = dragZone.isDragging;
  const isLoading = documentsQuery.isLoading && documents.length === 0;
  const sourceType = 'PDF only';
  const language = 'All';
  const entityCountTotal = rankedDocuments.reduce((total, document) => total + (document.entityCount ?? 0), 0);

  function handleStatusFilterChange(nextStatus: ArchiveStatusFilter) {
    setStatusFilter(nextStatus);
    setVisibleCount(PAGE_SIZE);
  }

  return (
    <section className="space-y-6" {...dragZone.bind}>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-amber">{copy.nav.archive}</p>
          <h1 className="mt-2 font-serif text-5xl text-ink">{copy.archive.title}</h1>
          <p className="mt-3 max-w-3xl text-lg text-ink-muted">{copy.archive.body}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={() => setFiltersOpen((current) => !current)} variant="secondary">
            <Filter className="size-4" />
            {filtersOpen ? copy.archive.controls.collapseFilters : copy.archive.controls.expandFilters}
          </Button>
          <Button onClick={handleFilePicker}>
            <UploadCloud className="size-4" />
            {copy.archive.empty.action}
          </Button>
        </div>
      </div>

      <div className={cn('grid gap-4', filtersOpen ? 'lg:grid-cols-[17rem_minmax(0,1fr)]' : 'lg:grid-cols-[3.5rem_minmax(0,1fr)]')}>
        <aside className="rounded-2xl border border-thread bg-surface p-4">
          {filtersOpen ? (
            <div className="space-y-5">
              <div className="flex items-center justify-between gap-3">
                <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-amber">{copy.archive.filters.title}</p>
                <Button onClick={() => setFiltersOpen(false)} variant="ghost">
                  <ChevronUp className="size-4" />
                </Button>
              </div>

              <label className="block space-y-2">
                <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-subtle">{copy.archive.filters.status}</span>
                <select
                  className="w-full rounded-md border border-thread bg-raised px-3 py-2 text-sm text-ink"
                  onChange={(event) => handleStatusFilterChange(event.target.value as ArchiveStatusFilter)}
                  value={statusFilter}
                >
                  {STATUS_OPTIONS.map((status) => (
                    <option key={status} value={status}>
                      {status === 'all' ? copy.archive.filters.all : status}
                    </option>
                  ))}
                </select>
              </label>

              <label className="block space-y-2">
                <span className="flex items-center justify-between gap-2 font-mono text-[11px] uppercase tracking-[0.18em] text-ink-subtle">
                  <span>{copy.archive.filters.dateAdded}</span>
                  <span>{daysBack}d</span>
                </span>
                <input
                  className="w-full accent-amber"
                  max={365}
                  min={7}
                  onChange={(event) => setDaysBack(Number(event.target.value))}
                  type="range"
                  value={daysBack}
                />
              </label>

              <label className="block space-y-2">
                <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-subtle">{copy.archive.filters.language}</span>
                <select className="w-full rounded-md border border-thread bg-raised px-3 py-2 text-sm text-ink" disabled value={language}>
                  <option value="All">{copy.archive.filters.all}</option>
                </select>
              </label>

              <label className="block space-y-2">
                <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-subtle">{copy.archive.filters.sourceType}</span>
                <select className="w-full rounded-md border border-thread bg-raised px-3 py-2 text-sm text-ink" disabled value={sourceType}>
                  <option value="PDF only">{copy.archive.filters.pdfOnly}</option>
                </select>
              </label>

              <label className="block space-y-2">
                <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-subtle">{copy.archive.sort.label}</span>
                <select
                  className="w-full rounded-md border border-thread bg-raised px-3 py-2 text-sm text-ink"
                  onChange={(event) => setSort(event.target.value as ArchiveSort)}
                  value={sort}
                >
                  {SORT_OPTIONS.map((option) => (
                    <option key={option} value={option}>
                      {copy.archive.sort[option]}
                    </option>
                  ))}
                </select>
              </label>

              <div className="rounded-xl border border-thread bg-surface p-3 text-sm text-ink-muted">
                <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-subtle">{copy.archive.row.preview}</p>
                <p className="mt-2">{formatCount(entityCountTotal)} entities surfaced in the current slice.</p>
              </div>
            </div>
          ) : (
            <div className="flex h-full items-center justify-center">
              <Button onClick={() => setFiltersOpen(true)} variant="ghost">
                <ChevronDown className="size-4" />
              </Button>
            </div>
          )}
        </aside>

        <div className="relative overflow-hidden rounded-2xl border border-thread bg-surface">
          <div className="hidden grid-cols-[7rem_minmax(0,2.5fr)_6.5rem_6.5rem_8rem_8rem] gap-4 border-b border-thread px-5 py-3 font-mono text-[11px] uppercase tracking-[0.16em] text-ink-subtle lg:grid">
            <span>{copy.archive.table.thumbnail}</span>
            <span>{copy.archive.table.document}</span>
            <span>{copy.archive.table.pages}</span>
            <span>{copy.archive.table.entities}</span>
            <span>{copy.archive.table.status}</span>
            <span>{copy.archive.table.added}</span>
          </div>

          <div className="divide-y divide-thread">
            {isLoading ? (
              <div className="space-y-4 p-5">
                {Array.from({ length: 4 }).map((_, index) => (
                  <Skeleton key={index} className="h-28 rounded-xl" />
                ))}
              </div>
            ) : rankedDocuments.length === 0 ? (
              <div className="space-y-6 px-6 py-10 text-center">
                <EmptyArchiveIllustration />
                <div className="mx-auto max-w-xl">
                  <h2 className="font-serif text-3xl text-ink">{copy.archive.empty.title}</h2>
                  <p className="mt-3 text-sm text-ink-muted">{copy.archive.empty.body}</p>
                </div>
                <Button onClick={handleFilePicker}>
                  <UploadCloud className="size-4" />
                  {copy.archive.empty.action}
                </Button>
              </div>
            ) : (
              rankedDocuments.map((document, index) => {
                const entityCount = document.entityCount ?? null;
                const previewUrl = `${document.links.pages}/1`;

                return (
                  <Link
                    key={document.id}
                    className="grid items-start gap-4 px-5 py-4 transition-colors hover:bg-raised lg:grid-cols-[7rem_minmax(0,2.5fr)_6.5rem_6.5rem_8rem_8rem]"
                    to={routes.caseFile(document.id)}
                  >
                    <div className="hidden lg:block">
                      <div className="relative aspect-[4/3] overflow-hidden rounded-xl border border-thread bg-sunken">
                        <img alt={`${document.filename} preview`} className="size-full object-cover object-top" loading="lazy" src={previewUrl} />
                      </div>
                    </div>
                    <div className="min-w-0">
                      <p className="truncate font-serif text-2xl text-ink">{document.filename}</p>
                      <p className="mt-1 text-sm text-ink-muted">
                        {document.layout_available ? copy.archive.row.layoutReady : copy.archive.row.awaitingExtraction}
                      </p>
                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-ink-subtle">
                          #{index + 1}
                        </span>
                        <PipelineBadge status={document.status} />
                      </div>
                    </div>
                    <div className="flex items-center gap-2 font-mono text-sm text-ink-muted lg:mt-2">
                      <StatusLight tone="cobalt" />
                      <span>{document.page_count ?? '—'}</span>
                    </div>
                    <div className="flex items-center gap-2 font-mono text-sm text-ink-muted lg:mt-2">
                      <StatusLight tone="sage" />
                      <span>{entityCount === null ? '—' : formatCount(entityCount)}</span>
                    </div>
                    <div className="flex items-center gap-2 lg:mt-1">
                      <StatusLight tone={document.status === 'analyzed' ? 'sage' : document.status === 'ingested' ? 'amber' : 'cobalt'} />
                      <PipelineBadge status={document.status} />
                    </div>
                    <div className="lg:mt-2">
                      <Timestamp value={document.created_at} />
                    </div>
                  </Link>
                );
              })
            )}
          </div>

          <div className="flex items-center justify-between gap-3 border-t border-thread px-5 py-4">
            <p className="text-sm text-ink-muted">
              {documentsQuery.hasMore ? copy.archive.row.moreAvailable : copy.archive.table.emptyLoad}
            </p>
            <Button
              disabled={!documentsQuery.hasMore}
              onClick={() => setVisibleCount((current) => current + PAGE_SIZE)}
              variant="secondary"
            >
              {copy.archive.table.loadMore}
            </Button>
          </div>

        {!uploadSupported ? (
          <div className="border-t border-thread bg-surface px-5 py-3 text-sm text-ink-muted">
            {copy.archive.upload.unsupported}
          </div>
          ) : null}

          {overlayVisible ? (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-overlay/30 backdrop-blur-[1px]">
              <div className="rounded-2xl border border-amber bg-raised px-5 py-4 shadow-xl">
                <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-amber">{copy.archive.upload.drop}</p>
                <p className="mt-2 text-sm text-ink-muted">{copy.archive.upload.cue}</p>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <input
        accept="application/pdf"
        className="hidden"
        onChange={handleFileSelection}
        ref={fileInputRef}
        type="file"
      />

      <ArchiveUploadDialog
        error={displayedUploadError}
        file={uploadFile}
        jobStatus={jobStatus}
        maxBytes={uploadMaxBytes}
        open={uploadOpen}
        onChooseAnother={handleFilePicker}
        onOpenChange={handleUploadDialogChange}
        stage={displayedUploadStage}
        supported={uploadSupported}
      />
    </section>
  );
}
