import { UploadCloud } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/primitives/Button';
import { Dialog, DialogContent, DialogTitle } from '@/components/primitives/Dialog';
import { Input } from '@/components/primitives/Input';
import { useDocumentUpload, type UploadProgress } from '@/features/uploads/useDocumentUpload';
import { cn } from '@/lib/cn';

const phaseLabels: Record<UploadProgress['phase'], string> = {
  validating: 'Validating',
  uploading: 'Uploading',
  finalizing: 'Finalizing',
  queued: 'Queued',
  processing: 'Processing',
  complete: 'Complete',
  duplicate: 'Duplicate',
  failed: 'Failed',
};

export function UploadDialog() {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const upload = useDocumentUpload();
  const [open, setOpen] = useState(false);
  const [tags, setTags] = useState('');
  const [progress, setProgress] = useState<UploadProgress | null>(null);

  useEffect(() => {
    function handleOpenUpload() {
      setOpen(true);
    }

    window.addEventListener('mulder:open-upload', handleOpenUpload);
    return () => window.removeEventListener('mulder:open-upload', handleOpenUpload);
  }, []);

  async function handleFile(file: File | undefined) {
    if (!file) {
      return;
    }

    try {
      const nextTags = tags
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean);
      const result = await upload.mutateAsync({
        file,
        tags: nextTags,
        onProgress: setProgress,
      });
      toast.success(result.phase === 'duplicate' ? 'Duplicate detected' : 'Upload finalized');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Upload failed';
      setProgress({ phase: 'failed', message });
      toast.error(message);
    } finally {
      if (inputRef.current) {
        inputRef.current.value = '';
      }
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent aria-describedby={undefined} className="w-[min(92vw,34rem)]">
        <div className="space-y-5">
          <div>
            <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-amber">Browser upload</p>
            <DialogTitle className="mt-2 font-serif text-3xl text-ink">Add a document to the archive.</DialogTitle>
            <p className="mt-2 text-sm text-ink-muted">
              This flow uses the upload contract: initiate, direct upload, finalize job, then worker polling.
            </p>
          </div>

          <label className="block space-y-2 text-sm text-ink-muted">
            Tags
            <Input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="field-note, source" />
          </label>

          <div className="rounded-xl border border-dashed border-thread-strong bg-surface p-6 text-center">
            <UploadCloud className="mx-auto size-8 text-amber" />
            <p className="mt-3 font-serif text-2xl text-ink">Choose a PDF</p>
            <p className="mt-1 text-sm text-ink-muted">Upload finalization requires the worker to be running.</p>
            <input
              ref={inputRef}
              accept="application/pdf,.pdf"
              className="sr-only"
              data-testid="document-upload-input"
              type="file"
              onChange={(event) => void handleFile(event.target.files?.[0])}
            />
            <Button className="mt-4" disabled={upload.isPending} onClick={() => inputRef.current?.click()}>
              {upload.isPending ? 'Working...' : 'Select PDF'}
            </Button>
          </div>

          {progress ? (
            <div
              className={cn(
                'rounded-xl border p-4 text-sm',
                progress.phase === 'failed'
                  ? 'border-carmine-soft bg-carmine-faint text-carmine'
                  : progress.phase === 'complete' || progress.phase === 'duplicate'
                    ? 'border-sage-soft bg-sage-faint text-sage'
                    : 'border-amber-soft bg-amber-faint text-ink',
              )}
            >
              <p className="font-mono text-[11px] uppercase tracking-[0.2em]">{phaseLabels[progress.phase]}</p>
              <p className="mt-1">{progress.message}</p>
              {progress.jobId ? <p className="mt-2 font-mono text-xs text-ink-muted">Job {progress.jobId}</p> : null}
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
