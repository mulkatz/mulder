import { FileSearch } from 'lucide-react';
import { CitationCard } from '@/components/Ask/CitationCard';
import { RetrievalTrace } from '@/components/Ask/RetrievalTrace';
import type { StoryLookupRecord } from '@/features/documents/useDocumentStoryIndex';
import type { EntityRecord, SearchResponse } from '@/lib/api-types';
import { copy } from '@/lib/copy';

function buildAnswer(results: SearchResponse['data']['results']) {
  if (results.length === 0) {
    return [];
  }

  const lead = results[0];
  const supporting = results
    .slice(1)
    .filter((result) => result.story_id === lead.story_id)
    .slice(0, 1);

  return [lead, ...supporting]
    .map((result) => result.content.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

export function AnswerCard({
  response,
  storiesById,
  entityMap,
  onOpenCitation,
}: {
  response: SearchResponse;
  storiesById: Map<string, StoryLookupRecord>;
  entityMap: Map<string, EntityRecord>;
  onOpenCitation: (story: StoryLookupRecord, chunkId: string) => void;
}) {
  const answerParagraphs = buildAnswer(response.data.results);

  if (response.data.results.length === 0) {
    return (
      <div className="rounded-2xl border border-thread bg-surface p-8">
        <div className="flex items-start gap-4">
          <div className="flex size-12 items-center justify-center rounded-full bg-amber-faint text-amber">
            <FileSearch className="size-5" />
          </div>
          <div>
            <h2 className="font-serif text-3xl text-ink">{copy.ask.answer.noResultsTitle}</h2>
            <p className="mt-3 max-w-2xl text-sm leading-7 text-ink-muted">{copy.ask.answer.noResultsBody}</p>
          </div>
        </div>
      </div>
    );
  }

  const rerankApplied = response.data.results.some((result) => result.rerank_score !== result.score);

  return (
    <div className="space-y-6 rounded-2xl border border-thread bg-surface p-6 shadow-xs">
      <section className="space-y-4">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-amber">{copy.ask.answer.answerLabel}</p>
          <h2 className="mt-2 font-serif text-4xl text-ink">{copy.ask.answer.title}</h2>
        </div>
        <div className="space-y-4 text-lg leading-8 text-ink">
          {answerParagraphs.map((paragraph) => (
            <p key={paragraph}>{paragraph}</p>
          ))}
        </div>
      </section>

      <section className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <h3 className="font-serif text-3xl text-ink">{copy.ask.answer.citations}</h3>
          <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-ink-subtle">
            {response.data.results.length} results
          </span>
        </div>
        <div className="grid gap-4 xl:grid-cols-2">
          {response.data.results.map((result) => {
            const story = storiesById.get(result.story_id);

            return (
              <CitationCard
                key={result.chunk_id}
                lookup={story}
                onOpen={() => {
                  if (story) {
                    onOpenCitation(story, result.chunk_id);
                  }
                }}
                result={result}
              />
            );
          })}
        </div>
      </section>

      <RetrievalTrace entityMap={entityMap} explain={response.data.explain} rerankApplied={rerankApplied} />
    </div>
  );
}
