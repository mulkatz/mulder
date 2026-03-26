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
            <Link to="/" className="hover:text-foreground no-underline text-muted-foreground">Dashboard</Link>
            <ChevronRight size={12} />
            <span className="text-muted-foreground">Entities</span>
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
                    <span className="font-mono text-muted-foreground/70">Aliases:</span>{' '}
                    <span className="font-mono">E. Richter</span>{' · '}
                    <span className="font-mono">Dr. E. Richter</span>{' · '}
                    <span className="font-mono">Elena Richter</span>
                  </div>
                )}
                <ConfidenceBadge value={entity.confidence} />
              </div>
              <div className="flex items-center gap-2">
                <Link
                  to="/graph"
                  className="flex items-center gap-1.5 rounded-[var(--radius)] border px-3 py-1.5 text-xs text-muted-foreground no-underline hover:bg-secondary"
                >
                  <GitBranch size={12} /> Show in Graph
                </Link>
              </div>
            </div>

            {/* Stats row */}
            <div className="grid grid-cols-4 gap-3 mt-4">
              <div className="rounded-[var(--radius)] border p-3">
                <div className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider">Mentions</div>
                <div className="font-mono text-2xl font-bold mt-1">{entity.mentions}</div>
                <div className="text-[10px] text-muted-foreground">across all stories</div>
              </div>
              <div className="rounded-[var(--radius)] border p-3">
                <div className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider">Stories</div>
                <div className="font-mono text-2xl font-bold mt-1">{entityStories.length}</div>
                <div className="text-[10px] text-muted-foreground">containing this entity</div>
              </div>
              <div className="rounded-[var(--radius)] border p-3">
                <div className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider">Connections</div>
                <div className="font-mono text-2xl font-bold mt-1">{entity.connections}</div>
                <div className="text-[10px] text-muted-foreground">to other entities</div>
              </div>
              <div className="rounded-[var(--radius)] border p-3">
                <div className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider">Sources</div>
                <div className="font-mono text-2xl font-bold mt-1">
                  {new Set(entityStories.map(s => s.source)).size}
                </div>
                <div className="text-[10px] text-muted-foreground">independent documents</div>
              </div>
            </div>
          </div>

          {/* Tab-like sections */}
          <div className="space-y-6">
            {/* Stories mentioning this entity */}
            <div className="rounded-[var(--radius)] border bg-card">
              <div className="flex items-center gap-2 border-b px-4 py-3">
                <BookOpen size={14} className="text-muted-foreground" />
                <h2 className="text-sm font-semibold">Stories Mentioning {entity.name}</h2>
                <span className="ml-auto font-mono text-xs text-muted-foreground">{entityStories.length} stories</span>
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
                <h2 className="text-sm font-semibold">Timeline</h2>
                <span className="ml-auto text-[10px] text-muted-foreground">
                  Appearances across time
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
                  <h2 className="text-sm font-semibold text-amber-800 dark:text-amber-300">Merge Candidates</h2>
                  <span className="ml-auto rounded bg-[#fef3c7] dark:bg-amber-900/30 px-2 py-0.5 font-mono text-[10px] font-medium text-[#92400e] dark:text-amber-400">
                    AI suggestion
                  </span>
                </div>
                <div className="p-4">
                  <p className="text-[11px] text-muted-foreground mb-3 leading-relaxed">
                    These entities may refer to the same {entityTypeLabels[entity.type].toLowerCase()} as <strong>{entity.name}</strong>.
                    Merging consolidates all mentions and connections.
                  </p>
                  <div className="space-y-2">
                    {merges.map((m, i) => (
                      <div key={i} className="flex items-center justify-between rounded-[var(--radius)] border p-3">
                        <div className="flex items-center gap-3">
                          <span className="font-mono text-sm font-medium">{m.name}</span>
                          <span className="font-mono text-[10px] text-muted-foreground">{m.mentions} mentions</span>
                          <div className="flex items-center gap-1">
                            <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
                              <div className="h-full rounded-full bg-amber-400" style={{ width: `${m.similarity * 100}%` }} />
                            </div>
                            <span className="font-mono text-[10px] text-amber-600 dark:text-amber-400">{Math.round(m.similarity * 100)}%</span>
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <button className="flex items-center gap-1 rounded-[var(--radius)] border border-green-300 dark:border-green-700 px-2.5 py-1 text-[11px] font-medium text-green-700 dark:text-green-400 hover:bg-green-50 dark:hover:bg-green-900/20">
                            <CheckCircle size={10} /> Merge
                          </button>
                          <button className="flex items-center gap-1 rounded-[var(--radius)] border px-2.5 py-1 text-[11px] text-muted-foreground hover:bg-muted">
                            <XCircle size={10} /> Not Same
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
            <h2 className="text-sm font-semibold">Connected Entities</h2>
          </div>
          <p className="text-[11px] text-muted-foreground mb-4 leading-relaxed">
            Entities that frequently appear alongside <strong>{entity.name}</strong> — sorted by co-occurrence strength.
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
                    {sharedStories} shared {sharedStories === 1 ? 'story' : 'stories'}
                  </span>
                </div>
              </Link>
            ))}
          </div>

          {/* Co-occurrence insight */}
          <div className="mt-6 rounded-[var(--radius)] border bg-muted/30 p-3">
            <div className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider mb-2">
              Co-occurrence Pattern
            </div>
            <p className="text-[11px] leading-relaxed text-foreground">
              <strong>{entity.name}</strong> most frequently co-occurs with{' '}
              <strong>{connected[0]?.entity.name}</strong> ({connected[0]?.sharedStories} stories).
              This {connected[0]?.entity.type === 'organization' ? 'organizational' : connected[0]?.entity.type === 'location' ? 'geographic' : 'personal'} connection
              appears across <strong>{new Set(entityStories.map(s => s.source)).size} independent sources</strong>.
            </p>
            <Link
              to="/graph"
              className="mt-2 inline-flex items-center gap-1 text-[11px] font-medium text-primary no-underline hover:underline"
            >
              Explore in Graph <ChevronRight size={10} />
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
