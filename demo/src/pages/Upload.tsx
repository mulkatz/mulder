import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Upload as UploadIcon, FileText, X, Sparkles, Check, ChevronRight, Loader2 } from 'lucide-react';

type UploadStage = 'idle' | 'dropped' | 'analyzing' | 'metadata' | 'processing';

const autoFilledFields = [
  { label: 'Source Type', value: 'Magazine', filled: true },
  { label: 'Title', value: 'Der Spiegel', filled: true },
  { label: 'Issue', value: '42/2023', filled: true },
  { label: 'Publisher', value: 'SPIEGEL-Verlag', filled: true },
  { label: 'Date', value: '2023-10-16', filled: true },
  { label: 'Language', value: 'German', filled: true },
  { label: 'Pages', value: '84', filled: true },
];

export default function UploadPage() {
  const [stage, setStage] = useState<UploadStage>('idle');
  const [visibleFields, setVisibleFields] = useState(0);

  const handleDrop = () => {
    setStage('dropped');
    setTimeout(() => {
      setStage('analyzing');
      setTimeout(() => {
        setStage('metadata');
        // Animate fields appearing one by one
        autoFilledFields.forEach((_, i) => {
          setTimeout(() => setVisibleFields(i + 1), 300 + i * 200);
        });
      }, 1500);
    }, 800);
  };

  const handleConfirm = () => {
    setStage('processing');
  };

  return (
    <div className="p-6 max-w-3xl mx-auto">
      {/* Breadcrumb */}
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-6">
        <Link to="/" className="hover:text-foreground no-underline text-muted-foreground">Dashboard</Link>
        <ChevronRight size={12} />
        <span className="text-foreground font-medium">Upload Source</span>
      </div>

      <h1 className="text-xl font-semibold mb-1">Upload Source Document</h1>
      <p className="text-sm text-muted-foreground mb-6">
        Upload a PDF and the AI will automatically extract metadata, identify articles, and connect entities.
      </p>

      {stage === 'idle' && (
        <button
          onClick={handleDrop}
          className="w-full rounded-[var(--radius)] border-2 border-dashed border-primary/40 bg-primary/5 p-12 text-center transition-colors hover:border-primary hover:bg-primary/10 cursor-pointer"
        >
          <UploadIcon size={40} className="mx-auto mb-4 text-primary/60" />
          <div className="text-sm font-medium text-foreground">Drop PDF files here or click to browse</div>
          <div className="mt-1 text-xs text-muted-foreground">Supports single files or batch upload · PDF only · Max 500MB</div>
        </button>
      )}

      {stage === 'dropped' && (
        <div className="rounded-[var(--radius)] border bg-card p-6">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-[var(--radius)] border bg-muted">
              <FileText size={20} className="text-muted-foreground" />
            </div>
            <div className="flex-1">
              <div className="text-sm font-medium">Der_Spiegel_42_2023.pdf</div>
              <div className="text-xs text-muted-foreground">24.7 MB · Uploading...</div>
            </div>
            <div className="h-1.5 w-32 overflow-hidden rounded-full bg-muted">
              <div className="h-full w-3/4 rounded-full bg-primary animate-pulse" />
            </div>
          </div>
        </div>
      )}

      {(stage === 'analyzing' || stage === 'metadata' || stage === 'processing') && (
        <div className="space-y-6">
          {/* File info */}
          <div className="rounded-[var(--radius)] border bg-card p-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-[var(--radius)] border bg-primary/10">
                <FileText size={20} className="text-primary" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium">Der_Spiegel_42_2023.pdf</div>
                <div className="text-xs text-muted-foreground">24.7 MB · 84 pages</div>
              </div>
              {stage !== 'processing' && (
                <button className="text-muted-foreground hover:text-foreground">
                  <X size={16} />
                </button>
              )}
              {stage === 'processing' && (
                <span className="flex items-center gap-1.5 text-xs font-medium text-primary">
                  <Check size={14} /> Uploaded
                </span>
              )}
            </div>
          </div>

          {/* AI Analysis indicator */}
          {stage === 'analyzing' && (
            <div className="rounded-[var(--radius)] border border-primary/30 bg-primary/5 p-6 text-center">
              <Loader2 size={24} className="mx-auto mb-3 text-primary animate-spin" />
              <div className="text-sm font-medium">AI is analyzing the document...</div>
              <div className="mt-1 text-xs text-muted-foreground">Reading cover page and table of contents to extract metadata</div>
            </div>
          )}

          {/* Metadata form - auto-filled by AI */}
          {(stage === 'metadata' || stage === 'processing') && (
            <div className="rounded-[var(--radius)] border bg-card">
              <div className="flex items-center gap-2 border-b px-4 py-3">
                <Sparkles size={14} className="text-accent dark:text-accent" />
                <h2 className="text-sm font-semibold">Metadata — auto-filled by AI</h2>
                <span className="ml-auto rounded bg-primary/10 px-2 py-0.5 font-mono text-[10px] font-medium text-primary">
                  Gemini 2.5 Flash
                </span>
              </div>
              <div className="p-4 space-y-3">
                {autoFilledFields.map((field, i) => (
                  <div
                    key={field.label}
                    className={`transition-all duration-300 ${
                      i < visibleFields ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2 h-0 overflow-hidden'
                    }`}
                  >
                    <label className="block text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1">
                      {field.label}
                    </label>
                    <div className="relative">
                      <div className={`rounded-[var(--radius)] border px-3 py-2 text-sm ${
                        stage === 'processing' ? 'bg-muted/50 text-muted-foreground' : 'bg-card'
                      }`}>
                        {field.value}
                      </div>
                      {field.filled && i < visibleFields && stage !== 'processing' && (
                        <span className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1 text-[10px] text-primary font-medium">
                          <Sparkles size={10} /> AI
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              {stage === 'metadata' && visibleFields >= autoFilledFields.length && (
                <div className="border-t px-4 py-3 flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">
                    Review and correct if needed. AI confidence: <span className="font-mono font-medium text-green-600 dark:text-green-400">94%</span>
                  </span>
                  <button
                    onClick={handleConfirm}
                    className="flex items-center gap-1.5 rounded-[var(--radius)] border border-primary bg-primary px-4 py-2 text-xs font-medium text-primary-foreground"
                  >
                    <Check size={14} /> Confirm & Start Processing
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Processing pipeline */}
          {stage === 'processing' && (
            <div className="rounded-[var(--radius)] border bg-card">
              <div className="border-b px-4 py-3">
                <h2 className="text-sm font-semibold">Processing Pipeline</h2>
                <p className="text-xs text-muted-foreground mt-0.5">Estimated time: 3–5 minutes</p>
              </div>
              <div className="p-4 space-y-3">
                {['OCR & Layout Analysis', 'Story Segmentation', 'Entity Extraction', 'Embedding Generation', 'Graph Update'].map((step, i) => {
                  const isActive = i === 1;
                  const isDone = i === 0;
                  return (
                    <div key={step} className="flex items-center gap-3">
                      <div className={`flex h-7 w-7 items-center justify-center rounded-full border text-xs font-mono font-bold ${
                        isDone
                          ? 'border-green-500 bg-green-50 text-green-600 dark:bg-green-900/30 dark:text-green-400'
                          : isActive
                          ? 'border-primary bg-primary/10 text-primary'
                          : 'border-border text-muted-foreground'
                      }`}>
                        {isDone ? <Check size={14} /> : i + 1}
                      </div>
                      <div className="flex-1">
                        <div className={`text-xs font-medium ${isDone ? 'text-muted-foreground' : isActive ? 'text-foreground' : 'text-muted-foreground'}`}>
                          {step}
                        </div>
                        {isActive && (
                          <div className="mt-1.5">
                            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                              <div className="h-full w-2/5 rounded-full bg-primary transition-all animate-pulse" />
                            </div>
                            <div className="mt-1 font-mono text-[10px] text-muted-foreground">
                              Identifying articles and story boundaries... 12 stories found so far
                            </div>
                          </div>
                        )}
                        {isDone && (
                          <div className="text-[10px] text-muted-foreground">84 pages analyzed · 342 text blocks · 47 images detected</div>
                        )}
                      </div>
                      {isActive && <Loader2 size={14} className="text-primary animate-spin" />}
                    </div>
                  );
                })}
              </div>
              <div className="border-t px-4 py-3 flex items-center justify-between">
                <span className="text-xs text-muted-foreground">
                  You can leave this page — processing continues in the background.
                </span>
                <Link to="/" className="text-xs text-primary hover:underline no-underline">
                  Back to Dashboard
                </Link>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
