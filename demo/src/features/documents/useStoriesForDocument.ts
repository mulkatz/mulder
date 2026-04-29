import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { DocumentStoriesResponse, StoryRecord } from '@/lib/api-types';

function mapStory(record: DocumentStoriesResponse['data']['stories'][number]): StoryRecord {
  return {
    id: record.id,
    title: record.title,
    subtitle: record.subtitle,
    language: record.language,
    category: record.category,
    confidence: record.extraction_confidence,
    pageStart: record.page_start,
    pageEnd: record.page_end,
    markdown: record.markdown,
    excerpt: record.excerpt,
    entities: record.entities,
    status: record.status,
  };
}

export function useStoriesForDocument(id: string) {
  return useQuery({
    queryKey: ['documents', 'stories', id],
    queryFn: async (): Promise<StoryRecord[]> => {
      const response = await apiFetch<DocumentStoriesResponse>(`/api/documents/${id}/stories`);
      return response.data.stories.map(mapStory);
    },
    enabled: Boolean(id),
  });
}
