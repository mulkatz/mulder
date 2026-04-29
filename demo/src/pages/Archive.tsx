import { ChevronRight, Search, SlidersHorizontal, UploadCloud } from 'lucide-react';
import { useDeferredValue, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/primitives/Button';
import { Input } from '@/components/primitives/Input';
import { EmptyState } from '@/components/shared/EmptyState';
import { ErrorState } from '@/components/shared/ErrorState';
import { PipelineBadge } from '@/components/shared/PipelineBadge';
import { Timestamp } from '@/components/shared/Timestamp';
import { useDocuments } from '@/features/documents/useDocuments';
import { buildApiUrl } from '@/lib/api-client';
import type { DocumentRecord } from '@/lib/api-types';
import { cn } from '@/lib/cn';
import { copy } from '@/lib/copy';
import { routes } from '@/lib/routes';

const statusOptions = ['all', 'ingested', 'extracted', 'segmented', 'enriched', 'embedded', 'graphed', 'analyzed'];

export function ArchivePage() {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [sort, setSort] = useState<'newest' | 'oldest' | 'name'>('newest');
  const deferredSearch = useDeferredValue(search);
  const documents = useDocuments({
    search: deferredSearch || undefined,
    status: status === 'all' ? undefined : status,
    limit: 100,
  });

  const sortedDocuments = useMemo(() => {
    const items = [...(documents.data?.data ?? [])];
    if (sort === 'name') {
      return items.sort((left, right) => left.filename.localeCompare(right.filename));
    }
    return items.sort((left, right) =>
      sort === 'newest' ? right.created_at.localeCompare(left.created_at) : left.created_at.localeCompare(right.created_at),
    );
  }, [documents.data?.data, sort]);
  const selected = sortedDocuments[0] ?? null;

  if (documents.isError) {
    return <ErrorState body={copy.errors.generic} title="Archive unavailable" />;
  }

  return (
    <section className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-amber">Archive</p>
          <h1 className="mt-2 font-serif text-5xl text-ink">Browse the document stack.</h1>
          <p className="mt-3 max-w-2xl text-lg text-ink-muted">
            This is the real document API with filtering, thumbnails, status, and browser upload into the worker queue.
          </p>
        </div>
        <Button onClick={() => window.dispatchEvent(new Event('mulder:open-upload'))}>
          <UploadCloud className="size-4" />
          Upload PDF
        </Button>
      </div>

      <div className="grid gap-5 xl:grid-cols-[18rem_minmax(0,1fr)_24rem]">
        <aside className="rounded-2xl border border-thread bg-raised p-4">
          <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.18em] text-ink-subtle">
            <SlidersHorizontal className="size-4" />
            Filters
          </div>
          <label className="mt-4 block space-y-2 text-sm text-ink-muted">
            Search
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-subtle" />
              <Input className="pl-9" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Area 51, Hynek..." />
            </div>
          </label>
          <label className="mt-4 block space-y-2 text-sm text-ink-muted">
            Status
            <select
              className="w-full rounded-md border border-thread bg-raised px-3 py-2 text-sm text-ink focus:border-amber focus:outline-none"
              value={status}
              onChange={(event) => setStatus(event.target.value)}
            >
              {statusOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
          <label className="mt-4 block space-y-2 text-sm text-ink-muted">
            Sort
            <select
              className="w-full rounded-md border border-thread bg-raised px-3 py-2 text-sm text-ink focus:border-amber focus:outline-none"
              value={sort}
              onChange={(event) => setSort(event.target.value as typeof sort)}
            >
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
              <option value="name">Name</option>
            </select>
          </label>
        </aside>

        <div className="overflow-hidden rounded-2xl border border-thread bg-surface">
          {sortedDocuments.length === 0 ? (
            <EmptyState body={copy.empty.archive.body} title={copy.empty.archive.title} />
          ) : (
            <div className="divide-y divide-thread">
              {sortedDocuments.map((document) => (
                <DocumentRow document={document} key={document.id} />
              ))}
            </div>
          )}
        </div>

        <aside className="rounded-2xl border border-thread bg-raised p-5">
          {selected ? (
            <div>
              <DocumentThumbnail document={selected} size="large" />
              <h2 className="mt-4 font-serif text-3xl text-ink">{selected.filename}</h2>
              <p className="mt-2 text-sm text-ink-muted">
                {selected.page_count ?? 'Unknown'} pages · {selected.layout_available ? 'layout ready' : 'layout pending'}
              </p>
              <div className="mt-4">
                <PipelineBadge status={selected.status} />
              </div>
              <Link
                className="mt-5 inline-flex items-center gap-2 rounded-md border border-thread bg-surface px-4 py-2 text-sm text-ink no-underline hover:bg-raised"
                to={routes.caseFile(selected.id)}
              >
                Open Case File
                <ChevronRight className="size-4" />
              </Link>
            </div>
          ) : (
            <p className="text-sm text-ink-muted">Select a document to preview it.</p>
          )}
        </aside>
      </div>
    </section>
  );
}

function DocumentRow({ document }: { document: DocumentRecord }) {
  return (
    <Link
      className="grid gap-4 px-5 py-4 no-underline transition-colors hover:bg-raised md:grid-cols-[4.5rem_minmax(0,1fr)_8rem_8rem]"
      to={routes.caseFile(document.id)}
    >
      <DocumentThumbnail document={document} />
      <div className="min-w-0">
        <p className="truncate font-serif text-2xl text-ink">{document.filename}</p>
        <p className="mt-1 text-sm text-ink-muted">{document.layout_available ? 'Layout ready for reading' : 'Awaiting story extraction'}</p>
      </div>
      <div className="text-sm text-ink-muted">
        <span className="font-mono">{document.page_count ?? '—'} pages</span>
      </div>
      <div className="flex items-center justify-between gap-3">
        <div>
          <Timestamp value={document.created_at} />
          <div className="mt-1">
            <PipelineBadge status={document.status} />
          </div>
        </div>
        <ChevronRight className="size-4 text-ink-subtle" />
      </div>
    </Link>
  );
}

function DocumentThumbnail({ document, size = 'small' }: { document: DocumentRecord; size?: 'small' | 'large' }) {
  const className =
    size === 'large'
      ? 'aspect-[3/4] w-full rounded-xl border border-thread bg-surface object-cover'
      : 'aspect-[3/4] w-16 rounded-lg border border-thread bg-raised object-cover';

  if (document.page_image_count > 0) {
    return (
      <img
        alt={size === 'large' ? `First page thumbnail for ${document.filename}` : ''}
        className={className}
        src={buildApiUrl(`/api/documents/${document.id}/pages/1`)}
      />
    );
  }

  return (
    <div
      aria-label={`No page preview available for ${document.filename}`}
      className={cn(
        className,
        'flex items-center justify-center bg-paper text-center font-mono text-[10px] uppercase tracking-[0.16em] text-ink-subtle',
      )}
      role="img"
    >
      <span className={size === 'large' ? 'px-6' : 'sr-only'}>No preview yet</span>
    </div>
  );
}
