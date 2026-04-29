import { AlertTriangle } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useMentionIndex } from '@/app/stores/MentionIndexStore';
import { AccordionContent, AccordionItem, AccordionTrigger } from '@/components/primitives/Accordion';
import { EntityPill } from '@/components/Entity/EntityPill';
import { ConfidenceBar } from '@/components/shared/ConfidenceBar';
import { PageRange } from '@/components/shared/PageRange';
import type { StoryRecord } from '@/lib/api-types';
import { cn } from '@/lib/cn';

export function StoryListItem({
  story,
  expanded,
  contradictions,
  onRead,
  reveal,
}: {
  story: StoryRecord;
  expanded: boolean;
  contradictions: number;
  onRead: () => void;
  reveal: boolean;
}) {
  const mentionIndex = useMentionIndex();
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!rootRef.current) {
      return;
    }

    return mentionIndex.registerRoot(`story-list-${story.id}`, rootRef.current);
  }, [mentionIndex, story.id]);

  return (
    <AccordionItem value={story.id}>
      <AccordionTrigger className={reveal ? 'animate-compose-in' : undefined}>
        <div className="space-y-2">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="truncate font-serif text-xl text-ink">{story.title}</h3>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <PageRange end={story.pageEnd} start={story.pageStart} />
                <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink-subtle">
                  {story.language ?? 'und'}
                </span>
                <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink-subtle">
                  {story.category ?? 'story'}
                </span>
              </div>
            </div>
            {contradictions > 0 ? <AlertTriangle className="mt-1 size-4 text-carmine" /> : null}
          </div>
          <ConfidenceBar className="w-16" value={story.confidence} />
        </div>
      </AccordionTrigger>
      <AccordionContent>
        <div className="space-y-4" data-story-id={story.id} data-testid="story-list-item" ref={rootRef}>
          <p className={cn('text-sm leading-7 text-ink-muted', expanded && 'amber-underline')}>{story.excerpt}…</p>
          <button
            className="font-mono text-xs uppercase tracking-[0.16em] text-cobalt hover:text-cobalt-hover"
            data-testid="read-full-story"
            onClick={onRead}
            type="button"
          >
            Read full story →
          </button>
          <div className="flex flex-wrap gap-2">
            {story.entities.map((entity) => (
              <EntityPill entity={entity} key={entity.id} size="sm" />
            ))}
          </div>
        </div>
      </AccordionContent>
    </AccordionItem>
  );
}
