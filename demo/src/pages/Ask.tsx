import { ExternalLink, Search, SlidersHorizontal } from 'lucide-react';
import type React from 'react';
import { useQueries } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/primitives/Button';
import { Input } from '@/components/primitives/Input';
import { useDocuments } from '@/features/documents/useDocuments';
import { useSearch } from '@/features/search/useSearch';
import { apiFetch } from '@/lib/api-client';
import type { DocumentObservabilityResponse, SearchResult } from '@/lib/api-types';
import { routes } from '@/lib/routes';

interface StoryCitationContext {
  sourceId: string;
  sourceFilename: string;
  storyTitle: string;
}

export function AskPage() {
  const navigate = useNavigate();
  const search = useSearch();
  const documents = useDocuments({ limit: 100 });
  const observabilityQueries = useQueries({
    queries: (documents.data?.data ?? []).map((document) => ({
      queryKey: ['documents', 'observability', document.id],
      queryFn: () => apiFetch<DocumentObservabilityResponse>(`/api/documents/${document.id}/observability`),
      staleTime: 300_000,
    })),
  });
  const [query, setQuery] = useState('What connects Hynek to Area 51?');
  const storyContextById = useMemo(() => {
    const next = new Map<string, StoryCitationContext>();
    for (const observability of observabilityQueries) {
      const source = observability.data?.data.source;
      const sourceId = source?.id;
      if (!sourceId) {
        continue;
      }
      for (const story of observability.data?.data.stories ?? []) {
        next.set(story.id, {
          sourceId,
          sourceFilename: source.filename,
          storyTitle: story.title,
        });
      }
    }
    return next;
  }, [observabilityQueries]);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (query.trim()) {
      search.mutate({ query, topK: 8 });
    }
  }

  const response = search.data?.data;
  const top = response?.results[0] ?? null;
  const topContext = top ? storyContextById.get(top.story_id) : undefined;

  return (
    <section className="space-y-6">
      <div className="rounded-[2rem] border border-thread bg-surface p-8 shadow-md lg:p-10">
        <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-amber">Ask</p>
        <h1 className="mt-3 font-serif text-5xl text-ink">Ask the archive. Demand citations.</h1>
        <p className="mt-4 max-w-3xl text-lg text-ink-muted">
          This console calls <code className="font-mono">POST /api/search</code> with hybrid retrieval and explain mode.
          It does not invent a chat answer; it surfaces the strongest retrieved passage and its trace.
        </p>
        <form className="mt-6 flex flex-col gap-3 md:flex-row" onSubmit={submit}>
          <Input
            aria-label="Search query"
            className="min-h-12 text-base"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <Button disabled={search.isPending} type="submit">
            <Search className="size-4" />
            {search.isPending ? 'Searching...' : 'Search'}
          </Button>
        </form>
      </div>

      {search.isError ? (
        <div className="rounded-xl border border-carmine-soft bg-carmine-faint p-4 text-sm text-carmine">
          Search failed. Confirm the API is running and the corpus has indexed documents.
        </div>
      ) : null}

      {response?.confidence.degraded ? (
        <div className="rounded-xl border border-amber-soft bg-amber-faint p-4 text-sm text-ink">
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-amber">Degraded confidence</p>
          <p className="mt-1">
            Corpus size {response.confidence.corpus_size}, taxonomy {response.confidence.taxonomy_status}, graph density{' '}
            {response.confidence.graph_density.toFixed(2)}. {response.confidence.message ?? 'Use citations as leads, not conclusions.'}
          </p>
        </div>
      ) : null}

      {top && response ? (
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_24rem]">
          <article className="rounded-2xl border border-thread bg-raised p-6">
            <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-subtle">Top cited passage</p>
            <h2 className="mt-2 font-serif text-3xl text-ink">
              {top.metadata.story_title ?? topContext?.storyTitle ?? 'Retrieved story'}
            </h2>
            <p className="mt-4 text-lg leading-8 text-ink">{top.content}</p>
            <div className="mt-5 flex flex-wrap gap-2 text-xs text-ink-muted">
              {top.contributions.map((contribution) => (
                <span key={contribution.strategy} className="rounded-full bg-surface px-3 py-1">
                  {contribution.strategy} rank {contribution.rank}
                </span>
              ))}
            </div>
          </article>

          <aside className="rounded-2xl border border-thread bg-surface p-5">
            <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.18em] text-ink-subtle">
              <SlidersHorizontal className="size-4" />
              Retrieval trace
            </div>
            <dl className="mt-4 space-y-3 text-sm">
              {Object.entries(response.explain.counts).map(([strategy, count]) => (
                <div className="flex items-center justify-between" key={strategy}>
                  <dt className="capitalize text-ink-muted">{strategy}</dt>
                  <dd className="font-mono text-ink">{count}</dd>
                </div>
              ))}
              <div className="flex items-center justify-between">
                <dt className="text-ink-muted">Seed entities</dt>
                <dd className="font-mono text-ink">{response.explain.seed_entity_ids.length}</dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-ink-muted">Skipped</dt>
                <dd className="font-mono text-ink">{response.explain.skipped.length}</dd>
              </div>
            </dl>
          </aside>
        </div>
      ) : null}

      {response ? (
        <section className="rounded-2xl border border-thread bg-raised p-5">
          <h2 className="font-serif text-3xl text-ink">Citations</h2>
          <div className="mt-4 grid gap-3">
            {response.results.map((result) => (
              <CitationCard
                key={result.chunk_id}
                context={storyContextById.get(result.story_id)}
                result={result}
                onOpen={() => openCitation(result, navigate, storyContextById.get(result.story_id))}
              />
            ))}
            {response.results.length === 0 ? (
              <p className="rounded-xl border border-thread bg-surface p-4 text-sm text-ink-muted">
                No meaningful matches returned for this query.
              </p>
            ) : null}
          </div>
        </section>
      ) : null}
    </section>
  );
}

function openCitation(result: SearchResult, navigate: ReturnType<typeof useNavigate>, context?: StoryCitationContext) {
  const resolvedSourceId = context?.sourceId ?? (typeof result.metadata.source_id === 'string' ? result.metadata.source_id : undefined);
  if (resolvedSourceId) {
    navigate(routes.caseFile(resolvedSourceId));
  }
}

function CitationCard({
  context,
  result,
  onOpen,
}: {
  context?: StoryCitationContext;
  result: SearchResult;
  onOpen: () => void;
}) {
  return (
    <button
      className="w-full rounded-xl border border-thread bg-surface p-4 text-left transition-colors hover:bg-raised"
      onClick={onOpen}
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="font-serif text-xl text-ink">{result.metadata.story_title ?? context?.storyTitle ?? result.story_id}</p>
          <p className="mt-1 text-sm text-ink-muted">
            {result.metadata.source_filename ?? context?.sourceFilename ?? 'Source unknown'} · score {result.rerank_score.toFixed(3)}
          </p>
        </div>
        <ExternalLink className="size-4 text-ink-subtle" />
      </div>
      <p className="mt-3 line-clamp-2 text-sm text-ink-muted">{result.content}</p>
    </button>
  );
}
