import { ChevronRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import { EmptyState } from '@/components/shared/EmptyState';
import { ErrorState } from '@/components/shared/ErrorState';
import { PipelineBadge } from '@/components/shared/PipelineBadge';
import { Timestamp } from '@/components/shared/Timestamp';
import { useDocuments } from '@/features/documents/useDocuments';
import { copy } from '@/lib/copy';
import { routes } from '@/lib/routes';

export function ArchivePage() {
  const documents = useDocuments();

  if (documents.isError) {
    return <ErrorState body={copy.errors.generic} title="Archive unavailable" />;
  }

  if (documents.data && documents.data.data.length === 0) {
    return <EmptyState body={copy.empty.archive.body} title={copy.empty.archive.title} />;
  }

  return (
    <section className="space-y-6">
      <div>
        <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-amber">Archive</p>
        <h1 className="mt-2 font-serif text-5xl text-ink">Open a case file.</h1>
        <p className="mt-3 max-w-2xl text-lg text-ink-muted">
          H11 closes when a processed document opens into the split-view case file below.
        </p>
      </div>
      <div className="overflow-hidden rounded-2xl border border-thread bg-surface">
        <div className="grid grid-cols-[minmax(0,1fr)_9rem_9rem_8rem] gap-4 border-b border-thread px-6 py-3 font-mono text-[11px] uppercase tracking-[0.16em] text-ink-subtle">
          <span>Document</span>
          <span>Pages</span>
          <span>Added</span>
          <span>Status</span>
        </div>
        <div className="divide-y divide-thread">
          {documents.data?.data.map((document) => (
            <Link
              className="grid grid-cols-[minmax(0,1fr)_9rem_9rem_8rem] items-center gap-4 px-6 py-4 no-underline transition-colors hover:bg-raised"
              key={document.id}
              to={routes.caseFile(document.id)}
            >
              <div className="min-w-0">
                <p className="truncate font-serif text-2xl text-ink">{document.filename}</p>
                <p className="mt-1 text-sm text-ink-muted">{document.layout_available ? 'Layout ready for reading' : 'Awaiting story extraction'}</p>
              </div>
              <span className="font-mono text-sm text-ink-muted">{document.page_count ?? '—'}</span>
              <Timestamp value={document.created_at} />
              <div className="flex items-center justify-between gap-3">
                <PipelineBadge status={document.status} />
                <ChevronRight className="size-4 text-ink-subtle" />
              </div>
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}
