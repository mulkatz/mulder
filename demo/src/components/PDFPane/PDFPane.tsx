import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type { PDFPageProxy } from 'pdfjs-dist/types/src/display/api';
import type { StoryRecord } from '@/lib/api-types';
import { ErrorState } from '@/components/shared/ErrorState';
import { Skeleton } from '@/components/shared/Skeleton';
import { usePdfDocument } from '@/components/PDFPane/usePdfDocument';
import { copy } from '@/lib/copy';
import { StoryFrames } from './StoryFrames';

export interface PDFPaneHandle {
  scrollToPage: (pageNumber: number) => void;
}

function PdfCanvas({
  page,
  shouldRender,
  pageNumber,
}: {
  page: PDFPageProxy | null;
  shouldRender: boolean;
  pageNumber: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!page || !canvasRef.current || !shouldRender) {
      return;
    }

    const canvas = canvasRef.current;
    const containerWidth = canvas.parentElement?.clientWidth ?? 860;
    const baseViewport = page.getViewport({ scale: 1 });
    const scale = Math.min(containerWidth / baseViewport.width, 1.4);
    const viewport = page.getViewport({ scale });
    const context = canvas.getContext('2d');

    if (!context) {
      return;
    }

    canvas.width = viewport.width;
    canvas.height = viewport.height;
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;

    const task = page.render({ canvas, canvasContext: context, viewport });

    return () => {
      task.cancel();
    };
  }, [page, shouldRender]);

  return (
    <div className="relative">
      <canvas
        aria-label={`Rendered PDF page ${pageNumber}`}
        className="block max-w-full"
        data-testid="pdf-canvas"
        ref={canvasRef}
      />
    </div>
  );
}

export const PDFPane = forwardRef<PDFPaneHandle, {
  url: string;
  stories: StoryRecord[];
  activeStoryId: string | null;
  onPageChange: (page: number) => void;
  reveal: boolean;
}>(function PDFPane({ url, stories, activeStoryId, onPageChange, reveal }, ref) {
  const { doc, numPages, loading, error } = usePdfDocument(url);
  const [pages, setPages] = useState<Map<number, PDFPageProxy>>(new Map());
  const [currentPage, setCurrentPage] = useState(1);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  useEffect(() => {
    if (!doc) {
      return;
    }

    let cancelled = false;
    const currentDoc = doc;

    async function loadPages() {
      const loadedPages = new Map<number, PDFPageProxy>();

      for (let pageNumber = 1; pageNumber <= currentDoc.numPages; pageNumber += 1) {
        const page = await currentDoc.getPage(pageNumber);
        loadedPages.set(pageNumber, page);
      }

      if (!cancelled) {
        setPages(loadedPages);
      }
    }

    void loadPages();

    return () => {
      cancelled = true;
    };
  }, [doc]);

  useEffect(() => {
    const root = containerRef.current;

    if (!root) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const visibleEntry = entries
          .filter((entry) => entry.isIntersecting)
          .sort((left, right) => right.intersectionRatio - left.intersectionRatio)[0];

        if (!visibleEntry) {
          return;
        }

        const pageNumber = Number(visibleEntry.target.getAttribute('data-page'));
        setCurrentPage(pageNumber);
        onPageChange(pageNumber);
      },
      {
        root,
        rootMargin: '0px',
        threshold: [0.25, 0.5, 0.75],
      },
    );

    for (const page of pageRefs.current.values()) {
      observer.observe(page);
    }

    return () => {
      observer.disconnect();
    };
  }, [numPages, onPageChange, pages]);

  useImperativeHandle(
    ref,
    () => ({
      scrollToPage(pageNumber: number) {
        pageRefs.current.get(pageNumber)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      },
    }),
    [],
  );

  const renderWindow = useMemo(() => {
    if (numPages <= 30) {
      return null;
    }

    return {
      start: Math.max(1, currentPage - 3),
      end: Math.min(numPages, currentPage + 3),
    };
  }, [currentPage, numPages]);

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-20 w-full rounded-xl" />
        <Skeleton className="h-[720px] w-full rounded-2xl" />
      </div>
    );
  }

  if (error) {
    return <ErrorState body={copy.errors.pdfRead} title="PDF unavailable" />;
  }

  return (
    <div className="h-[calc(100vh-10rem)] overflow-auto rounded-2xl border border-thread bg-surface px-4 py-5" ref={containerRef}>
      <div className="mx-auto flex max-w-[920px] flex-col gap-6">
        {Array.from({ length: numPages }, (_, index) => index + 1).map((pageNumber) => {
          const shouldRender = renderWindow ? pageNumber >= renderWindow.start && pageNumber <= renderWindow.end : true;
          const page = pages.get(pageNumber) ?? null;

          return (
            <div
              key={pageNumber}
              className="relative overflow-hidden rounded-2xl border border-thread bg-white shadow-md"
              data-page={pageNumber}
              data-testid="pdf-page"
              ref={(node) => {
                if (node) {
                  pageRefs.current.set(pageNumber, node);
                }
              }}
            >
              <div className="flex items-center justify-between border-b border-thread bg-paper px-4 py-2">
                <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-ink-subtle">Page {pageNumber}</span>
                <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-ink-subtle">
                  {copy.loading.document(pageNumber, numPages)}
                </span>
              </div>
              <PdfCanvas page={page} pageNumber={pageNumber} shouldRender={shouldRender} />
              <StoryFrames activeStoryId={activeStoryId} pageNumber={pageNumber} reveal={reveal} stories={stories} />
            </div>
          );
        })}
      </div>
    </div>
  );
});
