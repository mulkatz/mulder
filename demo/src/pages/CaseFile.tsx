import { ExternalLink, FileDown, PanelRightClose, PanelRightOpen } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { Button } from '@/components/primitives/Button';
import { PageThumbnails } from '@/components/PDFPane/PageThumbnails';
import { PDFPane, type PDFPaneHandle } from '@/components/PDFPane/PDFPane';
import { StoryList } from '@/components/Story/StoryList';
import { EntityPill } from '@/components/Entity/EntityPill';
import { ErrorState } from '@/components/shared/ErrorState';
import { PipelineBadge } from '@/components/shared/PipelineBadge';
import { Skeleton } from '@/components/shared/Skeleton';
import { useContradictions } from '@/features/evidence/useContradictions';
import { useDocument } from '@/features/documents/useDocument';
import { useDocumentPages } from '@/features/documents/useDocumentPages';
import { usePdfUrl } from '@/features/documents/usePdfUrl';
import { useStoriesForDocument } from '@/features/documents/useStoriesForDocument';
import { buildApiUrl } from '@/lib/api-client';
import { copy } from '@/lib/copy';
import { routes } from '@/lib/routes';

function buildContradictionCounts(storyIds: string[]) {
  return storyIds.reduce<Map<string, number>>((counts, storyId) => {
    counts.set(storyId, (counts.get(storyId) ?? 0) + 1);
    return counts;
  }, new Map());
}

export function CaseFilePage() {
  const { id = '' } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const [landing] = useState(() => {
    const searchParams = new URLSearchParams(location.search);

    return {
      page: Number(searchParams.get('page') ?? '') || null,
      storyId: searchParams.get('story'),
    };
  });
  const pdfPaneRef = useRef<PDFPaneHandle | null>(null);
  const hasScrolledToLandingPage = useRef(false);
  const [activePage, setActivePage] = useState(landing.page ?? 1);
  const [selectedStoryId, setSelectedStoryId] = useState<string | null>(landing.storyId);
  const [storyRailOpen, setStoryRailOpen] = useState(true);
  const [reveal, setReveal] = useState(() => {
    if (typeof window === 'undefined' || !id) {
      return false;
    }

    return window.sessionStorage.getItem(`mulder:revealed:${id}`) !== 'true';
  });
  const document = useDocument(id);
  const pages = useDocumentPages(id);
  const stories = useStoriesForDocument(id);
  const contradictions = useContradictions();
  const pdfUrl = usePdfUrl(id);

  useEffect(() => {
    if (!id) {
      return;
    }

    const key = `mulder:revealed:${id}`;
    const hasRevealed = window.sessionStorage.getItem(key) === 'true';

    if (!hasRevealed) {
      window.sessionStorage.setItem(key, 'true');

      const complete = window.setTimeout(() => setReveal(false), 1800);
      const skip = () => {
        setReveal(false);
        window.clearTimeout(complete);
      };
      const handleKeyDown = (event: KeyboardEvent) => {
        if (event.code === 'Space') {
          skip();
        }
      };

      window.addEventListener('keydown', handleKeyDown, { once: true });
      window.addEventListener('pointerdown', skip, { once: true });

      return () => {
        window.clearTimeout(complete);
        window.removeEventListener('keydown', handleKeyDown);
        window.removeEventListener('pointerdown', skip);
      };
    }
  }, [id]);

  const currentStory = useMemo(() => {
    if (!stories.data?.length) {
      return null;
    }

    return (
      stories.data.find((story) => story.id === selectedStoryId) ??
      stories.data.find((story) => {
        const start = story.pageStart ?? activePage;
        const end = story.pageEnd ?? start;
        return activePage >= start && activePage <= end;
      }) ??
      stories.data[0]
    );
  }, [activePage, selectedStoryId, stories.data]);

  const contradictionCounts = useMemo(() => {
    const storyIds = (contradictions.data?.data ?? [])
      .map((item) => item.story_id)
      .filter((storyId): storyId is string => Boolean(storyId));
    return buildContradictionCounts(storyIds);
  }, [contradictions.data]);

  useEffect(() => {
    if (!landing.page || hasScrolledToLandingPage.current || !pages.data) {
      return;
    }

    const page = landing.page;
    hasScrolledToLandingPage.current = true;
    window.requestAnimationFrame(() => {
      pdfPaneRef.current?.scrollToPage(page);
    });
  }, [landing.page, pages.data]);

  if (document.isError) {
    return <ErrorState body={copy.errors.documentNotFound} title="Document not found" />;
  }

  if (document.isLoading || pages.isLoading || stories.isLoading) {
    return (
      <div className="grid grid-cols-[5.5rem_minmax(0,1fr)_22rem] gap-4">
        <Skeleton className="h-[calc(100vh-10rem)] w-full rounded-2xl" />
        <Skeleton className="h-[calc(100vh-10rem)] w-full rounded-2xl" />
        <Skeleton className="h-[calc(100vh-10rem)] w-full rounded-2xl" />
      </div>
    );
  }

  if (!document.data || !pages.data) {
    return <ErrorState body={copy.errors.documentNotFound} title="Document not found" />;
  }

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-thread bg-surface px-5 py-4">
        <div className="min-w-0">
          <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-amber">Case file</p>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <h1 className="truncate font-serif text-4xl text-ink">{document.data.filename}</h1>
            <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-ink-subtle">{document.data.page_count ?? pages.data.meta.count} pages</span>
            <PipelineBadge status={document.data.status} />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => setStoryRailOpen((open) => !open)} variant="secondary">
            {storyRailOpen ? <PanelRightClose className="size-4" /> : <PanelRightOpen className="size-4" />}
            {storyRailOpen ? 'Hide stories' : 'Show stories'}
          </Button>
          <Button onClick={() => window.open(pdfUrl, '_blank', 'noopener,noreferrer')} variant="secondary">
            <ExternalLink className="size-4" />
            Open PDF
          </Button>
          <a href={buildApiUrl(document.data.links.layout)} target="_blank" rel="noreferrer">
            <Button variant="secondary">
              <FileDown className="size-4" />
              Download layout
            </Button>
          </a>
        </div>
      </div>

      <div className={`grid gap-4 ${storyRailOpen ? 'lg:grid-cols-[5.5rem_minmax(0,1fr)_22rem]' : 'lg:grid-cols-[5.5rem_minmax(0,1fr)]'}`}>
        <PageThumbnails
          activePage={activePage}
          onSelectPage={(page) => pdfPaneRef.current?.scrollToPage(page)}
          pages={pages.data.data.pages}
          stories={stories.data ?? []}
        />
        <PDFPane
          activeStoryId={currentStory?.id ?? null}
          key={id}
          onPageChange={setActivePage}
          ref={pdfPaneRef}
          reveal={reveal}
          stories={stories.data ?? []}
          url={pdfUrl}
        />
        {storyRailOpen ? (
          <StoryList
            activeStoryId={selectedStoryId ?? currentStory?.id ?? null}
            contradictionCounts={contradictionCounts}
            onReadStory={(storyId) => navigate(routes.reading(id, storyId))}
            onStoryChange={setSelectedStoryId}
            reveal={reveal}
            stories={stories.data ?? []}
          />
        ) : null}
      </div>

      {document.data.layout_available ? (
        <div className="rounded-2xl border border-thread bg-surface px-5 py-4">
          <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-amber">Entities in this story</p>
          <div className="mt-4 flex flex-wrap gap-2">
            {(currentStory?.entities ?? []).map((entity, index) => (
              <div key={entity.id} style={reveal ? { animationDelay: `${index * 40}ms` } : undefined}>
                <EntityPill entity={entity} size="md" />
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="rounded-2xl border border-thread bg-surface px-5 py-4 text-sm text-ink-muted">
          {copy.errors.layoutUnavailable}
        </div>
      )}
    </section>
  );
}
