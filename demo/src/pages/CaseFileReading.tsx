import { useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { PDFPane } from '@/components/PDFPane/PDFPane';
import { StoryReader } from '@/components/Story/StoryReader';
import { ErrorState } from '@/components/shared/ErrorState';
import { Skeleton } from '@/components/shared/Skeleton';
import { useDocument } from '@/features/documents/useDocument';
import { usePdfUrl } from '@/features/documents/usePdfUrl';
import { useStoriesForDocument } from '@/features/documents/useStoriesForDocument';
import { copy } from '@/lib/copy';
import { routes } from '@/lib/routes';

export function CaseFileReadingPage() {
  const navigate = useNavigate();
  const { id = '', storyId = '' } = useParams();
  const document = useDocument(id);
  const stories = useStoriesForDocument(id);
  const pdfUrl = usePdfUrl(id);
  const story = stories.data?.find((item) => item.id === storyId) ?? null;

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        navigate(routes.caseFile(id));
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [id, navigate]);

  if (document.isLoading || stories.isLoading) {
    return <Skeleton className="h-[calc(100vh-10rem)] w-full rounded-2xl" />;
  }

  if (!story) {
    return <ErrorState body={copy.errors.documentNotFound} title="Story not found" />;
  }

  return (
    <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(24rem,44rem)]">
      <div className="opacity-40 grayscale">
        <PDFPane activeStoryId={story.id} key={id} onPageChange={() => undefined} reveal={false} stories={[story]} url={pdfUrl} />
      </div>
      <StoryReader onBack={() => navigate(routes.caseFile(id))} story={story} />
    </section>
  );
}
