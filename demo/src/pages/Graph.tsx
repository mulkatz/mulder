import { useState, useCallback } from 'react';
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
import { Search, Filter, X, BookOpen, GitBranch } from 'lucide-react';
import EntityBadge from '../components/EntityBadge';
import { entities, stories, entityTypeLabels } from '../data/mock';
import type { EntityType, Entity } from '../data/mock';

const entityColors: Record<EntityType, { border: string; bg: string; text: string }> = {
  person: { border: '#3b82f6', bg: 'hsl(221, 83%, 95%)', text: '#1d4ed8' },
  organization: { border: '#f97316', bg: 'hsl(24, 95%, 93%)', text: '#c2410c' },
  event: { border: '#a855f7', bg: 'hsl(280, 65%, 95%)', text: '#7e22ce' },
  location: { border: '#22c55e', bg: 'hsl(142, 71%, 93%)', text: '#15803d' },
};

const darkEntityColors: Record<EntityType, { border: string; bg: string; text: string }> = {
  person: { border: '#60a5fa', bg: 'hsl(221, 83%, 12%)', text: '#93bbfd' },
  organization: { border: '#fb923c', bg: 'hsl(24, 95%, 12%)', text: '#fdba74' },
  event: { border: '#c084fc', bg: 'hsl(280, 65%, 12%)', text: '#d8b4fe' },
  location: { border: '#4ade80', bg: 'hsl(142, 71%, 10%)', text: '#86efac' },
};

function EntityNode({ data }: NodeProps) {
  const isDark = document.documentElement.classList.contains('dark');
  const colors = isDark ? darkEntityColors[data.entityType as EntityType] : entityColors[data.entityType as EntityType];
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
        <div style={{ fontSize: '11px', fontWeight: 600, color: colors.text }}>{String(data.label)}</div>
        <div style={{ fontSize: '9px', color: isDark ? '#a1a1aa' : '#71717a', marginTop: '2px' }}>
          {(data.entityType as string).toUpperCase()} · {String(data.mentions)} mentions
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} style={{ visibility: 'hidden' }} />
    </>
  );
}

const nodeTypes = { entity: EntityNode };

function buildGraph() {
  const graphEntities = entities.slice(0, 16);
  const nodes: Node[] = graphEntities.map((e, i) => {
    const cols = 4;
    const row = Math.floor(i / cols);
    const col = i % cols;
    const jitterX = (Math.sin(i * 3.7) * 60);
    const jitterY = (Math.cos(i * 2.3) * 40);
    return {
      id: e.id,
      type: 'entity',
      position: { x: 100 + col * 280 + jitterX, y: 80 + row * 160 + jitterY },
      data: { label: e.name, entityType: e.type, mentions: e.mentions },
    };
  });

  const edgePairs: [string, string, number][] = [
    ['e1', 'e4', 5], ['e1', 'e9', 3], ['e1', 'e16', 4], ['e1', 'e7', 3],
    ['e2', 'e4', 4], ['e2', 'e9', 3], ['e2', 'e5', 2],
    ['e3', 'e5', 3], ['e3', 'e6', 3], ['e3', 'e14', 2],
    ['e4', 'e9', 5], ['e4', 'e10', 4], ['e4', 'e11', 4], ['e4', 'e12', 2], ['e4', 'e15', 3],
    ['e5', 'e6', 4], ['e5', 'e9', 2],
    ['e6', 'e12', 2],
    ['e7', 'e12', 2], ['e7', 'e13', 1],
    ['e8', 'e16', 2], ['e8', 'e4', 2],
    ['e9', 'e10', 3], ['e9', 'e11', 2],
    ['e10', 'e11', 3], ['e10', 'e15', 2],
    ['e12', 'e15', 2],
    ['e13', 'e16', 1],
    ['e16', 'e17', 2],
    ['e17', 'e7', 1],
    ['e18', 'e4', 1], ['e18', 'e12', 1],
  ];

  const edges: Edge[] = edgePairs.map(([s, t, w]) => ({
    id: `${s}-${t}`,
    source: s,
    target: t,
    style: { stroke: 'hsl(var(--muted-foreground) / 0.3)', strokeWidth: Math.min(w, 4) },
    animated: w >= 4,
  }));

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

  return (
    <div className="flex h-[calc(100vh-48px)]">
      {/* Left Sidebar - Filters */}
      {sidebarOpen && (
        <div className="w-64 border-r bg-card overflow-y-auto">
          <div className="p-4 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold flex items-center gap-1.5">
                <Filter size={14} /> Filters
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
                placeholder="Find entity..."
                className="w-full rounded-[var(--radius)] border bg-background py-1.5 pl-7 pr-3 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>

            {/* Entity Types */}
            <div>
              <h4 className="mb-2 font-mono text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Entity Types</h4>
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
              <h4 className="mb-2 font-mono text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Min Connections</h4>
              <input type="range" min="0" max="15" defaultValue="0" className="w-full" />
              <div className="flex justify-between mt-1">
                <span className="font-mono text-[10px] text-muted-foreground">0</span>
                <span className="font-mono text-[10px] text-muted-foreground">15</span>
              </div>
            </div>

            {/* Time range */}
            <div>
              <h4 className="mb-2 font-mono text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Time Range</h4>
              <input type="range" min="2019" max="2024" defaultValue="2024" className="w-full" />
              <div className="flex justify-between mt-1">
                <span className="font-mono text-[10px] text-muted-foreground">2019</span>
                <span className="font-mono text-[10px] text-muted-foreground">2024</span>
              </div>
            </div>

            {/* Stats */}
            <div className="rounded-[var(--radius)] border bg-muted/30 p-3">
              <div className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider mb-2">Graph Stats</div>
              <div className="space-y-1 text-xs">
                <div className="flex justify-between"><span className="text-muted-foreground">Nodes</span><span className="font-mono font-medium">{filteredNodes.length}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Edges</span><span className="font-mono font-medium">{filteredEdges.length}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Clusters</span><span className="font-mono font-medium">3</span></div>
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
            <Filter size={12} /> Filters
          </button>
        )}

        {/* Graph Toolbar */}
        <div className="absolute top-4 right-4 z-10 flex items-center gap-2">
          <div className="flex items-center gap-1 rounded-[var(--radius)] border bg-card p-1 shadow-hard-sm">
            <button className="rounded px-2 py-1 text-[11px] font-medium bg-primary/10 text-primary">Force</button>
            <button className="rounded px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted">Hierarchical</button>
            <button className="rounded px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted">Radial</button>
          </div>
          <button className="rounded-[var(--radius)] border bg-card px-3 py-1.5 text-[11px] shadow-hard-sm hover:bg-muted">
            Cluster
          </button>
          <button className="rounded-[var(--radius)] border bg-accent/30 px-3 py-1.5 text-[11px] font-medium text-accent-foreground shadow-hard-sm">
            ✦ New Discoveries
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
                <div className="font-mono text-[10px] text-muted-foreground">Mentions</div>
                <div className="font-mono text-lg font-bold">{selected.mentions}</div>
              </div>
              <div className="rounded-[var(--radius)] border p-2.5">
                <div className="font-mono text-[10px] text-muted-foreground">Connections</div>
                <div className="font-mono text-lg font-bold">{selected.connections}</div>
              </div>
            </div>

            {/* Connected Entities */}
            <div>
              <h4 className="mb-2 flex items-center gap-1.5 font-mono text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                <GitBranch size={10} /> Connected Entities
              </h4>
              <div className="space-y-1">
                {entities
                  .filter(e => e.id !== selected.id)
                  .slice(0, 5)
                  .map(e => (
                    <div key={e.id} className="flex items-center justify-between rounded-[var(--radius)] border px-2.5 py-1.5">
                      <EntityBadge type={e.type} name={e.name} size="xs" />
                    </div>
                  ))}
              </div>
            </div>

            {/* Related Stories */}
            <div>
              <h4 className="mb-2 flex items-center gap-1.5 font-mono text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                <BookOpen size={10} /> Related Stories
              </h4>
              <div className="space-y-1.5">
                {stories
                  .filter(s => s.entities.some(e => e.id === selected.id))
                  .slice(0, 3)
                  .map(s => (
                    <div key={s.id} className="rounded-[var(--radius)] border px-2.5 py-2 text-xs">
                      <div className="font-medium">{s.title}</div>
                      <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">{s.source}</div>
                    </div>
                  ))}
              </div>
            </div>

            <div className="flex gap-2">
              <button className="flex-1 rounded-[var(--radius)] border px-3 py-1.5 text-[11px] font-medium hover:bg-muted">
                Show in Archive
              </button>
              <button className="flex-1 rounded-[var(--radius)] border border-primary bg-primary/10 px-3 py-1.5 text-[11px] font-medium text-primary">
                Add to Board
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
