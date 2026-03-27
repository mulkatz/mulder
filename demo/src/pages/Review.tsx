import { Link } from 'react-router-dom';
import { ChevronRight, ChevronLeft, Check, SkipForward, Flag, Plus, Keyboard } from 'lucide-react';
import EntityBadge from '../components/EntityBadge';
import ConfidenceBadge from '../components/ConfidenceBadge';
import StatusBadge from '../components/StatusBadge';
import { stories, reviewText, entityTypeLabels } from '../data/mock';
import type { EntityType } from '../data/mock';

const story = stories[0];
const storyEntities = story.entities;

const entityCssMap: Record<EntityType, { bg: string; text: string }> = {
  person: { bg: 'bg-entity-person-bg', text: 'text-entity-person' },
  organization: { bg: 'bg-entity-organization-bg', text: 'text-entity-organization' },
  event: { bg: 'bg-entity-event-bg', text: 'text-entity-event' },
  location: { bg: 'bg-entity-location-bg', text: 'text-entity-location' },
};

function renderHighlightedText(text: string) {
  const parts = text.split(/(<entity-(?:person|organization|event|location)>.*?<\/entity-(?:person|organization|event|location)>)/g);
  return parts.map((part, i) => {
    const match = part.match(/<entity-(person|organization|event|location)>(.*?)<\/entity-/);
    if (match) {
      const type = match[1] as EntityType;
      const name = match[2];
      const css = entityCssMap[type];
      // Find matching entity for correct link
      const entity = storyEntities.find(e => e.name === name) || stories.flatMap(s => s.entities).find(e => e.name === name);
      const href = entity ? `/entities/${entity.id}` : '#';
      return (
        <Link
          key={i}
          to={href}
          className={`${css.bg} ${css.text} rounded-sm px-1 py-0.5 font-mono text-[12px] font-medium no-underline hover:opacity-80 border-b-2 border-current/20`}
        >
          {name}
        </Link>
      );
    }
    return <span key={i}>{part}</span>;
  });
}

export default function Review() {
  return (
    <div className="flex flex-col h-[calc(100vh-48px)]">
      {/* Review Toolbar */}
      <div className="border-b px-4 py-2 flex items-center justify-between bg-card">
        <div className="flex items-center gap-3">
          {/* Breadcrumb */}
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Link to="/sources/1" className="hover:text-foreground no-underline text-muted-foreground">MUFON UFO Journal 03/2017</Link>
            <ChevronRight size={12} />
            <span className="text-foreground font-medium">Prüfung</span>
          </div>

          {/* Story Navigation */}
          <div className="flex items-center gap-1.5 border-l pl-3">
            <button className="flex h-6 w-6 items-center justify-center rounded-[var(--radius)] border text-muted-foreground hover:bg-secondary">
              <ChevronLeft size={14} />
            </button>
            <span className="font-mono text-xs text-muted-foreground">
              Bericht <span className="text-foreground font-medium">3</span> von 12
            </span>
            <button className="flex h-6 w-6 items-center justify-center rounded-[var(--radius)] border text-muted-foreground hover:bg-secondary">
              <ChevronRight size={14} />
            </button>
          </div>

          {/* Confidence */}
          <div className="flex items-center gap-2 border-l pl-3">
            <span className="text-xs text-muted-foreground">Konfidenz:</span>
            <ConfidenceBadge value={story.confidence} />
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Shortcuts hint */}
          <div className="hidden lg:flex items-center gap-2 mr-3 text-[10px] text-muted-foreground">
            <Keyboard size={10} />
            <kbd className="rounded border bg-muted px-1 py-0.5 font-mono">Enter</kbd> Freigeben
            <kbd className="rounded border bg-muted px-1 py-0.5 font-mono">S</kbd> Überspringen
            <kbd className="rounded border bg-muted px-1 py-0.5 font-mono">F</kbd> Markieren
          </div>

          <button className="flex items-center gap-1.5 rounded-[var(--radius)] border px-3 py-1.5 text-xs text-muted-foreground hover:bg-secondary">
            <SkipForward size={12} /> Überspringen
          </button>
          <button className="flex items-center gap-1.5 rounded-[var(--radius)] border border-amber-400 px-3 py-1.5 text-xs text-amber-600 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-900/20">
            <Flag size={12} /> Markieren
          </button>
          <button className="flex items-center gap-1.5 rounded-[var(--radius)] border border-primary bg-primary px-3 py-1.5 text-xs text-primary-foreground">
            <Check size={12} /> Freigeben
          </button>
        </div>
      </div>

      {/* Split View */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left: PDF View */}
        <div className="flex-1 overflow-auto bg-muted/20 p-6 flex items-start justify-center border-r">
          <div className="relative w-full max-w-[540px] bg-card border shadow-hard rounded-[var(--radius)] overflow-hidden">
            {/* Page header */}
            <div className="border-b px-4 py-2 flex items-center justify-between bg-muted/30">
              <span className="font-mono text-[10px] text-muted-foreground">MUFON UFO JOURNAL 03/2017</span>
              <span className="font-mono text-[10px] text-muted-foreground">pp. 12–18</span>
            </div>
            <div className="p-6 space-y-3">
              {/* Headline */}
              <div className="space-y-1.5 mb-4">
                <div className="h-5 w-4/5 rounded bg-foreground/80" />
                <div className="h-5 w-2/3 rounded bg-foreground/80" />
              </div>
              <div className="h-3 w-24 rounded bg-muted-foreground/30 mb-4" />

              {/* Active story region - highlighted */}
              <div className="relative rounded border-2 border-primary bg-primary/5 p-4 space-y-2">
                <div className="absolute -top-2.5 left-2 bg-card px-2 text-[9px] font-mono font-bold text-primary">
                  AKTUELLER BERICHT
                </div>
                {/* Simulated text lines */}
                {Array.from({ length: 8 }, (_, i) => (
                  <div key={i} className="flex gap-1">
                    <div className={`h-2 rounded bg-foreground/15 ${i % 3 === 0 ? 'w-full' : i % 3 === 1 ? 'w-11/12' : 'w-4/5'}`} />
                  </div>
                ))}
                {/* Highlighted entities in the "PDF" */}
                <div className="mt-2 flex gap-1">
                  <div className="h-2 w-16 rounded bg-entity-person-bg border border-entity-person/30" />
                  <div className="h-2 w-24 rounded bg-foreground/15" />
                  <div className="h-2 w-20 rounded bg-entity-organization-bg border border-entity-organization/30" />
                </div>
                {Array.from({ length: 5 }, (_, i) => (
                  <div key={`b${i}`} className="flex gap-1">
                    <div className={`h-2 rounded bg-foreground/15 ${i % 2 === 0 ? 'w-full' : 'w-5/6'}`} />
                  </div>
                ))}
                <div className="flex gap-1">
                  <div className="h-2 w-12 rounded bg-foreground/15" />
                  <div className="h-2 w-14 rounded bg-entity-location-bg border border-entity-location/30" />
                  <div className="h-2 w-20 rounded bg-foreground/15" />
                  <div className="h-2 w-14 rounded bg-entity-location-bg border border-entity-location/30" />
                </div>
              </div>

              {/* Other stories - dimmed */}
              <div className="rounded border border-dashed border-muted-foreground/20 bg-muted/30 p-3 space-y-1.5 opacity-50">
                <div className="text-[9px] font-mono text-muted-foreground mb-1">Anderer Bericht</div>
                {Array.from({ length: 4 }, (_, i) => (
                  <div key={i} className={`h-2 rounded bg-foreground/10 ${i === 3 ? 'w-3/4' : 'w-full'}`} />
                ))}
              </div>

              {/* Image */}
              <div className="h-20 rounded border border-dashed border-muted-foreground/20 flex items-center justify-center opacity-40">
                <span className="font-mono text-[9px] text-muted-foreground">[IMAGE]</span>
              </div>
            </div>
          </div>
        </div>

        {/* Right: Extracted Text + Entities */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Text Editor Area */}
          <div className="flex-1 overflow-auto p-6">
            {/* Metadata fields */}
            <div className="space-y-3 mb-6">
              <div>
                <label className="block text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1">Titel</label>
                <div className="rounded-[var(--radius)] border bg-card px-3 py-2 text-sm font-semibold">
                  {story.title}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1">Autor</label>
                  <div className="rounded-[var(--radius)] border bg-card px-3 py-1.5 text-xs">
                    Dr. Richard Haines, Leslie Kean
                  </div>
                </div>
                <div>
                  <label className="block text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1">Kategorie</label>
                  <div className="rounded-[var(--radius)] border bg-card px-3 py-1.5 text-xs flex items-center justify-between">
                    <span>Augenzeugen-Bericht</span>
                    <ChevronRight size={12} className="text-muted-foreground rotate-90" />
                  </div>
                </div>
              </div>
            </div>

            {/* Extracted text with entity highlights */}
            <div>
              <label className="block text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-2">Extrahierter Text</label>
              <div className="rounded-[var(--radius)] border bg-card p-4 text-[13px] leading-relaxed space-y-3">
                {reviewText.split('\n\n').map((paragraph, i) => (
                  <p key={i}>{renderHighlightedText(paragraph)}</p>
                ))}
              </div>
            </div>
          </div>

          {/* Entity Panel */}
          <div className="border-t">
            <div className="flex items-center justify-between px-4 py-2 bg-muted/30">
              <h3 className="text-xs font-semibold">Akteure ({storyEntities.length})</h3>
              <button className="flex items-center gap-1 text-[11px] text-primary hover:underline">
                <Plus size={10} /> Akteur hinzufügen
              </button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b bg-muted/20">
                    <th className="px-4 py-1.5 text-left font-mono text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Name</th>
                    <th className="px-4 py-1.5 text-left font-mono text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Typ</th>
                    <th className="px-4 py-1.5 text-left font-mono text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Konfidenz</th>
                    <th className="px-4 py-1.5 text-left font-mono text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {storyEntities.map((e) => (
                    <tr key={e.id} className="hover:bg-muted/30">
                      <td className="px-4 py-1.5">
                        <Link to={`/entities/${e.id}`} className="font-mono font-medium no-underline hover:text-primary hover:underline">{e.name}</Link>
                      </td>
                      <td className="px-4 py-1.5">
                        <EntityBadge type={e.type} name={entityTypeLabels[e.type]} size="xs" />
                      </td>
                      <td className="px-4 py-1.5"><ConfidenceBadge value={e.confidence} size="xs" /></td>
                      <td className="px-4 py-1.5"><StatusBadge status={e.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
