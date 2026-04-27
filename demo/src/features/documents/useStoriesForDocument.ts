import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  DocumentObservabilityResponse,
  EntityRecord,
  StoryRecord,
} from '@/lib/api-types';
import { useDocumentLayout } from './useDocumentLayout';
import { useEntities } from '@/features/entities/useEntities';

interface StorySection {
  title: string;
  markdown: string;
  excerpt: string;
}

function slugify(input: string) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

function stripMarkdown(markdown: string) {
  return markdown
    .replace(/^#+\s+/gm, '')
    .replace(/[*_`>#-]/g, '')
    .replace(/\n+/g, ' ')
    .trim();
}

function parseLayoutStories(markdown: string): StorySection[] {
  const sections = markdown
    .split(/^#\s+/gm)
    .map((section) => section.trim())
    .filter(Boolean);

  return sections.map((section) => {
    const lines = section.split('\n');
    const title = lines.shift()?.trim() ?? 'Untitled story';
    const body = lines.join('\n').trim();
    const storyMarkdown = `# ${title}\n\n${body}`.trim();

    return {
      title,
      markdown: storyMarkdown,
      excerpt: stripMarkdown(body).slice(0, 200),
    };
  });
}

async function fetchObservability(id: string) {
  try {
    return await apiFetch<DocumentObservabilityResponse>(`/api/documents/${id}/observability`);
  } catch {
    return null;
  }
}

function entityMentionCount(story: StorySection, entity: EntityRecord) {
  const matcher = new RegExp(`(^|[^\\p{L}\\p{N}_])(${entity.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})(?=$|[^\\p{L}\\p{N}_])`, 'giu');
  const matches = story.markdown.match(matcher);
  return matches?.length ?? 0;
}

function matchEntitiesToStories(stories: StorySection[], entities: EntityRecord[]) {
  return stories.map((story) =>
    entities
      .map((entity) => ({ entity, mentions: entityMentionCount(story, entity) }))
      .filter((item) => item.mentions > 0)
      .sort((left, right) => right.mentions - left.mentions)
      .map((item) => item.entity),
  );
}

export function useStoriesForDocument(id: string) {
  const layout = useDocumentLayout(id);
  const entities = useEntities();

  return useQuery({
    queryKey: ['documents', 'stories', id],
    queryFn: async (): Promise<StoryRecord[]> => {
      const [observability] = await Promise.all([fetchObservability(id)]);
      const parsedStories = parseLayoutStories(layout.data ?? '');
      const storyEntities = matchEntitiesToStories(parsedStories, entities.data?.data ?? []);

      return parsedStories.map((story, index) => {
        const metadata = observability?.data.stories[index];

        return {
          id: metadata?.id ?? slugify(story.title),
          title: metadata?.title ?? story.title,
          subtitle: null,
          language: null,
          category: null,
          confidence: null,
          pageStart: metadata?.page_start ?? index + 1,
          pageEnd: metadata?.page_end ?? index + 1,
          markdown: story.markdown,
          excerpt: story.excerpt,
          entities: storyEntities[index] ?? [],
          status: metadata?.status ?? null,
        };
      });
    },
    enabled: Boolean(id && layout.data && entities.data),
  });
}
