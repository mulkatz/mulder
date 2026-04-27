import { useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useMentionIndex } from '@/app/stores/MentionIndexStore';
import { Button } from '@/components/primitives/Button';
import { EntityPill } from '@/components/Entity/EntityPill';
import type { StoryRecord } from '@/lib/api-types';

export function StoryReader({
  story,
  onBack,
}: {
  story: StoryRecord;
  onBack: () => void;
}) {
  const mentionIndex = useMentionIndex();
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!rootRef.current) {
      return;
    }

    return mentionIndex.registerRoot(`story-reader-${story.id}`, rootRef.current);
  }, [mentionIndex, story.id]);

  return (
    <div className="rounded-2xl border border-thread bg-paper px-8 py-10 shadow-xl" data-testid="story-reader">
      <Button className="mb-8" onClick={onBack} variant="ghost">
        ← Back to PDF
      </Button>
      <article className="mx-auto max-w-[680px] space-y-8" ref={rootRef}>
        <header className="space-y-4">
          <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-amber">Reading mode</p>
          <h1 className="font-serif text-5xl leading-[1.02] text-ink">{story.title}</h1>
          <div className="flex flex-wrap gap-2">
            {story.entities.map((entity) => (
              <EntityPill entity={entity} key={entity.id} size="sm" />
            ))}
          </div>
        </header>
        <div className="space-y-5 text-ink">
          <ReactMarkdown
            components={{
              h1: ({ children }) => <h1 className="font-serif text-4xl leading-tight text-ink">{children}</h1>,
              h2: ({ children }) => <h2 className="font-serif text-2xl leading-tight text-ink">{children}</h2>,
              p: ({ children }) => <p className="text-lg leading-relaxed text-ink">{children}</p>,
              blockquote: ({ children }) => (
                <blockquote className="border-l-2 border-amber pl-4 font-serif italic text-ink-muted">{children}</blockquote>
              ),
            }}
            remarkPlugins={[remarkGfm]}
          >
            {story.markdown}
          </ReactMarkdown>
        </div>
      </article>
    </div>
  );
}
