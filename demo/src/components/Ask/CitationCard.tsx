import { ArrowUpRight, Quote } from 'lucide-react';
import { Button } from '@/components/primitives/Button';
import { ConfidenceBar } from '@/components/shared/ConfidenceBar';
import { PageRange } from '@/components/shared/PageRange';
import type { SearchResult } from '@/lib/api-types';
import type { StoryLookupRecord } from '@/features/documents/useDocumentStoryIndex';
import { copy } from '@/lib/copy';

function buildSnippet(content: string) {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (normalized.length <= 140) {
    return normalized;
  }

  return `${normalized.slice(0, 140).trimEnd()}…`;
}

export function CitationCard({
  result,
  lookup,
  onOpen,
}: {
  result: SearchResult;
  lookup: StoryLookupRecord | undefined;
  onOpen: () => void;
}) {
  const confidence = result.rerank_score || result.score;

  return (
    <article className="rounded-2xl border border-thread bg-raised p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="font-serif text-2xl text-ink">{lookup?.documentTitle ?? 'Document unavailable'}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <PageRange end={lookup?.pageEnd} start={lookup?.pageStart} />
            <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-ink-subtle">
              {lookup?.storyTitle ?? result.story_id}
            </span>
          </div>
        </div>
        <Quote className="mt-1 size-4 shrink-0 text-amber" />
      </div>

      <p className="mt-4 font-serif text-base italic leading-7 text-ink-muted">{buildSnippet(result.content)}</p>

      <div className="mt-4 space-y-3">
        <ConfidenceBar label={copy.ask.answer.confidence} value={confidence} />
        <div className="flex flex-wrap gap-2">
          {result.contributions.map((contribution) => (
            <span
              key={`${result.chunk_id}-${contribution.strategy}`}
              className="rounded-full border border-thread px-2 py-1 font-mono text-[11px] uppercase tracking-[0.14em] text-ink-subtle"
            >
              {contribution.strategy} #{contribution.rank}
            </span>
          ))}
        </div>
      </div>

      <div className="mt-4 flex justify-end">
        <Button onClick={onOpen} variant="secondary">
          {copy.ask.answer.openCaseFile}
          <ArrowUpRight className="size-4" />
        </Button>
      </div>
    </article>
  );
}
