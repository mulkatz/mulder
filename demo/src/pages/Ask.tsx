import { LoaderCircle, Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AnswerCard } from '@/components/Ask/AnswerCard';
import { Button } from '@/components/primitives/Button';
import { Input } from '@/components/primitives/Input';
import { Skeleton } from '@/components/shared/Skeleton';
import { useDocumentStoryIndex, type StoryLookupRecord } from '@/features/documents/useDocumentStoryIndex';
import { useEntities } from '@/features/entities/useEntities';
import { useSearch } from '@/features/search/useSearch';
import { copy } from '@/lib/copy';
import { cn } from '@/lib/cn';
import { routes } from '@/lib/routes';

const PLACEHOLDER_INTERVAL_MS = 5000;

export function AskPage() {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [submittedQuery, setSubmittedQuery] = useState('');
  const [noRerank, setNoRerank] = useState(false);
  const [placeholderIndex, setPlaceholderIndex] = useState(0);

  useEffect(() => {
    const interval = window.setInterval(() => {
      setPlaceholderIndex((current) => (current + 1) % copy.ask.placeholderExamples.length);
    }, PLACEHOLDER_INTERVAL_MS);

    return () => window.clearInterval(interval);
  }, []);

  const search = useSearch(submittedQuery, {
    explain: true,
    noRerank,
    topK: 6,
    enabled: submittedQuery.trim().length > 0,
  });
  const storyIndex = useDocumentStoryIndex(search.data ? search.data.data.results.length > 0 : false);
  const entities = useEntities({ enabled: Boolean(search.data) });

  const entityMap = useMemo(
    () => new Map((entities.data?.data ?? []).map((entity) => [entity.id, entity])),
    [entities.data?.data],
  );

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = query.trim();
    if (!trimmed) {
      return;
    }

    setSubmittedQuery(trimmed);
  }

  function handleOpenCitation(story: StoryLookupRecord, chunkId: string) {
    navigate(
      routes.caseFile(story.documentId, {
        page: story.pageStart ?? 1,
        storyId: story.storyId,
        citationId: chunkId,
      }),
    );
  }

  return (
    <section className="space-y-6">
      <div className="max-w-3xl">
        <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-amber">{copy.nav.ask}</p>
        <h1 className="mt-2 font-serif text-5xl text-ink">{copy.ask.title}</h1>
        <p className="mt-3 text-lg text-ink-muted">{copy.ask.body}</p>
      </div>

      <div className="relative overflow-hidden rounded-[2rem] border border-thread bg-surface px-6 py-6 shadow-xs">
        <div
          className={cn(
            'transition-transform duration-200 ease-out',
            submittedQuery ? 'translate-y-0' : 'lg:translate-y-8',
          )}
        >
          <form className="space-y-4" onSubmit={handleSubmit}>
            <label className="block">
              <span className="sr-only">{copy.ask.form.label}</span>
              <div className="flex flex-col gap-3 lg:flex-row">
                <div className="relative flex-1">
                  <Search className="pointer-events-none absolute left-4 top-1/2 size-5 -translate-y-1/2 text-ink-subtle" />
                  <Input
                    className="h-14 rounded-full pl-12 pr-5 text-lg"
                    data-mulder-search-input="true"
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={copy.ask.placeholderExamples[placeholderIndex]}
                    value={query}
                  />
                </div>
                <Button className="h-14 rounded-full px-6" type="submit">
                  {search.isFetching && submittedQuery ? <LoaderCircle className="size-4 animate-spin" /> : null}
                  {copy.ask.form.submit}
                </Button>
              </div>
            </label>

            <div className="flex flex-wrap items-center justify-between gap-3">
              <button
                className="inline-flex items-center gap-2 rounded-full border border-thread px-3 py-1.5 text-sm text-ink-muted hover:bg-raised hover:text-ink"
                onClick={() => setNoRerank((current) => !current)}
                type="button"
              >
                <span className={cn('size-2 rounded-full', noRerank ? 'bg-thread-strong' : 'bg-amber')} />
                {noRerank ? copy.ask.form.rerankOff : copy.ask.form.rerankOn}
              </button>
              <p className="text-sm text-ink-muted">{copy.ask.form.inputHint}</p>
            </div>
          </form>
        </div>
      </div>

      {!submittedQuery ? (
        <div className="rounded-2xl border border-thread bg-surface p-8">
          <h2 className="font-serif text-3xl text-ink">{copy.ask.answer.emptyTitle}</h2>
          <p className="mt-3 max-w-2xl text-sm leading-7 text-ink-muted">{copy.ask.answer.emptyBody}</p>
        </div>
      ) : null}

      {search.isFetching && submittedQuery ? (
        <div className="space-y-4">
          <Skeleton className="h-64 rounded-2xl" />
          <Skeleton className="h-56 rounded-2xl" />
        </div>
      ) : null}

      {search.data ? (
        <AnswerCard
          entityMap={entityMap}
          onOpenCitation={handleOpenCitation}
          response={search.data}
          storiesById={storyIndex.storiesById}
        />
      ) : null}

      {search.isError ? (
        <div className="rounded-2xl border border-carmine/30 bg-carmine-faint p-5 text-sm text-carmine">
          {search.error instanceof Error ? search.error.message : copy.errors.generic}
        </div>
      ) : null}
    </section>
  );
}
