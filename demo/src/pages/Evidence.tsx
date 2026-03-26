import { useState, useMemo } from 'react';
import { AlertTriangle, CheckCircle2, XCircle, ArrowUpDown, Clock, MapPin, Zap, Sparkles, ThumbsUp, ThumbsDown } from 'lucide-react';
import EntityBadge from '../components/EntityBadge';
import {
  contradictions,
  corroborationEntries,
  spatioTemporalEvents,
  temporalClusters,
} from '../data/mock';
import type { ContradictionStatus, Contradiction, SpatioTemporalEvent } from '../data/mock';

// --- Contradictions Tab ---

const statusConfig: Record<ContradictionStatus, { label: string; icon: React.ElementType; class: string; badgeClass: string }> = {
  POTENTIAL: {
    label: 'Potential',
    icon: AlertTriangle,
    class: 'text-[#92400e] dark:text-amber-400',
    badgeClass: 'text-[#92400e] bg-[#fef3c7] border-[#fcd34d] dark:text-amber-400 dark:bg-amber-900/30 dark:border-amber-800',
  },
  CONFIRMED: {
    label: 'Confirmed',
    icon: CheckCircle2,
    class: 'text-[#991b1b] dark:text-red-400',
    badgeClass: 'text-[#991b1b] bg-[#fee2e2] border-[#fca5a5] dark:text-red-400 dark:bg-red-900/30 dark:border-red-800',
  },
  DISMISSED: {
    label: 'Dismissed',
    icon: XCircle,
    class: 'text-[#15803d] dark:text-green-400',
    badgeClass: 'text-[#15803d] bg-[#dcfce7] border-[#86efac] dark:text-green-400 dark:bg-green-900/30 dark:border-green-800',
  },
};

const statusBorderColor: Record<ContradictionStatus, string> = {
  POTENTIAL: 'border-l-[#f59e0b] dark:border-l-amber-500',
  CONFIRMED: 'border-l-[#ef4444] dark:border-l-red-500',
  DISMISSED: 'border-l-[#22c55e] dark:border-l-green-500',
};

function ContradictionDetail({ contradiction }: { contradiction: Contradiction }) {
  const cfg = statusConfig[contradiction.status];
  const StatusIcon = cfg.icon;

  return (
    <div className="p-5 space-y-5 overflow-y-auto h-full">
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className={`inline-flex items-center gap-1.5 rounded-[var(--radius)] border px-2 py-1 text-xs font-medium ${cfg.badgeClass}`}>
            <StatusIcon size={12} />
            {cfg.label}
          </span>
          <EntityBadge type={contradiction.entity.type} name={contradiction.entity.name} size="sm" />
        </div>
        {contradiction.status === 'POTENTIAL' && (
          <div className="flex items-center gap-1.5">
            <button className="flex items-center gap-1.5 rounded-[var(--radius)] border border-red-300 dark:border-red-700 px-2.5 py-1.5 text-[11px] font-medium text-red-700 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20">
              <ThumbsDown size={11} /> Confirm
            </button>
            <button className="flex items-center gap-1.5 rounded-[var(--radius)] border border-green-300 dark:border-green-700 px-2.5 py-1.5 text-[11px] font-medium text-green-700 dark:text-green-400 hover:bg-green-50 dark:hover:bg-green-900/20">
              <ThumbsUp size={11} /> Dismiss
            </button>
          </div>
        )}
      </div>

      {/* Claim A */}
      <div className="rounded-[var(--radius)] border-l-[3px] border-l-primary border border-border bg-card p-4">
        <div className="flex items-baseline justify-between gap-2 mb-2">
          <div className="text-xs font-semibold text-foreground">{contradiction.storyA}</div>
          <div className="font-mono text-[10px] text-muted-foreground shrink-0">{contradiction.sourceA}</div>
        </div>
        <p className="text-xs leading-[1.7] text-foreground">{contradiction.claimA}</p>
      </div>

      {/* Conflict Divider */}
      <div className="flex items-center gap-3 px-2">
        <div className="flex-1 h-px bg-border" />
        <span className="flex items-center gap-1.5 font-mono text-[10px] font-semibold uppercase tracking-widest text-destructive dark:text-red-400">
          <Zap size={11} />
          contradicts
        </span>
        <div className="flex-1 h-px bg-border" />
      </div>

      {/* Claim B */}
      <div className="rounded-[var(--radius)] border-l-[3px] border-l-destructive dark:border-l-red-500 border border-border bg-card p-4">
        <div className="flex items-baseline justify-between gap-2 mb-2">
          <div className="text-xs font-semibold text-foreground">{contradiction.storyB}</div>
          <div className="font-mono text-[10px] text-muted-foreground shrink-0">{contradiction.sourceB}</div>
        </div>
        <p className="text-xs leading-[1.7] text-foreground">{contradiction.claimB}</p>
      </div>

      {/* Gemini Analysis */}
      <div className="rounded-[var(--radius)] border bg-muted/30 p-4">
        <div className="flex items-center gap-1.5 mb-2">
          <Sparkles size={12} className="text-accent-foreground dark:text-accent" />
          <span className="font-mono text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Gemini Analysis</span>
        </div>
        <p className="text-xs leading-[1.8] text-foreground">{contradiction.geminiAnalysis}</p>
      </div>
    </div>
  );
}

function ContradictionsTab() {
  const [filter, setFilter] = useState<ContradictionStatus | 'ALL'>('ALL');
  const [selectedId, setSelectedId] = useState<string | null>(contradictions[0]?.id ?? null);

  const filtered = filter === 'ALL'
    ? contradictions
    : contradictions.filter(c => c.status === filter);

  const selected = contradictions.find(c => c.id === selectedId) ?? null;

  const counts = {
    ALL: contradictions.length,
    POTENTIAL: contradictions.filter(c => c.status === 'POTENTIAL').length,
    CONFIRMED: contradictions.filter(c => c.status === 'CONFIRMED').length,
    DISMISSED: contradictions.filter(c => c.status === 'DISMISSED').length,
  };

  return (
    <div className="flex h-full min-h-0">
      {/* Left Panel — Contradiction List */}
      <div className="w-[380px] shrink-0 border-r flex flex-col min-h-0">
        {/* Filter Buttons */}
        <div className="flex items-center gap-1.5 px-3 py-2.5 border-b flex-wrap">
          {(['ALL', 'POTENTIAL', 'CONFIRMED', 'DISMISSED'] as const).map(status => {
            const isActive = filter === status;
            const label = status === 'ALL' ? 'All' : statusConfig[status].label;
            const count = counts[status];
            return (
              <button
                key={status}
                onClick={() => setFilter(status)}
                className={`flex items-center gap-1 rounded-[var(--radius)] border px-2 py-1 text-[11px] font-medium transition-colors ${
                  isActive
                    ? 'bg-primary/10 text-primary border-primary/30'
                    : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
                }`}
              >
                {status !== 'ALL' && (() => {
                  const Icon = statusConfig[status].icon;
                  return <Icon size={10} />;
                })()}
                {label}
                <span className="font-mono text-[10px]">{count}</span>
              </button>
            );
          })}
        </div>

        {/* Scrollable List */}
        <div className="flex-1 overflow-y-auto">
          {filtered.map(c => {
            const cfg = statusConfig[c.status];
            const isSelected = selectedId === c.id;

            return (
              <button
                key={c.id}
                onClick={() => setSelectedId(c.id)}
                className={`w-full text-left px-3 py-3 border-b border-l-[3px] transition-colors ${statusBorderColor[c.status]} ${
                  isSelected
                    ? 'bg-primary/5'
                    : 'hover:bg-muted/30'
                }`}
              >
                <div className="flex items-center gap-2 mb-1.5">
                  <span className={`inline-flex items-center gap-1 rounded-[var(--radius)] border px-1.5 py-0.5 text-[10px] font-medium ${cfg.badgeClass}`}>
                    {cfg.label}
                  </span>
                  <EntityBadge type={c.entity.type} name={c.entity.name} size="xs" />
                </div>
                <p className="text-[11px] leading-relaxed text-foreground line-clamp-2 mb-1.5">
                  {c.claimA.slice(0, 80)}...
                </p>
                <div className="flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
                  <span>{c.sourceA.split(',')[0]}</span>
                  <span className="text-muted-foreground/50">vs</span>
                  <span>{c.sourceB.split(',')[0]}</span>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Right Panel — Detail */}
      <div className="flex-1 min-h-0">
        {selected ? (
          <ContradictionDetail contradiction={selected} />
        ) : (
          <div className="h-full flex flex-col items-center justify-center text-muted-foreground">
            <AlertTriangle size={32} className="mb-3 opacity-30" />
            <p className="text-xs">Select a contradiction to compare claims</p>
          </div>
        )}
      </div>
    </div>
  );
}

// --- Corroboration Tab ---

type SortField = 'corroborationScore' | 'sourceReliability' | 'independentSourceCount' | 'evidenceChainStrength';

const sortLabels: Record<SortField, string> = {
  corroborationScore: 'Corroboration',
  sourceReliability: 'Reliability',
  independentSourceCount: 'Source Count',
  evidenceChainStrength: 'Evidence Chain',
};

function scoreColor(value: number): string {
  if (value >= 0.8) return 'hsl(142, 71%, 45%)';
  if (value >= 0.6) return 'hsl(45, 93%, 47%)';
  return 'hsl(0, 84%, 60%)';
}

function scoreColorClass(value: number): string {
  if (value >= 0.8) return 'text-[#15803d] border-[#22c55e] bg-[#dcfce7] dark:text-green-400 dark:border-green-600 dark:bg-green-900/30';
  if (value >= 0.6) return 'text-[#92400e] border-[#f59e0b] bg-[#fef3c7] dark:text-amber-400 dark:border-amber-600 dark:bg-amber-900/30';
  return 'text-[#991b1b] border-[#ef4444] bg-[#fee2e2] dark:text-red-400 dark:border-red-600 dark:bg-red-900/30';
}

function ScoreBar({ label, value, description, color }: { label: string; value: number; description: string; color?: string }) {
  const pct = Math.round(value * 100);
  const barColor = color ?? scoreColor(value);
  return (
    <div>
      <div className="flex items-baseline justify-between mb-1.5">
        <span className="font-mono text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">{label}</span>
        <span className="font-mono text-sm font-bold text-foreground">{pct}%</span>
      </div>
      <div className="h-2 rounded-full bg-muted overflow-hidden">
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${pct}%`, backgroundColor: barColor }}
        />
      </div>
      <p className="mt-1 text-[10px] text-muted-foreground">{description}</p>
    </div>
  );
}

function CorroborationTab() {
  const [sortBy, setSortBy] = useState<SortField>('corroborationScore');
  const [sortAsc, setSortAsc] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(corroborationEntries[0]?.id ?? null);

  const sorted = useMemo(() => {
    return [...corroborationEntries].sort((a, b) => {
      const diff = a[sortBy] - b[sortBy];
      return sortAsc ? diff : -diff;
    });
  }, [sortBy, sortAsc]);

  const handleSort = (field: SortField) => {
    if (sortBy === field) {
      setSortAsc(!sortAsc);
    } else {
      setSortBy(field);
      setSortAsc(false);
    }
  };

  const selected = corroborationEntries.find(e => e.id === selectedId) ?? null;

  return (
    <div className="flex h-full min-h-0">
      {/* Left Panel — Ranked Claim List */}
      <div className="w-[380px] shrink-0 border-r flex flex-col min-h-0">
        {/* Sort Controls */}
        <div className="flex items-center gap-1.5 px-3 py-2.5 border-b flex-wrap">
          <span className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider mr-1">Sort</span>
          {(Object.keys(sortLabels) as SortField[]).map(field => (
            <button
              key={field}
              onClick={() => handleSort(field)}
              className={`flex items-center gap-1 rounded-[var(--radius)] border px-2 py-1 text-[10px] font-medium transition-colors ${
                sortBy === field
                  ? 'bg-primary/10 text-primary border-primary/30'
                  : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
              }`}
            >
              {sortLabels[field]}
              {sortBy === field && <ArrowUpDown size={9} />}
            </button>
          ))}
        </div>

        {/* Scrollable List */}
        <div className="flex-1 overflow-y-auto">
          {sorted.map(entry => {
            const isSelected = selectedId === entry.id;
            const pct = Math.round(entry.corroborationScore * 100);

            return (
              <button
                key={entry.id}
                onClick={() => setSelectedId(entry.id)}
                className={`w-full text-left px-3 py-3 border-b transition-colors flex items-start gap-3 ${
                  isSelected ? 'bg-primary/5' : 'hover:bg-muted/30'
                }`}
              >
                {/* Score Circle */}
                <div
                  className={`shrink-0 w-9 h-9 rounded-full border-2 flex items-center justify-center font-mono text-[11px] font-bold ${scoreColorClass(entry.corroborationScore)}`}
                >
                  {pct}
                </div>

                {/* Claim + Meta */}
                <div className="min-w-0 flex-1">
                  <p className="text-[11px] leading-relaxed text-foreground line-clamp-2 mb-1.5">{entry.claim}</p>
                  <div className="flex items-center gap-2">
                    <EntityBadge type={entry.entity.type} name={entry.entity.name} size="xs" />
                    <span className="font-mono text-[10px] text-muted-foreground">
                      {entry.independentSourceCount} {entry.independentSourceCount === 1 ? 'source' : 'sources'}
                    </span>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Right Panel — Claim Detail */}
      <div className="flex-1 min-h-0">
        {selected ? (
          <div className="p-5 space-y-5 overflow-y-auto h-full">
            {/* Header: Claim + Entity */}
            <div>
              <div className="flex items-center gap-2.5 mb-3">
                <EntityBadge type={selected.entity.type} name={selected.entity.name} size="sm" />
                <span className="font-mono text-[10px] text-muted-foreground">
                  {selected.independentSourceCount} independent {selected.independentSourceCount === 1 ? 'source' : 'sources'}
                </span>
              </div>
              <p className="text-sm leading-[1.7] text-foreground">{selected.claim}</p>
            </div>

            {/* Score Breakdown */}
            <div className="rounded-[var(--radius)] border bg-card p-4 space-y-4">
              <div className="font-mono text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                Score Breakdown
              </div>
              <ScoreBar
                label="Corroboration Score"
                value={selected.corroborationScore}
                description="How well-supported this claim is across independent sources"
                color="hsl(var(--primary))"
              />
              <ScoreBar
                label="Source Reliability"
                value={selected.sourceReliability}
                description="Weighted PageRank of contributing sources"
              />
              <ScoreBar
                label="Evidence Chain Strength"
                value={selected.evidenceChainStrength}
                description="Directness and quality of evidence linking sources to this claim"
              />
            </div>

            {/* Individual Sources */}
            <div>
              <div className="font-mono text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-3">
                Contributing Sources
              </div>
              <div className="space-y-2">
                {selected.sources.map((src, i) => (
                  <div key={i} className="flex items-center justify-between rounded-[var(--radius)] border bg-card px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-semibold text-foreground">{src.storyTitle}</div>
                      <div className="font-mono text-[10px] text-muted-foreground mt-0.5">{src.name}</div>
                    </div>
                    <div className="flex items-center gap-2.5 shrink-0 ml-4">
                      <div className="w-20 h-1.5 rounded-full bg-muted overflow-hidden">
                        <div
                          className="h-full rounded-full transition-all"
                          style={{
                            width: `${src.reliability * 100}%`,
                            backgroundColor: scoreColor(src.reliability),
                          }}
                        />
                      </div>
                      <span className="font-mono text-[11px] font-medium w-9 text-right">{Math.round(src.reliability * 100)}%</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="h-full flex flex-col items-center justify-center text-muted-foreground">
            <ArrowUpDown size={32} className="mb-3 opacity-30" />
            <p className="text-xs">Select a claim to see its corroboration details</p>
          </div>
        )}
      </div>
    </div>
  );
}

// --- Spatio-Temporal Tab ---

// Stylized SVG location visualization
// Maps real lat/lng to SVG viewport positions (rough European layout)
function projectToSvg(lat: number, lng: number, width: number, height: number): { x: number; y: number } {
  // Bounding box covering relevant European region
  const minLat = 33;
  const maxLat = 55;
  const minLng = 2;
  const maxLng = 35;

  const x = ((lng - minLng) / (maxLng - minLng)) * (width - 80) + 40;
  const y = ((maxLat - lat) / (maxLat - minLat)) * (height - 80) + 40;
  return { x, y };
}

const entityTypeCircleColors: Record<string, { fill: string; stroke: string; darkFill: string; darkStroke: string }> = {
  person: { fill: 'hsl(221, 83%, 93%)', stroke: 'hsl(221, 83%, 53%)', darkFill: 'hsl(221, 83%, 18%)', darkStroke: 'hsl(221, 83%, 65%)' },
  organization: { fill: 'hsl(24, 95%, 91%)', stroke: 'hsl(24, 95%, 53%)', darkFill: 'hsl(24, 95%, 18%)', darkStroke: 'hsl(24, 95%, 65%)' },
  event: { fill: 'hsl(280, 65%, 93%)', stroke: 'hsl(280, 65%, 53%)', darkFill: 'hsl(280, 65%, 18%)', darkStroke: 'hsl(280, 65%, 65%)' },
  location: { fill: 'hsl(142, 71%, 91%)', stroke: 'hsl(142, 71%, 45%)', darkFill: 'hsl(142, 71%, 15%)', darkStroke: 'hsl(142, 71%, 55%)' },
};

function SpatioTemporalTab() {
  const minYear = 2019;
  const maxYear = 2024;
  const [dateRange, setDateRange] = useState<[number, number]>([minYear, maxYear]);
  const [selectedEvent, setSelectedEvent] = useState<SpatioTemporalEvent | null>(null);
  const [entityTypeFilter, setEntityTypeFilter] = useState<string | null>(null);

  const filteredEvents = useMemo(() => {
    return spatioTemporalEvents.filter(e => {
      const year = new Date(e.timestamp).getFullYear();
      if (year < dateRange[0] || year > dateRange[1]) return false;
      if (entityTypeFilter && e.entityType !== entityTypeFilter) return false;
      return true;
    });
  }, [dateRange, entityTypeFilter]);

  // Group events by location for density sizing
  const locationDensity = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of filteredEvents) {
      counts.set(e.location, (counts.get(e.location) ?? 0) + 1);
    }
    return counts;
  }, [filteredEvents]);

  // Unique locations for SVG circles
  const uniqueLocations = useMemo(() => {
    const seen = new Map<string, SpatioTemporalEvent>();
    for (const e of filteredEvents) {
      if (!seen.has(e.location)) {
        seen.set(e.location, e);
      }
    }
    return Array.from(seen.values());
  }, [filteredEvents]);

  // Active cluster based on filtered events
  const activeClusters = useMemo(() => {
    const clusterIds = new Set(filteredEvents.map(e => e.clusterId));
    return temporalClusters.filter(c => clusterIds.has(c.id));
  }, [filteredEvents]);

  const isDark = typeof document !== 'undefined' && document.documentElement.classList.contains('dark');
  const svgWidth = 500;
  const svgHeight = 380;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_1fr] gap-4 h-full">
      {/* Left: Event List */}
      <div className="flex flex-col min-h-0">
        {/* Entity Type Filter */}
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          <button
            onClick={() => setEntityTypeFilter(null)}
            className={`rounded-[var(--radius)] border px-2.5 py-1 text-[11px] font-medium transition-colors ${
              !entityTypeFilter ? 'bg-primary/10 text-primary border-primary/30' : 'text-muted-foreground hover:bg-secondary'
            }`}
          >
            All Types
          </button>
          {(['person', 'organization', 'event', 'location'] as const).map(type => (
            <button
              key={type}
              onClick={() => setEntityTypeFilter(entityTypeFilter === type ? null : type)}
              className={`rounded-[var(--radius)] border px-2.5 py-1 text-[11px] font-medium capitalize transition-colors ${
                entityTypeFilter === type ? 'bg-primary/10 text-primary border-primary/30' : 'text-muted-foreground hover:bg-secondary'
              }`}
            >
              {type}
            </button>
          ))}
          <span className="ml-auto font-mono text-[10px] text-muted-foreground">
            {filteredEvents.length} events
          </span>
        </div>

        {/* Scrollable Event List */}
        <div className="flex-1 overflow-y-auto space-y-2 pr-1">
          {filteredEvents.map(event => {
            const isSelected = selectedEvent?.id === event.id;
            return (
              <button
                key={event.id}
                onClick={() => setSelectedEvent(isSelected ? null : event)}
                className={`w-full text-left rounded-[var(--radius)] border px-3 py-2.5 transition-colors ${
                  isSelected
                    ? 'bg-primary/5 border-primary/30'
                    : 'bg-card hover:bg-muted/30'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-semibold text-foreground">{event.title}</div>
                    <div className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground font-mono">
                      <span className="flex items-center gap-1">
                        <Clock size={9} />
                        {event.timestamp}
                      </span>
                      <span className="flex items-center gap-1">
                        <MapPin size={9} />
                        {event.location}
                      </span>
                    </div>
                    {isSelected && (
                      <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{event.description}</p>
                    )}
                    <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
                      {event.entities.slice(0, 3).map(e => (
                        <EntityBadge key={e.id} type={e.type} name={e.name} size="xs" />
                      ))}
                      {event.entities.length > 3 && (
                        <span className="text-[10px] text-muted-foreground">+{event.entities.length - 3}</span>
                      )}
                    </div>
                  </div>
                </div>
              </button>
            );
          })}
        </div>

        {/* Temporal Clusters */}
        <div className="mt-3 pt-3 border-t">
          <div className="font-mono text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-2">
            Temporal Clusters
          </div>
          <div className="flex gap-2 flex-wrap">
            {activeClusters.map(cluster => (
              <div
                key={cluster.id}
                className="rounded-[var(--radius)] border bg-muted/30 px-2.5 py-1.5"
              >
                <div className="text-[11px] font-medium">{cluster.label}</div>
                <div className="font-mono text-[10px] text-muted-foreground">
                  {cluster.startDate.slice(0, 4)}–{cluster.endDate.slice(0, 4)} · {cluster.eventCount} events
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Right: SVG Location Visualization + Timeline */}
      <div className="flex flex-col min-h-0">
        {/* SVG Map */}
        <div className="flex-1 rounded-[var(--radius)] border bg-card overflow-hidden relative">
          <svg
            viewBox={`0 0 ${svgWidth} ${svgHeight}`}
            className="w-full h-full"
            style={{ minHeight: '280px' }}
          >
            {/* Grid lines */}
            {Array.from({ length: 6 }, (_, i) => {
              const y = 40 + i * ((svgHeight - 80) / 5);
              return (
                <line
                  key={`h${i}`}
                  x1="40" y1={y} x2={svgWidth - 40} y2={y}
                  stroke={isDark ? 'hsl(220, 10%, 22%)' : 'hsl(240, 5.9%, 92%)'}
                  strokeWidth="0.5"
                />
              );
            })}
            {Array.from({ length: 6 }, (_, i) => {
              const x = 40 + i * ((svgWidth - 80) / 5);
              return (
                <line
                  key={`v${i}`}
                  x1={x} y1="40" x2={x} y2={svgHeight - 40}
                  stroke={isDark ? 'hsl(220, 10%, 22%)' : 'hsl(240, 5.9%, 92%)'}
                  strokeWidth="0.5"
                />
              );
            })}

            {/* Location circles */}
            {uniqueLocations.map(event => {
              const { x, y } = projectToSvg(event.lat, event.lng, svgWidth, svgHeight);
              const density = locationDensity.get(event.location) ?? 1;
              const radius = 12 + density * 5;
              const colors = entityTypeCircleColors[event.entityType];
              const isSelected = selectedEvent?.location === event.location;

              return (
                <g key={event.location}>
                  {/* Pulse animation for selected */}
                  {isSelected && (
                    <circle
                      cx={x}
                      cy={y}
                      r={radius + 6}
                      fill="none"
                      stroke={isDark ? colors.darkStroke : colors.stroke}
                      strokeWidth="1.5"
                      opacity="0.4"
                    >
                      <animate
                        attributeName="r"
                        values={`${radius + 4};${radius + 12};${radius + 4}`}
                        dur="2s"
                        repeatCount="indefinite"
                      />
                      <animate
                        attributeName="opacity"
                        values="0.4;0.1;0.4"
                        dur="2s"
                        repeatCount="indefinite"
                      />
                    </circle>
                  )}
                  <circle
                    cx={x}
                    cy={y}
                    r={radius}
                    fill={isDark ? colors.darkFill : colors.fill}
                    stroke={isDark ? colors.darkStroke : colors.stroke}
                    strokeWidth={isSelected ? 2.5 : 1.5}
                    className="cursor-pointer transition-all"
                    onClick={() => {
                      const firstEvent = filteredEvents.find(e => e.location === event.location);
                      if (firstEvent) setSelectedEvent(firstEvent);
                    }}
                  />
                  {/* Location label */}
                  <text
                    x={x}
                    y={y + radius + 12}
                    textAnchor="middle"
                    fill={isDark ? 'hsl(220, 10%, 65%)' : 'hsl(240, 3.8%, 46.1%)'}
                    fontSize="9"
                    fontFamily="'JetBrains Mono', monospace"
                  >
                    {event.location}
                  </text>
                  {/* Event count */}
                  <text
                    x={x}
                    y={y + 3.5}
                    textAnchor="middle"
                    fill={isDark ? colors.darkStroke : colors.stroke}
                    fontSize="10"
                    fontWeight="700"
                    fontFamily="'JetBrains Mono', monospace"
                  >
                    {density}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>

        {/* Timeline Scrubber */}
        <div className="mt-3 rounded-[var(--radius)] border bg-card px-4 py-3">
          <div className="flex items-center justify-between mb-2">
            <div className="font-mono text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
              Timeline Range
            </div>
            <span className="font-mono text-[11px] text-foreground">
              {dateRange[0]} – {dateRange[1]}
            </span>
          </div>
          <div className="flex items-center gap-3">
            <span className="font-mono text-[10px] text-muted-foreground">{minYear}</span>
            <div className="flex-1 relative">
              <input
                type="range"
                min={minYear}
                max={maxYear}
                value={dateRange[0]}
                onChange={(e) => {
                  const val = Number(e.target.value);
                  setDateRange([Math.min(val, dateRange[1]), dateRange[1]]);
                }}
                className="w-full absolute top-0"
              />
              <input
                type="range"
                min={minYear}
                max={maxYear}
                value={dateRange[1]}
                onChange={(e) => {
                  const val = Number(e.target.value);
                  setDateRange([dateRange[0], Math.max(val, dateRange[0])]);
                }}
                className="w-full"
              />
            </div>
            <span className="font-mono text-[10px] text-muted-foreground">{maxYear}</span>
          </div>

          {/* Cluster markers on timeline */}
          <div className="mt-2 flex gap-1">
            {temporalClusters.map(cluster => {
              const startYear = parseInt(cluster.startDate.slice(0, 4));
              const endYear = parseInt(cluster.endDate.slice(0, 4));
              const leftPct = ((startYear - minYear) / (maxYear - minYear)) * 100;
              const widthPct = ((endYear - startYear + 1) / (maxYear - minYear)) * 100;
              const isActive = activeClusters.some(c => c.id === cluster.id);

              return (
                <div
                  key={cluster.id}
                  className="relative h-4"
                  style={{ position: 'absolute', left: `calc(${leftPct}% + 24px)`, width: `${widthPct}%` }}
                >
                  <div
                    className={`h-full rounded-sm ${
                      isActive ? 'bg-primary/20 border border-primary/30' : 'bg-muted'
                    }`}
                    title={cluster.label}
                  />
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

// --- Main Evidence Page ---

type TabId = 'contradictions' | 'corroboration' | 'spatio-temporal';

const tabs: { id: TabId; label: string }[] = [
  { id: 'contradictions', label: 'Contradictions' },
  { id: 'corroboration', label: 'Corroboration' },
  { id: 'spatio-temporal', label: 'Spatio-Temporal' },
];

export default function Evidence() {
  const [activeTab, setActiveTab] = useState<TabId>('contradictions');

  return (
    <div className="p-6 space-y-4 h-[calc(100vh-48px)] flex flex-col">
      {/* Page Header */}
      <div>
        <h1 className="text-lg font-semibold">Evidence Analysis</h1>
        <p className="text-xs text-muted-foreground mt-0.5">
          Contradiction detection, corroboration scoring, and spatio-temporal event analysis
        </p>
      </div>

      {/* Tab Bar */}
      <div className="flex items-center gap-0.5 border-b">
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`px-4 py-2 text-xs font-medium transition-colors border-b-2 -mb-px ${
              activeTab === tab.id
                ? 'text-primary border-primary'
                : 'text-muted-foreground border-transparent hover:text-foreground hover:border-muted-foreground/30'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {activeTab === 'contradictions' && <ContradictionsTab />}
        {activeTab === 'corroboration' && <CorroborationTab />}
        {activeTab === 'spatio-temporal' && <SpatioTemporalTab />}
      </div>
    </div>
  );
}
