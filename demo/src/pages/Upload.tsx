import { ChangeEvent, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, ChevronRight, FileText, Loader2, Upload as UploadIcon, X } from 'lucide-react';

type UploadStage = 'idle' | 'ready' | 'uploading' | 'finalizing' | 'processing' | 'complete' | 'error';

interface UploadJobState {
  jobId: string;
  sourceId: string;
}

interface UploadTarget {
  url: string;
  method: 'PUT';
  headers: Record<string, string>;
  transport: 'gcs_resumable' | 'dev_proxy';
}

interface JobPayload {
  result_status?: 'created' | 'duplicate';
  resolved_source_id?: string;
  duplicate_of_source_id?: string;
  pipeline_job_id?: string;
}

interface JobDetailResponse {
  data: {
    job: {
      status: 'pending' | 'running' | 'completed' | 'failed' | 'dead_letter';
      error_log: string | null;
      payload: JobPayload;
    };
  };
}

const apiBase = import.meta.env.VITE_MULDER_API_BASE_URL ?? '';
const apiKey = import.meta.env.VITE_MULDER_API_KEY ?? '';

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${bytes} B`;
}

function apiUrl(path: string): string {
  return path.startsWith('http') ? path : `${apiBase}${path}`;
}

function buildApiHeaders(contentType = 'application/json'): HeadersInit {
  return {
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    'Content-Type': contentType,
  };
}

export default function UploadPage() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [stage, setStage] = useState<UploadStage>('idle');
  const [jobState, setJobState] = useState<UploadJobState | null>(null);
  const [sourceLink, setSourceLink] = useState<string | null>(null);
  const [resultLabel, setResultLabel] = useState<string>('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const fileSummary = useMemo(() => {
    if (!file) return null;
    return `${formatBytes(file.size)} · ${file.type || 'application/pdf'}`;
  }, [file]);

  useEffect(() => {
    if (!jobState) {
      return;
    }

    let cancelled = false;
    const interval = window.setInterval(async () => {
      try {
        const response = await fetch(apiUrl(`/api/jobs/${jobState.jobId}`), {
          headers: buildApiHeaders(),
        });
        if (!response.ok) {
          throw new Error(`Status polling failed (${response.status})`);
        }

        const body = (await response.json()) as JobDetailResponse;
        if (cancelled) {
          return;
        }

        const { job } = body.data;
        if (job.status === 'pending' || job.status === 'running') {
          setStage('processing');
          return;
        }

        window.clearInterval(interval);

        if (job.status === 'completed') {
          const resolvedSourceId = job.payload.resolved_source_id ?? jobState.sourceId;
          setSourceLink(`/sources/${resolvedSourceId}`);
          if (job.payload.result_status === 'duplicate') {
            setResultLabel('Dokument bereits vorhanden');
          } else {
            setResultLabel('Quelle angelegt und Pipeline gestartet');
          }
          setStage('complete');
          return;
        }

        setErrorMessage(job.error_log ?? 'Die Verarbeitung konnte nicht abgeschlossen werden.');
        setStage('error');
      } catch (error) {
        if (cancelled) {
          return;
        }
        setErrorMessage(error instanceof Error ? error.message : 'Statusprüfung fehlgeschlagen');
        setStage('error');
      }
    }, 1500);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [jobState]);

  const openPicker = () => {
    fileInputRef.current?.click();
  };

  const reset = () => {
    setFile(null);
    setJobState(null);
    setSourceLink(null);
    setResultLabel('');
    setErrorMessage(null);
    setStage('idle');
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleFileSelect = (event: ChangeEvent<HTMLInputElement>) => {
    const nextFile = event.target.files?.[0] ?? null;
    setFile(nextFile);
    setJobState(null);
    setSourceLink(null);
    setResultLabel('');
    setErrorMessage(null);
    setStage(nextFile ? 'ready' : 'idle');
  };

  const handleUpload = async () => {
    if (!file) {
      return;
    }

    setErrorMessage(null);
    setStage('uploading');

    try {
      const initiateResponse = await fetch(apiUrl('/api/uploads/documents/initiate'), {
        method: 'POST',
        headers: buildApiHeaders(),
        body: JSON.stringify({
          filename: file.name,
          size_bytes: file.size,
          content_type: file.type || 'application/pdf',
        }),
      });

      if (!initiateResponse.ok) {
        const error = (await initiateResponse.json()) as { error?: { message?: string } };
        throw new Error(error.error?.message ?? `Upload initiation failed (${initiateResponse.status})`);
      }

      const initiateBody = (await initiateResponse.json()) as {
        data: {
          source_id: string;
          storage_path: string;
          upload: UploadTarget;
        };
      };

      const uploadHeaders: HeadersInit = {
        ...initiateBody.data.upload.headers,
        'Content-Type': file.type || 'application/pdf',
        ...(initiateBody.data.upload.transport === 'dev_proxy' && apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      };

      const uploadResponse = await fetch(apiUrl(initiateBody.data.upload.url), {
        method: initiateBody.data.upload.method,
        headers: uploadHeaders,
        body: file,
      });

      if (!uploadResponse.ok) {
        throw new Error(`Direct upload failed (${uploadResponse.status})`);
      }

      setStage('finalizing');

      const completeResponse = await fetch(apiUrl('/api/uploads/documents/complete'), {
        method: 'POST',
        headers: buildApiHeaders(),
        body: JSON.stringify({
          source_id: initiateBody.data.source_id,
          filename: file.name,
          storage_path: initiateBody.data.storage_path,
          start_pipeline: true,
        }),
      });

      if (!completeResponse.ok) {
        const error = (await completeResponse.json()) as { error?: { message?: string } };
        throw new Error(error.error?.message ?? `Finalize failed (${completeResponse.status})`);
      }

      const completeBody = (await completeResponse.json()) as {
        data: {
          job_id: string;
          source_id: string;
        };
      };

      setJobState({
        jobId: completeBody.data.job_id,
        sourceId: completeBody.data.source_id,
      });
      setStage('processing');
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Upload fehlgeschlagen');
      setStage('error');
    }
  };

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <input
        ref={fileInputRef}
        type="file"
        accept="application/pdf,.pdf"
        className="hidden"
        onChange={handleFileSelect}
      />

      <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-6">
        <Link to="/" className="hover:text-foreground no-underline text-muted-foreground">Übersicht</Link>
        <ChevronRight size={12} />
        <span className="text-foreground font-medium">Quelle hochladen</span>
      </div>

      <h1 className="text-xl font-semibold mb-1">Quelldokument hochladen</h1>
      <p className="text-sm text-muted-foreground mb-6">
        Laden Sie ein PDF hoch. Mulder reserviert zuerst eine Upload-Session, überträgt die Datei direkt in den Speicher und startet danach die Verarbeitung im Hintergrund.
      </p>

      {(stage === 'idle' || stage === 'ready') && (
        <button
          onClick={openPicker}
          className="w-full rounded-[var(--radius)] border-2 border-dashed border-primary/40 bg-primary/5 p-12 text-center transition-colors hover:border-primary hover:bg-primary/10 cursor-pointer"
        >
          <UploadIcon size={40} className="mx-auto mb-4 text-primary/60" />
          <div className="text-sm font-medium text-foreground">PDF auswählen</div>
          <div className="mt-1 text-xs text-muted-foreground">Browser startet danach einen direkten Upload und queue-basiertes Finalisieren</div>
        </button>
      )}

      {file && (
        <div className="mt-6 rounded-[var(--radius)] border bg-card p-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-[var(--radius)] border bg-primary/10">
              <FileText size={20} className="text-primary" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium">{file.name}</div>
              <div className="text-xs text-muted-foreground">{fileSummary}</div>
            </div>
            {(stage === 'idle' || stage === 'ready' || stage === 'error') && (
              <button className="text-muted-foreground hover:text-foreground" onClick={reset}>
                <X size={16} />
              </button>
            )}
            {stage === 'complete' && (
              <span className="flex items-center gap-1.5 text-xs font-medium text-primary">
                <Check size={14} /> Abgeschlossen
              </span>
            )}
          </div>
        </div>
      )}

      {file && stage === 'ready' && (
        <div className="mt-6 rounded-[var(--radius)] border bg-card p-4 flex items-center justify-between gap-4">
          <div>
            <div className="text-sm font-medium">Bereit für den Upload</div>
            <div className="text-xs text-muted-foreground">Die API reserviert zuerst eine Session und die Datei geht dann direkt in den Speicher.</div>
          </div>
          <button
            onClick={handleUpload}
            className="flex items-center gap-1.5 rounded-[var(--radius)] border border-primary bg-primary px-4 py-2 text-xs font-medium text-primary-foreground"
          >
            <UploadIcon size={14} /> Upload starten
          </button>
        </div>
      )}

      {(stage === 'uploading' || stage === 'finalizing' || stage === 'processing') && (
        <div className="mt-6 rounded-[var(--radius)] border bg-card">
          <div className="border-b px-4 py-3">
            <h2 className="text-sm font-semibold">Verarbeitungsstatus</h2>
            <p className="text-xs text-muted-foreground mt-0.5">Die Seite kann geöffnet bleiben, während der Job im Hintergrund weiterläuft.</p>
          </div>
          <div className="p-4 space-y-3">
            {[
              { label: 'Upload-Session reservieren', active: stage !== 'uploading' ? false : true, done: stage === 'finalizing' || stage === 'processing' },
              { label: 'Datei direkt in den Speicher übertragen', active: stage === 'uploading', done: stage === 'finalizing' || stage === 'processing' },
              { label: 'Upload finalisieren', active: stage === 'finalizing', done: stage === 'processing' },
              { label: 'Pipeline-Job anlegen', active: stage === 'processing', done: false },
            ].map((step, index) => (
              <div key={step.label} className="flex items-center gap-3">
                <div className={`flex h-7 w-7 items-center justify-center rounded-full border text-xs font-mono font-bold ${
                  step.done
                    ? 'border-[#86efac] bg-[#dcfce7] text-[#15803d]'
                    : step.active
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border text-muted-foreground'
                }`}>
                  {step.done ? <Check size={14} /> : index + 1}
                </div>
                <div className="flex-1">
                  <div className={`text-xs font-medium ${step.active ? 'text-foreground' : 'text-muted-foreground'}`}>
                    {step.label}
                  </div>
                </div>
                {step.active && <Loader2 size={14} className="text-primary animate-spin" />}
              </div>
            ))}
          </div>
        </div>
      )}

      {stage === 'complete' && (
        <div className="mt-6 rounded-[var(--radius)] border border-primary/30 bg-primary/5 p-6">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <Check size={16} className="text-primary" />
            {resultLabel}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {sourceLink ? 'Die Quelle ist jetzt in der Bibliothek sichtbar.' : 'Der Job wurde abgeschlossen.'}
          </p>
          <div className="mt-4 flex items-center gap-3">
            {sourceLink && (
              <Link to={sourceLink} className="text-xs text-primary hover:underline no-underline">
                Zur Quelle
              </Link>
            )}
            <Link to="/sources" className="text-xs text-muted-foreground hover:text-foreground no-underline">
              Zur Quellen-Bibliothek
            </Link>
          </div>
        </div>
      )}

      {stage === 'error' && (
        <div className="mt-6 rounded-[var(--radius)] border border-red-300 bg-red-50 p-4">
          <div className="text-sm font-medium text-red-700">Upload fehlgeschlagen</div>
          <p className="mt-1 text-xs text-red-700/80">{errorMessage ?? 'Bitte erneut versuchen.'}</p>
          <button onClick={reset} className="mt-3 text-xs text-red-700 hover:underline">
            Neu starten
          </button>
        </div>
      )}
    </div>
  );
}
