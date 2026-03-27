import { useState, useCallback, useMemo } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  type Node,
  type Edge,
  type NodeProps,
  Handle,
  Position,
  BackgroundVariant,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Search, Filter, X, BookOpen, GitBranch, MapPin } from 'lucide-react';
import { Link } from 'react-router-dom';
import EntityBadge from '../components/EntityBadge';
import { entities, stories, entityTypeLabels } from '../data/mock';
import type { EntityType, Entity } from '../data/mock';

const entityColors: Record<EntityType, { border: string; bg: string; text: string }> = {
  person: { border: '#3b82f6', bg: 'hsl(221, 83%, 95%)', text: '#1d4ed8' },
  organization: { border: '#f97316', bg: 'hsl(24, 95%, 93%)', text: '#c2410c' },
  event: { border: '#e11d48', bg: 'hsl(350, 80%, 95%)', text: '#be123c' },
  location: { border: '#22c55e', bg: 'hsl(142, 71%, 93%)', text: '#15803d' },
};

const darkEntityColors: Record<EntityType, { border: string; bg: string; text: string }> = {
  person: { border: '#60a5fa', bg: 'hsl(221, 83%, 12%)', text: '#93bbfd' },
  organization: { border: '#fb923c', bg: 'hsl(24, 95%, 12%)', text: '#fdba74' },
  event: { border: '#fb7185', bg: 'hsl(350, 60%, 12%)', text: '#fda4af' },
  location: { border: '#4ade80', bg: 'hsl(142, 71%, 10%)', text: '#86efac' },
};

// --- Node shape components per entity type ---

function PersonNode({ data }: NodeProps) {
  const isDark = document.documentElement.classList.contains('dark');
  const colors = isDark ? darkEntityColors.person : entityColors.person;
  return (
    <>
      <Handle type="target" position={Position.Top} style={{ visibility: 'hidden' }} />
      <div
        className="rounded-lg border-l-[3px] border font-mono shadow-hard-sm cursor-pointer"
        style={{
          borderLeftColor: colors.border,
          borderColor: isDark ? 'hsl(240, 3.7%, 15.9%)' : 'hsl(240, 5.9%, 90%)',
          borderLeftWidth: '3px',
          backgroundColor: colors.bg,
          padding: '8px 12px',
          minWidth: '120px',
          borderRadius: '8px',
        }}
      >
        <div style={{ fontSize: '11px', fontWeight: 600, color: colors.text }}>{String(data.label)}</div>
        <div style={{ fontSize: '9px', color: isDark ? '#a1a1aa' : '#71717a', marginTop: '2px' }}>
          {entityTypeLabels.person.toUpperCase()} · {String(data.mentions)} Erwähnungen
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} style={{ visibility: 'hidden' }} />
    </>
  );
}

function OrganizationNode({ data }: NodeProps) {
  const isDark = document.documentElement.classList.contains('dark');
  const colors = isDark ? darkEntityColors.organization : entityColors.organization;
  return (
    <>
      <Handle type="target" position={Position.Top} style={{ visibility: 'hidden' }} />
      <div
        className="border-l-[3px] border font-mono shadow-hard-sm cursor-pointer"
        style={{
          borderLeftColor: colors.border,
          borderColor: isDark ? 'hsl(240, 3.7%, 15.9%)' : 'hsl(240, 5.9%, 90%)',
          borderLeftWidth: '3px',
          backgroundColor: colors.bg,
          padding: '8px 12px',
          minWidth: '120px',
          borderRadius: '0px',
        }}
      >
        <div style={{ fontSize: '11px', fontWeight: 600, color: colors.text }}>{String(data.label)}</div>
        <div style={{ fontSize: '9px', color: isDark ? '#a1a1aa' : '#71717a', marginTop: '2px' }}>
          {entityTypeLabels.organization.toUpperCase()} · {String(data.mentions)} Erwähnungen
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} style={{ visibility: 'hidden' }} />
    </>
  );
}

function EventNode({ data }: NodeProps) {
  const isDark = document.documentElement.classList.contains('dark');
  const colors = isDark ? darkEntityColors.event : entityColors.event;
  return (
    <>
      <Handle type="target" position={Position.Top} style={{ visibility: 'hidden' }} />
      <div style={{ transform: 'rotate(45deg)' }}>
        <div
          className="border font-mono shadow-hard-sm cursor-pointer"
          style={{
            borderColor: colors.border,
            borderWidth: '2px',
            backgroundColor: colors.bg,
            padding: '14px',
            minWidth: '90px',
            minHeight: '90px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <div style={{ transform: 'rotate(-45deg)', textAlign: 'center' }}>
            <div style={{ fontSize: '10px', fontWeight: 600, color: colors.text, lineHeight: '1.3' }}>{String(data.label)}</div>
            <div style={{ fontSize: '8px', color: isDark ? '#a1a1aa' : '#71717a', marginTop: '2px' }}>
              {entityTypeLabels.event.toUpperCase()} · {String(data.mentions)}
            </div>
          </div>
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} style={{ visibility: 'hidden' }} />
    </>
  );
}

function LocationNode({ data }: NodeProps) {
  const isDark = document.documentElement.classList.contains('dark');
  const colors = isDark ? darkEntityColors.location : entityColors.location;
  return (
    <>
      <Handle type="target" position={Position.Top} style={{ visibility: 'hidden' }} />
      <div
        className="rounded-[var(--radius)] border-l-[3px] border font-mono shadow-hard-sm cursor-pointer"
        style={{
          borderLeftColor: colors.border,
          borderColor: isDark ? 'hsl(240, 3.7%, 15.9%)' : 'hsl(240, 5.9%, 90%)',
          borderLeftWidth: '3px',
          backgroundColor: colors.bg,
          padding: '8px 12px',
          minWidth: '120px',
        }}
      >
        <div style={{ fontSize: '11px', fontWeight: 600, color: colors.text, display: 'flex', alignItems: 'center', gap: '4px' }}>
          <MapPin size={11} style={{ flexShrink: 0 }} />
          {String(data.label)}
        </div>
        <div style={{ fontSize: '9px', color: isDark ? '#a1a1aa' : '#71717a', marginTop: '2px' }}>
          {entityTypeLabels.location.toUpperCase()} · {String(data.mentions)} Erwähnungen
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} style={{ visibility: 'hidden' }} />
    </>
  );
}

const nodeTypes = {
  person: PersonNode,
  organization: OrganizationNode,
  event: EventNode,
  location: LocationNode,
};

// Build edges from story co-occurrence
function computeEdgesFromStories(): Map<string, number> {
  const edgeWeights = new Map<string, number>();
  for (const story of stories) {
    const entityIds = story.entities.map(e => e.id);
    for (let i = 0; i < entityIds.length; i++) {
      for (let j = i + 1; j < entityIds.length; j++) {
        const [a, b] = [entityIds[i], entityIds[j]].sort();
        const key = `${a}-${b}`;
        edgeWeights.set(key, (edgeWeights.get(key) || 0) + 1);
      }
    }
  }
  return edgeWeights;
}

function buildGraph() {
  const allEntities = entities;

  // Group entities by type for layout
  const grouped: Record<EntityType, Entity[]> = {
    person: [],
    organization: [],
    event: [],
    location: [],
  };
  for (const e of allEntities) {
    grouped[e.type].push(e);
  }

  // Layout: arrange by type in horizontal bands
  const nodes: Node[] = [];
  const typeOrder: EntityType[] = ['person', 'organization', 'event', 'location'];
  let yOffset = 0;

  for (const type of typeOrder) {
    const group = grouped[type];
    const cols = type === 'person' ? 5 : type === 'event' ? 4 : 4;
    for (let i = 0; i < group.length; i++) {
      const e = group[i];
      const row = Math.floor(i / cols);
      const col = i % cols;
      const jitterX = Math.sin(parseInt(e.id.slice(1)) * 3.7) * 40;
      const jitterY = Math.cos(parseInt(e.id.slice(1)) * 2.3) * 25;
      const spacingX = type === 'event' ? 320 : 280;
      const spacingY = type === 'event' ? 200 : 160;
      nodes.push({
        id: e.id,
        type: e.type,
        position: {
          x: 80 + col * spacingX + jitterX,
          y: yOffset + row * spacingY + jitterY,
        },
        data: { label: e.name, entityType: e.type, mentions: e.mentions },
      });
    }
    const rows = Math.ceil(group.length / (type === 'person' ? 5 : 4));
    yOffset += rows * (type === 'event' ? 200 : 160) + 80;
  }

  // Compute edges from story co-occurrence
  const edgeWeights = computeEdgesFromStories();
  const entityIdSet = new Set(allEntities.map(e => e.id));

  const edges: Edge[] = [];
  for (const [key, weight] of edgeWeights.entries()) {
    const [source, target] = key.split('-');
    if (entityIdSet.has(source) && entityIdSet.has(target)) {
      edges.push({
        id: key,
        source,
        target,
        style: { stroke: 'hsl(var(--muted-foreground) / 0.3)', strokeWidth: Math.min(weight, 4) },
        animated: weight >= 3,
      });
    }
  }

  return { nodes, edges };
}

const { nodes: initialNodes, edges: initialEdges } = buildGraph();

const typeFilters: EntityType[] = ['person', 'organization', 'event', 'location'];

export default function Graph() {
  const [selected, setSelected] = useState<Entity | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [activeFilters, setActiveFilters] = useState<Set<EntityType>>(new Set(typeFilters));

  const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    const entity = entities.find(e => e.id === node.id);
    if (entity) setSelected(entity);
  }, []);

  const toggleFilter = (type: EntityType) => {
    setActiveFilters(prev => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  };

  const filteredNodes = initialNodes.filter(n => activeFilters.has(n.data.entityType as EntityType));
  const filteredNodeIds = new Set(filteredNodes.map(n => n.id));
  const filteredEdges = initialEdges.filter(e => filteredNodeIds.has(e.source) && filteredNodeIds.has(e.target));

  // Compute connected entities for the selected entity using story co-occurrence
  const connectedEntities = useMemo(() => {
    if (!selected) return [];
    const connected = new Set<string>();
    for (const story of stories) {
      const ids = story.entities.map(e => e.id);
      if (ids.includes(selected.id)) {
        for (const id of ids) {
          if (id !== selected.id) connected.add(id);
        }
      }
    }
    return entities.filter(e => connected.has(e.id));
  }, [selected]);

  return (
    <div className="flex h-[calc(100vh-48px)]">
      {/* Left Sidebar - Filters */}
      {sidebarOpen && (
        <div className="w-64 border-r bg-card overflow-y-auto">
          <div className="p-4 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold flex items-center gap-1.5">
                <Filter size={14} /> Filter
              </h3>
              <button onClick={() => setSidebarOpen(false)} className="text-muted-foreground hover:text-foreground">
                <X size={14} />
              </button>
            </div>

            {/* Search */}
            <div className="relative">
              <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <input
                type="text"
                placeholder="Akteur suchen..."
                className="w-full rounded-[var(--radius)] border bg-background py-1.5 pl-7 pr-3 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>

            {/* Entity Types */}
            <div>
              <h4 className="mb-2 font-mono text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Akteur-Typen</h4>
              <div className="space-y-1.5">
                {typeFilters.map((type) => {
                  const count = entities.filter(e => e.type === type).length;
                  const colors = entityColors[type];
                  return (
                    <label key={type} className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={activeFilters.has(type)}
                        onChange={() => toggleFilter(type)}
                        className="rounded border"
                      />
                      <span
                        className="h-2.5 w-2.5 rounded-sm border"
                        style={{ backgroundColor: colors.bg, borderColor: colors.border }}
                      />
                      <span className="text-xs flex-1">{entityTypeLabels[type]}</span>
                      <span className="font-mono text-[10px] text-muted-foreground">{count}</span>
                    </label>
                  );
                })}
              </div>
            </div>

            {/* Min connections */}
            <div>
              <h4 className="mb-2 font-mono text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Min. Verbindungen</h4>
              <input type="range" min="0" max="15" defaultValue="0" className="w-full" />
              <div className="flex justify-between mt-1">
                <span className="font-mono text-[10px] text-muted-foreground">0</span>
                <span className="font-mono text-[10px] text-muted-foreground">15</span>
              </div>
            </div>

            {/* Time range */}
            <div>
              <h4 className="mb-2 font-mono text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Zeitraum</h4>
              <input type="range" min="2019" max="2024" defaultValue="2024" className="w-full" />
              <div className="flex justify-between mt-1">
                <span className="font-mono text-[10px] text-muted-foreground">2019</span>
                <span className="font-mono text-[10px] text-muted-foreground">2024</span>
              </div>
            </div>

            {/* Stats */}
            <div className="rounded-[var(--radius)] border bg-muted/30 p-3">
              <div className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider mb-2">Netzwerk-Statistik</div>
              <div className="space-y-1 text-xs">
                <div className="flex justify-between"><span className="text-muted-foreground">Knoten</span><span className="font-mono font-medium">{filteredNodes.length}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Kanten</span><span className="font-mono font-medium">{filteredEdges.length}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Cluster</span><span className="font-mono font-medium">3</span></div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Graph Canvas */}
      <div className="flex-1 relative">
        {!sidebarOpen && (
          <button
            onClick={() => setSidebarOpen(true)}
            className="absolute top-4 left-4 z-10 flex items-center gap-1.5 rounded-[var(--radius)] border bg-card px-3 py-1.5 text-xs shadow-hard-sm"
          >
            <Filter size={12} /> Filter
          </button>
        )}

        {/* Graph Toolbar */}
        <div className="absolute top-4 right-4 z-10 flex items-center gap-2">
          <div className="flex items-center gap-1 rounded-[var(--radius)] border bg-card p-1 shadow-hard-sm">
            <button className="rounded px-2 py-1 text-[11px] font-medium bg-primary/10 text-primary">Kraft</button>
            <button className="rounded px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted">Hierarchisch</button>
            <button className="rounded px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted">Radial</button>
          </div>
          <button className="rounded-[var(--radius)] border bg-card px-3 py-1.5 text-[11px] shadow-hard-sm hover:bg-muted">
            Cluster
          </button>
          <button className="rounded-[var(--radius)] border bg-accent/30 px-3 py-1.5 text-[11px] font-medium text-accent-foreground shadow-hard-sm">
            Neue Entdeckungen
          </button>
        </div>

        <ReactFlow
          nodes={filteredNodes}
          edges={filteredEdges}
          nodeTypes={nodeTypes}
          onNodeClick={onNodeClick}
          fitView
          minZoom={0.3}
          maxZoom={2}
          defaultEdgeOptions={{ type: 'default' }}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>

      {/* Right Panel - Entity Detail */}
      {selected && (
        <div className="w-72 border-l bg-card overflow-y-auto">
          <div className="p-4 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">{selected.name}</h3>
              <button onClick={() => setSelected(null)} className="text-muted-foreground hover:text-foreground">
                <X size={14} />
              </button>
            </div>

            <EntityBadge type={selected.type} name={entityTypeLabels[selected.type]} size="sm" />

            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-[var(--radius)] border p-2.5">
                <div className="font-mono text-[10px] text-muted-foreground">Erwähnungen</div>
                <div className="font-mono text-lg font-bold">{selected.mentions}</div>
              </div>
              <div className="rounded-[var(--radius)] border p-2.5">
                <div className="font-mono text-[10px] text-muted-foreground">Verbindungen</div>
                <div className="font-mono text-lg font-bold">{selected.connections}</div>
              </div>
            </div>

            {/* Connected Entities */}
            <div>
              <h4 className="mb-2 flex items-center gap-1.5 font-mono text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                <GitBranch size={10} /> Verbundene Akteure
              </h4>
              <div className="space-y-1">
                {connectedEntities
                  .slice(0, 8)
                  .map(e => (
                    <div key={e.id} className="flex items-center justify-between rounded-[var(--radius)] border px-2.5 py-1.5">
                      <EntityBadge type={e.type} name={e.name} size="xs" href={`/entities/${e.id}`} />
                    </div>
                  ))}
              </div>
            </div>

            {/* Related Stories */}
            <div>
              <h4 className="mb-2 flex items-center gap-1.5 font-mono text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                <BookOpen size={10} /> Verwandte Berichte
              </h4>
              <div className="space-y-1.5">
                {stories
                  .filter(s => s.entities.some(e => e.id === selected.id))
                  .slice(0, 3)
                  .map(s => (
                    <Link key={s.id} to={`/stories/${s.id}`} className="block rounded-[var(--radius)] border px-2.5 py-2 text-xs hover:bg-muted/50 transition-colors no-underline text-foreground">
                      <div className="font-medium">{s.title}</div>
                      <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">{s.source}</div>
                    </Link>
                  ))}
              </div>
            </div>

            <div className="flex gap-2">
              <Link
                to={`/entities/${selected.id}`}
                className="flex-1 rounded-[var(--radius)] border px-3 py-1.5 text-[11px] font-medium hover:bg-muted text-center no-underline text-foreground"
              >
                Akteur öffnen
              </Link>
              <button className="flex-1 rounded-[var(--radius)] border border-primary bg-primary/10 px-3 py-1.5 text-[11px] font-medium text-primary">
                Zum Board
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
