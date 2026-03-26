import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Upload as UploadIcon, FileText, X, Sparkles, Check, ChevronRight, Loader2 } from 'lucide-react';

type UploadStage = 'idle' | 'dropped' | 'analyzing' | 'metadata' | 'processing';

const autoFilledFields = [
  { label: 'Quellentyp', value: 'Fachzeitschrift', filled: true },
  { label: 'Titel', value: 'MUFON UFO Journal', filled: true },
  { label: 'Ausgabe', value: '03/2017', filled: true },
  { label: 'Herausgeber', value: 'MUFON Inc.', filled: true },
  { label: 'Datum', value: '2017-03-01', filled: true },
  { label: 'Sprache', value: 'Englisch', filled: true },
  { label: 'Seiten', value: '96', filled: true },
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
        <Link to="/" className="hover:text-foreground no-underline text-muted-foreground">Übersicht</Link>
        <ChevronRight size={12} />
        <span className="text-foreground font-medium">Quelle hochladen</span>
      </div>

      <h1 className="text-xl font-semibold mb-1">Quelldokument hochladen</h1>
      <p className="text-sm text-muted-foreground mb-6">
        Laden Sie ein PDF hoch — die KI extrahiert automatisch Metadaten, identifiziert Artikel und verknüpft Akteure.
      </p>

      {stage === 'idle' && (
        <button
          onClick={handleDrop}
          className="w-full rounded-[var(--radius)] border-2 border-dashed border-primary/40 bg-primary/5 p-12 text-center transition-colors hover:border-primary hover:bg-primary/10 cursor-pointer"
        >
          <UploadIcon size={40} className="mx-auto mb-4 text-primary/60" />
          <div className="text-sm font-medium text-foreground">PDF-Dateien hierher ziehen oder klicken zum Durchsuchen</div>
          <div className="mt-1 text-xs text-muted-foreground">Einzeldateien oder Stapel-Upload · Nur PDF · Max 500 MB</div>
        </button>
      )}

      {stage === 'dropped' && (
        <div className="rounded-[var(--radius)] border bg-card p-6">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-[var(--radius)] border bg-muted">
              <FileText size={20} className="text-muted-foreground" />
            </div>
            <div className="flex-1">
              <div className="text-sm font-medium">MUFON_UFO_Journal_03_2017.pdf</div>
              <div className="text-xs text-muted-foreground">18.4 MB · Wird hochgeladen...</div>
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
                <div className="text-sm font-medium">MUFON_UFO_Journal_03_2017.pdf</div>
                <div className="text-xs text-muted-foreground">18.4 MB · 96 Seiten</div>
              </div>
              {stage !== 'processing' && (
                <button className="text-muted-foreground hover:text-foreground">
                  <X size={16} />
                </button>
              )}
              {stage === 'processing' && (
                <span className="flex items-center gap-1.5 text-xs font-medium text-primary">
                  <Check size={14} /> Hochgeladen
                </span>
              )}
            </div>
          </div>

          {/* AI Analysis indicator */}
          {stage === 'analyzing' && (
            <div className="rounded-[var(--radius)] border border-primary/30 bg-primary/5 p-6 text-center">
              <Loader2 size={24} className="mx-auto mb-3 text-primary animate-spin" />
              <div className="text-sm font-medium">KI analysiert das Dokument...</div>
              <div className="mt-1 text-xs text-muted-foreground">Liest Titelseite und Inhaltsverzeichnis zur Metadaten-Extraktion</div>
            </div>
          )}

          {/* Metadata form - auto-filled by AI */}
          {(stage === 'metadata' || stage === 'processing') && (
            <div className="rounded-[var(--radius)] border bg-card">
              <div className="flex items-center gap-2 border-b px-4 py-3">
                <Sparkles size={14} className="text-accent dark:text-accent" />
                <h2 className="text-sm font-semibold">Metadaten — automatisch von KI ausgefüllt</h2>
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
                    Prüfen und bei Bedarf korrigieren. KI-Konfidenz: <span className="font-mono font-medium text-green-600 dark:text-green-400">94%</span>
                  </span>
                  <button
                    onClick={handleConfirm}
                    className="flex items-center gap-1.5 rounded-[var(--radius)] border border-primary bg-primary px-4 py-2 text-xs font-medium text-primary-foreground"
                  >
                    <Check size={14} /> Bestätigen & Verarbeitung starten
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Processing pipeline */}
          {stage === 'processing' && (
            <div className="rounded-[var(--radius)] border bg-card">
              <div className="border-b px-4 py-3">
                <h2 className="text-sm font-semibold">Verarbeitungs-Pipeline</h2>
                <p className="text-xs text-muted-foreground mt-0.5">Geschätzte Dauer: 3–5 Minuten</p>
              </div>
              <div className="p-4 space-y-3">
                {['OCR & Layout-Analyse', 'Berichts-Segmentierung', 'Akteur-Extraktion', 'Embedding-Generierung', 'Netzwerk-Aktualisierung'].map((step, i) => {
                  const isActive = i === 1;
                  const isDone = i === 0;
                  return (
                    <div key={step} className="flex items-center gap-3">
                      <div className={`flex h-7 w-7 items-center justify-center rounded-full border text-xs font-mono font-bold ${
                        isDone
                          ? 'border-[#86efac] bg-[#dcfce7] text-[#15803d] dark:bg-green-900/30 dark:text-green-400'
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
                              Identifiziere Artikel und Berichtsgrenzen... 12 Berichte bisher gefunden
                            </div>
                          </div>
                        )}
                        {isDone && (
                          <div className="text-[10px] text-muted-foreground">96 Seiten analysiert · 387 Textblöcke · 52 Bilder erkannt</div>
                        )}
                      </div>
                      {isActive && <Loader2 size={14} className="text-primary animate-spin" />}
                    </div>
                  );
                })}
              </div>
              <div className="border-t px-4 py-3 flex items-center justify-between">
                <span className="text-xs text-muted-foreground">
                  Sie können diese Seite verlassen — die Verarbeitung läuft im Hintergrund weiter.
                </span>
                <Link to="/" className="text-xs text-primary hover:underline no-underline">
                  Zurück zur Übersicht
                </Link>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
