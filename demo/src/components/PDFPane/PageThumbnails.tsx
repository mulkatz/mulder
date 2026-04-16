import { Bookmark } from 'lucide-react';
import type { DocumentPagesResponse, StoryRecord } from '@/lib/api-types';
import { ScrollArea } from '@/components/primitives/ScrollArea';
import { buildApiUrl } from '@/lib/api-client';
import { cn } from '@/lib/cn';

export function PageThumbnails({
  pages,
  stories,
  activePage,
  onSelectPage,
}: {
  pages: DocumentPagesResponse['data']['pages'];
  stories: StoryRecord[];
  activePage: number;
  onSelectPage: (page: number) => void;
}) {
  const storyStarts = new Set(stories.map((story) => story.pageStart).filter((page): page is number => typeof page === 'number'));

  return (
    <ScrollArea className="h-[calc(100vh-10rem)] rounded-xl border border-thread bg-surface">
      <div className="space-y-2 p-3">
        {pages.map((page) => {
          const isActive = page.page_number === activePage;

          return (
            <button
              key={page.page_number}
              className={cn(
                'group relative flex w-full flex-col gap-2 rounded-lg border p-2 text-left transition-colors',
                isActive ? 'border-amber bg-amber-faint' : 'border-thread bg-paper hover:border-thread-strong hover:bg-raised',
              )}
              onClick={() => onSelectPage(page.page_number)}
              type="button"
            >
              {storyStarts.has(page.page_number) ? (
                <Bookmark className="absolute right-2 top-2 size-3 text-amber" />
              ) : null}
              <div className="overflow-hidden rounded-md border border-thread bg-sunken">
                <img
                  alt={`Page ${page.page_number}`}
                  className="block aspect-[3/4] w-full object-cover"
                  loading="lazy"
                  src={buildApiUrl(page.image_url)}
                />
              </div>
              <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-ink-subtle">p. {page.page_number}</span>
            </button>
          );
        })}
      </div>
    </ScrollArea>
  );
}
