import { Accordion } from '@/components/primitives/Accordion';
import { ScrollArea } from '@/components/primitives/ScrollArea';
import { StoryListItem } from '@/components/Story/StoryListItem';
import { EmptyState } from '@/components/shared/EmptyState';
import { copy } from '@/lib/copy';
import type { StoryRecord } from '@/lib/api-types';

export function StoryList({
  stories,
  activeStoryId,
  contradictionCounts,
  onStoryChange,
  onReadStory,
  reveal,
}: {
  stories: StoryRecord[];
  activeStoryId: string | null;
  contradictionCounts: Map<string, number>;
  onStoryChange: (storyId: string | null) => void;
  onReadStory: (storyId: string) => void;
  reveal: boolean;
}) {
  if (stories.length === 0) {
    return <EmptyState body={copy.empty.story.body} title={copy.empty.story.title} />;
  }

  return (
    <div className="rounded-2xl border border-thread bg-surface">
      <div className="border-b border-thread px-4 py-4">
        <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-amber">Stories ({stories.length})</p>
      </div>
      <ScrollArea className="h-[calc(100vh-10rem)]">
        <Accordion
          collapsible
          onValueChange={(value) => onStoryChange(value || null)}
          type="single"
          value={activeStoryId ?? ''}
        >
          {stories.map((story, index) => (
            <div key={story.id} style={reveal ? { animationDelay: `${index * 80}ms` } : undefined}>
              <StoryListItem
                contradictions={contradictionCounts.get(story.id) ?? 0}
                expanded={activeStoryId === story.id}
                onRead={() => onReadStory(story.id)}
                reveal={reveal}
                story={story}
              />
            </div>
          ))}
        </Accordion>
      </ScrollArea>
    </div>
  );
}
