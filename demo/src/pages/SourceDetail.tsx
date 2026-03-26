import { Link } from 'react-router-dom';
import { ChevronRight, Download, FileText, Eye } from 'lucide-react';
import EntityBadge from '../components/EntityBadge';
import ConfidenceBadge from '../components/ConfidenceBadge';
import StatusBadge from '../components/StatusBadge';
import { stories } from '../data/mock';

const sourceStories = stories.filter(s => s.source === 'MUFON UFO Journal 03/2017');

const storyOverlayColors = [
  'border-blue-400 bg-blue-400/15',
  'border-orange-400 bg-orange-400/15',
  'border-purple-400 bg-purple-400/15',
  'border-green-400 bg-green-400/15',
];

export default function SourceDetail() {
  return (
    <div className="flex flex-col h-[calc(100vh-48px)]">
      {/* Source Header */}
      <div className="border-b px-6 py-3">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-2">
          <Link to="/" className="hover:text-foreground no-underline text-muted-foreground">Übersicht</Link>
          <ChevronRight size={12} />
          <span>Quellen</span>
          <ChevronRight size={12} />
          <span className="text-foreground font-medium">MUFON UFO Journal 03/2017</span>
        </div>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <h1 className="text-lg font-semibold">MUFON UFO Journal</h1>
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <span className="font-mono">Ausgabe: 03/2017</span>
              <span className="font-mono">96 Seiten</span>
              <StatusBadge status="processed" />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button className="flex items-center gap-1.5 rounded-[var(--radius)] border px-3 py-1.5 text-xs text-muted-foreground hover:bg-secondary">
              <Download size={12} /> PDF herunterladen
            </button>
            <Link
              to="/sources/1/review/1"
              className="flex items-center gap-1.5 rounded-[var(--radius)] border border-primary bg-primary px-3 py-1.5 text-xs text-primary-foreground no-underline"
            >
              <Eye size={12} /> Berichte prüfen
            </Link>
          </div>
        </div>
      </div>

      {/* Three-column layout */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left: Page Thumbnails */}
        <div className="w-20 border-r overflow-y-auto bg-muted/30 p-2 space-y-2">
          {Array.from({ length: 12 }, (_, idx) => (
            <button
              key={idx}
              className={`w-full aspect-[3/4] rounded-[var(--radius)] border text-[9px] font-mono flex items-center justify-center transition-colors ${
                idx >= 3 && idx <= 6
                  ? 'border-primary bg-primary/5 text-primary font-medium'
                  : idx > 8
                  ? 'border-border bg-muted/50 text-muted-foreground/40'
                  : 'border-border bg-card text-muted-foreground hover:border-muted-foreground'
              }`}
            >
              {idx + 12}
            </button>
          ))}
        </div>

        {/* Center: PDF Page View */}
        <div className="flex-1 overflow-auto bg-muted/20 p-8 flex items-start justify-center">
          <div className="relative w-full max-w-[600px] aspect-[3/4] bg-card border shadow-hard rounded-[var(--radius)] overflow-hidden">
            {/* Simulated page content */}
            <div className="absolute inset-0 p-6 space-y-3">
              {/* Header area */}
              <div className="flex items-center justify-between mb-4">
                <div className="h-2.5 w-24 rounded bg-muted-foreground/20" />
                <div className="font-mono text-[9px] text-muted-foreground">p. 14</div>
              </div>

              {/* Headline */}
              <div className="space-y-1.5 mb-4">
                <div className="h-4 w-4/5 rounded bg-foreground/80" />
                <div className="h-4 w-3/5 rounded bg-foreground/80" />
              </div>

              {/* Story overlays */}
              <div className={`relative rounded border-2 border-dashed p-3 space-y-1.5 ${storyOverlayColors[0]}`}>
                <div className="absolute -top-2.5 left-2 bg-card px-1.5 text-[9px] font-mono font-medium text-blue-600 dark:text-blue-400">
                  Bericht 1: Tic-Tac-Objekt
                </div>
                <div className="h-2 w-full rounded bg-foreground/10" />
                <div className="h-2 w-full rounded bg-foreground/10" />
                <div className="h-2 w-11/12 rounded bg-foreground/10" />
                <div className="h-2 w-full rounded bg-foreground/10" />
                <div className="h-2 w-3/4 rounded bg-foreground/10" />
                <div className="mt-2 h-2 w-full rounded bg-foreground/10" />
                <div className="h-2 w-full rounded bg-foreground/10" />
                <div className="h-2 w-5/6 rounded bg-foreground/10" />
              </div>

              <div className={`relative rounded border-2 border-dashed p-3 space-y-1.5 ${storyOverlayColors[1]}`}>
                <div className="absolute -top-2.5 left-2 bg-card px-1.5 text-[9px] font-mono font-medium text-orange-600 dark:text-orange-400">
                  Bericht 2: Phoenix Lights
                </div>
                <div className="h-2 w-full rounded bg-foreground/10" />
                <div className="h-2 w-full rounded bg-foreground/10" />
                <div className="h-2 w-4/5 rounded bg-foreground/10" />
                <div className="h-2 w-full rounded bg-foreground/10" />
                <div className="h-2 w-2/3 rounded bg-foreground/10" />
              </div>

              {/* Image placeholder */}
              <div className="h-24 rounded border-2 border-dashed border-muted-foreground/20 flex items-center justify-center">
                <span className="font-mono text-[10px] text-muted-foreground/40">[BILD: Radaraufzeichnung FLIR1]</span>
              </div>

              <div className={`relative rounded border-2 border-dashed p-3 space-y-1.5 ${storyOverlayColors[2]}`}>
                <div className="absolute -top-2.5 left-2 bg-card px-1.5 text-[9px] font-mono font-medium text-purple-600 dark:text-purple-400">
                  Bericht 3: USS Roosevelt
                </div>
                <div className="h-2 w-full rounded bg-foreground/10" />
                <div className="h-2 w-full rounded bg-foreground/10" />
                <div className="h-2 w-5/6 rounded bg-foreground/10" />
              </div>
            </div>
          </div>
        </div>

        {/* Right: Story List */}
        <div className="w-80 border-l overflow-y-auto">
          <div className="border-b px-4 py-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold">Berichte ({sourceStories.length})</h3>
            <FileText size={14} className="text-muted-foreground" />
          </div>
          <div className="divide-y">
            {sourceStories.map((story) => (
              <Link
                key={story.id}
                to="/sources/1/review/1"
                className="block px-4 py-3 hover:bg-muted/50 transition-colors no-underline"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-foreground">{story.title}</div>
                    <div className="mt-1 flex items-center gap-2">
                      <span className="font-mono text-[10px] text-muted-foreground">pp. {story.pages}</span>
                      <span className="rounded bg-muted px-1.5 py-0 text-[10px] font-medium text-muted-foreground">
                        {story.category}
                      </span>
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    <ConfidenceBadge value={story.confidence} size="xs" />
                    <StatusBadge status={story.reviewStatus} />
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap gap-1">
                  {story.entities.slice(0, 3).map((e) => (
                    <EntityBadge key={e.id} type={e.type} name={e.name} size="xs" />
                  ))}
                  {story.entities.length > 3 && (
                    <span className="text-[10px] text-muted-foreground">+{story.entities.length - 3}</span>
                  )}
                </div>
              </Link>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
