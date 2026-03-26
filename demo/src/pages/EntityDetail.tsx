import { Link, useParams } from 'react-router-dom';
import { ChevronRight, BookOpen, GitBranch, Calendar, Merge, CheckCircle, XCircle, ArrowRight } from 'lucide-react';
import EntityBadge from '../components/EntityBadge';
import ConfidenceBadge from '../components/ConfidenceBadge';
import StatusBadge from '../components/StatusBadge';
import { entities, stories, entityTypeLabels, getEntityTimeline, getConnectedEntities, mergeCandidates } from '../data/mock';

export default function EntityDetail() {
  const { id } = useParams();
  const entity = entities.find(e => e.id === (id || 'e1')) || entities[0];
  const entityStories = stories.filter(s => s.entities.some(e => e.id === entity.id));
  const timeline = getEntityTimeline(entity.id);
  const connected = getConnectedEntities(entity.id);
  const merges = mergeCandidates[entity.id] || [];

  return (
    <div className="flex h-[calc(100vh-48px)]">
      {/* Main content */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-4xl mx-auto px-6 py-6">
          {/* Breadcrumb */}
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-4">
            <Link to="/" className="hover:text-foreground no-underline text-muted-foreground">Übersicht</Link>
            <ChevronRight size={12} />
            <span className="text-muted-foreground">Akteure</span>
            <ChevronRight size={12} />
            <span className="text-foreground font-medium">{entity.name}</span>
          </div>

          {/* Entity header */}
          <div className="rounded-[var(--radius)] border bg-card p-5 mb-6 shadow-hard">
            <div className="flex items-start justify-between">
              <div>
                <div className="flex items-center gap-3 mb-2">
                  <h1 className="text-xl font-bold">{entity.name}</h1>
                  <EntityBadge type={entity.type} name={entityTypeLabels[entity.type]} size="sm" />
                  <StatusBadge status={entity.status} />
                </div>
                {entity.id === 'e1' && (
                  <div className="text-xs text-muted-foreground mb-2">
                    <span className="font-mono text-muted-foreground/70">Aliase:</span>{' '}
                    <span className="font-mono">Cmdr. Fravor</span>{' · '}
                    <span className="font-mono">Commander Fravor</span>{' · '}
                    <span className="font-mono">Dave Fravor</span>
                  </div>
                )}
                <ConfidenceBadge value={entity.confidence} />
              </div>
              <div className="flex items-center gap-2">
                <Link
                  to="/graph"
                  className="flex items-center gap-1.5 rounded-[var(--radius)] border px-3 py-1.5 text-xs text-muted-foreground no-underline hover:bg-secondary"
                >
                  <GitBranch size={12} /> Im Netzwerk zeigen
                </Link>
              </div>
            </div>

            {/* Stats row */}
            <div className="grid grid-cols-4 gap-3 mt-4">
              <div className="rounded-[var(--radius)] border p-3">
                <div className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider">Erwähnungen</div>
                <div className="font-mono text-2xl font-bold mt-1">{entity.mentions}</div>
                <div className="text-[10px] text-muted-foreground">über alle Berichte</div>
              </div>
              <div className="rounded-[var(--radius)] border p-3">
                <div className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider">Berichte</div>
                <div className="font-mono text-2xl font-bold mt-1">{entityStories.length}</div>
                <div className="text-[10px] text-muted-foreground">mit diesem Akteur</div>
              </div>
              <div className="rounded-[var(--radius)] border p-3">
                <div className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider">Verbindungen</div>
                <div className="font-mono text-2xl font-bold mt-1">{entity.connections}</div>
                <div className="text-[10px] text-muted-foreground">zu anderen Akteuren</div>
              </div>
              <div className="rounded-[var(--radius)] border p-3">
                <div className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider">Quellen</div>
                <div className="font-mono text-2xl font-bold mt-1">
                  {new Set(entityStories.map(s => s.source)).size}
                </div>
                <div className="text-[10px] text-muted-foreground">unabhängige Dokumente</div>
              </div>
            </div>
          </div>

          {/* Tab-like sections */}
          <div className="space-y-6">
            {/* Stories mentioning this entity */}
            <div className="rounded-[var(--radius)] border bg-card">
              <div className="flex items-center gap-2 border-b px-4 py-3">
                <BookOpen size={14} className="text-muted-foreground" />
                <h2 className="text-sm font-semibold">Berichte mit {entity.name}</h2>
                <span className="ml-auto font-mono text-xs text-muted-foreground">{entityStories.length} Berichte</span>
              </div>
              <div className="divide-y">
                {entityStories.map((story) => (
                  <Link
                    key={story.id}
                    to={`/stories/${story.id}`}
                    className="flex items-start gap-4 px-4 py-3 no-underline hover:bg-muted/30 transition-colors"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-xs font-semibold text-foreground">{story.title}</span>
                        <span className="rounded bg-muted px-1.5 py-0 text-[10px] font-medium text-muted-foreground shrink-0">
                          {story.category}
                        </span>
                      </div>
                      <p className="text-[11px] text-muted-foreground line-clamp-2">{story.excerpt}</p>
                      <div className="mt-1.5 flex items-center gap-2 flex-wrap">
                        {story.entities.filter(e => e.id !== entity.id).slice(0, 3).map((e) => (
                          <EntityBadge key={e.id} type={e.type} name={e.name} size="xs" />
                        ))}
                      </div>
                    </div>
                    <div className="flex flex-col items-end gap-1 shrink-0">
                      <span className="font-mono text-[10px] text-muted-foreground">{story.source}</span>
                      <ConfidenceBadge value={story.confidence} size="xs" />
                    </div>
                  </Link>
                ))}
              </div>
            </div>

            {/* Timeline */}
            <div className="rounded-[var(--radius)] border bg-card">
              <div className="flex items-center gap-2 border-b px-4 py-3">
                <Calendar size={14} className="text-muted-foreground" />
                <h2 className="text-sm font-semibold">Zeitverlauf</h2>
                <span className="ml-auto text-[10px] text-muted-foreground">
                  Auftreten im Zeitverlauf
                </span>
              </div>
              <div className="p-4">
                <div className="relative pl-6">
                  {/* Vertical line */}
                  <div className="absolute left-[9px] top-1 bottom-1 w-px bg-border" />

                  <div className="space-y-4">
                    {timeline.map((entry, i) => (
                      <div key={i} className="relative">
                        {/* Dot */}
                        <div className={`absolute -left-6 top-1 h-[11px] w-[11px] rounded-full border-2 ${
                          i === timeline.length - 1
                            ? 'border-primary bg-primary/20'
                            : 'border-muted-foreground/30 bg-card'
                        }`} />

                        <div className="rounded-[var(--radius)] border p-3 hover:bg-muted/30 transition-colors">
                          <div className="flex items-center justify-between mb-1">
                            <span className="font-mono text-[11px] font-bold text-foreground">{entry.date}</span>
                            <span className="font-mono text-[10px] text-muted-foreground">{entry.source}</span>
                          </div>
                          <Link
                            to={`/stories/${entry.storyId}`}
                            className="text-xs font-medium text-primary no-underline hover:underline"
                          >
                            {entry.storyTitle}
                          </Link>
                          <p className="mt-1 text-[11px] text-muted-foreground leading-relaxed">{entry.excerpt}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            {/* Merge Candidates */}
            {merges.length > 0 && (
              <div className="rounded-[var(--radius)] border border-amber-300 dark:border-amber-700 bg-card">
                <div className="flex items-center gap-2 border-b border-amber-200 dark:border-amber-800 px-4 py-3 bg-amber-50/50 dark:bg-amber-900/10">
                  <Merge size={14} className="text-amber-600 dark:text-amber-400" />
                  <h2 className="text-sm font-semibold text-amber-800 dark:text-amber-300">Zusammenführungs-Kandidaten</h2>
                  <span className="ml-auto rounded bg-[#fef3c7] dark:bg-amber-900/30 px-2 py-0.5 font-mono text-[10px] font-medium text-[#92400e] dark:text-amber-400">
                    KI-Vorschlag
                  </span>
                </div>
                <div className="p-4">
                  <p className="text-[11px] text-muted-foreground mb-3 leading-relaxed">
                    Diese Akteure könnten sich auf dieselbe {entityTypeLabels[entity.type]} beziehen wie <strong>{entity.name}</strong>.
                    Zusammenführen konsolidiert alle Erwähnungen und Verbindungen.
                  </p>
                  <div className="space-y-2">
                    {merges.map((m, i) => (
                      <div key={i} className="flex items-center justify-between rounded-[var(--radius)] border p-3">
                        <div className="flex items-center gap-3">
                          <span className="font-mono text-sm font-medium">{m.name}</span>
                          <span className="font-mono text-[10px] text-muted-foreground">{m.mentions} Erwähnungen</span>
                          <div className="flex items-center gap-1">
                            <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
                              <div className="h-full rounded-full bg-amber-400" style={{ width: `${m.similarity * 100}%` }} />
                            </div>
                            <span className="font-mono text-[10px] text-amber-600 dark:text-amber-400">{Math.round(m.similarity * 100)}%</span>
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <button className="flex items-center gap-1 rounded-[var(--radius)] border border-green-300 dark:border-green-700 px-2.5 py-1 text-[11px] font-medium text-green-700 dark:text-green-400 hover:bg-green-50 dark:hover:bg-green-900/20">
                            <CheckCircle size={10} /> Zusammenführen
                          </button>
                          <button className="flex items-center gap-1 rounded-[var(--radius)] border px-2.5 py-1 text-[11px] text-muted-foreground hover:bg-muted">
                            <XCircle size={10} /> Nicht identisch
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Right sidebar — Connected Entities */}
      <div className="w-[300px] border-l bg-card overflow-y-auto">
        <div className="p-4">
          <div className="flex items-center gap-2 mb-4">
            <GitBranch size={14} className="text-muted-foreground" />
            <h2 className="text-sm font-semibold">Verbundene Akteure</h2>
          </div>
          <p className="text-[11px] text-muted-foreground mb-4 leading-relaxed">
            Akteure, die häufig zusammen mit <strong>{entity.name}</strong> auftreten — sortiert nach Kookkurrenz-Stärke.
          </p>

          <div className="space-y-2">
            {connected.map(({ entity: conn, sharedStories, strength }) => (
              <Link
                key={conn.id}
                to={`/entities/${conn.id}`}
                className="block rounded-[var(--radius)] border p-3 no-underline transition-colors hover:bg-muted/50"
              >
                <div className="flex items-center justify-between mb-1.5">
                  <EntityBadge type={conn.type} name={conn.name} size="xs" />
                  <ArrowRight size={10} className="text-muted-foreground" />
                </div>
                <div className="flex items-center gap-2">
                  <div className="flex-1 h-1.5 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-primary/50"
                      style={{ width: `${Math.min(strength * 100, 100)}%` }}
                    />
                  </div>
                  <span className="font-mono text-[10px] text-muted-foreground shrink-0">
                    {sharedStories} gemeinsame{sharedStories === 1 ? 'r Bericht' : ' Berichte'}
                  </span>
                </div>
              </Link>
            ))}
          </div>

          {/* Co-occurrence insight */}
          <div className="mt-6 rounded-[var(--radius)] border bg-muted/30 p-3">
            <div className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider mb-2">
              Kookkurrenz-Muster
            </div>
            <p className="text-[11px] leading-relaxed text-foreground">
              <strong>{entity.name}</strong> tritt am häufigsten zusammen mit{' '}
              <strong>{connected[0]?.entity.name}</strong> auf ({connected[0]?.sharedStories} Berichte).
              Diese {connected[0]?.entity.type === 'organization' ? 'organisatorische' : connected[0]?.entity.type === 'location' ? 'geografische' : 'persönliche'} Verbindung
              erstreckt sich über <strong>{new Set(entityStories.map(s => s.source)).size} unabhängige Quellen</strong>.
            </p>
            <Link
              to="/graph"
              className="mt-2 inline-flex items-center gap-1 text-[11px] font-medium text-primary no-underline hover:underline"
            >
              Im Netzwerk erkunden <ChevronRight size={10} />
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
