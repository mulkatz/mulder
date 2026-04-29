import type { StoryRecord } from '@/lib/api-types';
import { cn } from '@/lib/cn';
import { formatPageRange } from '@/lib/format';

const STORY_COLORS = [
  'border-amber bg-amber/15',
  'border-cobalt bg-cobalt/15',
  'border-sage bg-sage/15',
  'border-carmine bg-carmine/15',
  'border-entity-event bg-entity-event/15',
  'border-entity-concept bg-entity-concept/15',
];

export function StoryFrames({
  pageNumber,
  stories,
  activeStoryId,
  reveal,
}: {
  pageNumber: number;
  stories: StoryRecord[];
  activeStoryId: string | null;
  reveal: boolean;
}) {
  const visibleStories = stories.filter((story) => {
    const start = story.pageStart ?? pageNumber;
    const end = story.pageEnd ?? start;
    return pageNumber >= start && pageNumber <= end;
  });

  if (visibleStories.length === 0) {
    return null;
  }

  return (
    <div className="pointer-events-none absolute inset-0">
      {visibleStories.map((story, index) => {
        const color = STORY_COLORS[index % STORY_COLORS.length];
        const isLeadPage = story.pageStart === pageNumber;

        return (
          <div
            key={`${story.id}-${pageNumber}`}
            className={cn(
              'story-frame absolute inset-3 rounded-lg border-[1.5px] transition-all duration-base',
              color,
              activeStoryId === story.id ? 'opacity-100 shadow-[0_0_0_1px_rgba(212,162,74,0.35)]' : 'opacity-65',
              reveal && 'animate-compose-in',
            )}
            style={reveal ? { animationDelay: `${index * 100}ms` } : undefined}
          >
            {isLeadPage ? (
              <div className="absolute left-3 top-3 rounded-md border border-thread bg-raised px-2 py-1 text-[11px] shadow-sm">
                <p className="max-w-[18rem] truncate font-serif text-sm text-ink">{story.title}</p>
                <p className="font-mono uppercase tracking-[0.16em] text-ink-subtle">
                  {formatPageRange(story.pageStart, story.pageEnd)}
                </p>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
