import { Link } from 'react-router-dom';
import { ScrollArea } from '@/components/primitives/ScrollArea';
import { StatusLight } from '@/components/shared/StatusLight';
import { Skeleton } from '@/components/shared/Skeleton';
import { Timestamp } from '@/components/shared/Timestamp';
import { PipelineBadge } from '@/components/shared/PipelineBadge';
import { useDocuments } from '@/features/documents/useDocuments';
import { buildApiUrl } from '@/lib/api-client';
import { copy } from '@/lib/copy';
import { routes } from '@/lib/routes';

function sortByRecent<T extends { created_at: string }>(items: T[]) {
  return [...items].sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at));
}

export function RecentlyAdded() {
  const documents = useDocuments({ limit: 6 });

  if (documents.isLoading) {
    return (
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 6 }).map((_, index) => (
          <Skeleton key={index} className="h-64 rounded-2xl" />
        ))}
      </div>
    );
  }

  const sorted = sortByRecent(documents.data?.data ?? []);

  if (sorted.length === 0) {
    return (
      <div className="rounded-2xl border border-thread bg-surface p-6 text-sm text-ink-muted">
        {copy.desk.recent.empty}
      </div>
    );
  }

  return (
    <ScrollArea className="w-full">
      <div className="flex gap-4 pb-2">
        {sorted.map((document) => (
          <Link
            key={document.id}
            to={routes.caseFile(document.id)}
            className="group min-w-[18rem] overflow-hidden rounded-2xl border border-thread bg-surface shadow-xs transition-transform hover:-translate-y-0.5 hover:bg-raised"
          >
            <div className="aspect-[16/10] overflow-hidden bg-sunken">
              <img
                alt={`${document.filename} page 1 preview`}
                className="size-full object-cover object-top transition-transform duration-300 group-hover:scale-[1.02]"
                loading="lazy"
                src={buildApiUrl(`${document.links.pages}/1`)}
              />
            </div>
            <div className="space-y-3 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="truncate font-serif text-2xl text-ink">{document.filename}</h3>
                  <p className="mt-1 text-sm text-ink-muted">{copy.desk.recent.pages(document.page_count)}</p>
                </div>
                <StatusLight tone={document.status === 'ingested' ? 'amber' : 'sage'} className="mt-2" />
              </div>
              <div className="flex items-center justify-between gap-3">
                <PipelineBadge status={document.status} />
                <Timestamp value={document.created_at} />
              </div>
            </div>
          </Link>
        ))}
      </div>
    </ScrollArea>
  );
}
