import { useQueries } from '@tanstack/react-query';
import { useMemo } from 'react';
import { apiFetch } from '@/lib/api-client';
import type { DocumentObservabilityResponse } from '@/lib/api-types';
import { useDocuments } from './useDocuments';

const EMPTY_DOCUMENTS: Array<{ id: string; filename: string }> = [];

export interface StoryLookupRecord {
  documentId: string;
  documentTitle: string;
  storyId: string;
  storyTitle: string;
  pageStart: number | null;
  pageEnd: number | null;
}

export function useDocumentStoryIndex(enabled = true) {
  const documents = useDocuments({ limit: 100, enabled });
  const documentRows = documents.data?.data ?? EMPTY_DOCUMENTS;

  const observabilityQueries = useQueries({
    queries: documentRows.map((document) => ({
      queryKey: ['documents', 'observability', document.id],
      queryFn: () => apiFetch<DocumentObservabilityResponse>(`/api/documents/${document.id}/observability`),
      staleTime: 300_000,
    })),
  });

  const index = useMemo(() => {
    const storiesById = new Map<string, StoryLookupRecord>();

    documentRows.forEach((document, documentIndex) => {
      const observability = observabilityQueries[documentIndex]?.data?.data;

      observability?.stories.forEach((story) => {
        storiesById.set(story.id, {
          documentId: document.id,
          documentTitle: document.filename,
          storyId: story.id,
          storyTitle: story.title,
          pageStart: story.page_start,
          pageEnd: story.page_end,
        });
      });
    });

    return storiesById;
  }, [documentRows, observabilityQueries]);

  return {
    isLoading: enabled && (documents.isLoading || observabilityQueries.some((query) => query.isLoading)),
    storiesById: index,
  };
}
