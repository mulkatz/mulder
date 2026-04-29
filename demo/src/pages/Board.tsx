import '@xyflow/react/dist/style.css';

import { Background, Controls, Handle, MiniMap, Position, ReactFlow, type Edge, type Node } from '@xyflow/react';
import { useQueries } from '@tanstack/react-query';
import { List, Network, RotateCcw } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useEntityDrawer } from '@/app/stores/EntityDrawerStore';
import { Button } from '@/components/primitives/Button';
import { useEntities } from '@/features/entities/useEntities';
import { apiFetch } from '@/lib/api-client';
import type { EntityEdge, EntityEdgesResponse, EntityRecord } from '@/lib/api-types';
import { cn } from '@/lib/cn';
import { formatConfidence } from '@/lib/format';

const edgeTypes = [
  'all',
  'RELATIONSHIP',
  'DUPLICATE_OF',
  'POTENTIAL_CONTRADICTION',
  'CONFIRMED_CONTRADICTION',
  'DISMISSED_CONTRADICTION',
];
const graphNodeTypes = { entity: EntityNode };

export function BoardPage() {
  const entityDrawer = useEntityDrawer();
  const [entityType, setEntityType] = useState('all');
  const [edgeType, setEdgeType] = useState('all');
  const [listView, setListView] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches);
  const entities = useEntities({ limit: 100 });
  const rankedEntities = useMemo(() => rankEntities(entities.data?.data ?? []), [entities.data?.data]);
  const visibleEntities = rankedEntities.filter((entity) => entityType === 'all' || entity.type === entityType).slice(0, 100);
  const entityTypes = ['all', ...Array.from(new Set(rankedEntities.map((entity) => entity.type)))];

  const edgeQueries = useQueries({
    queries: visibleEntities.slice(0, 60).map((entity) => ({
      queryKey: ['entities', 'edges', entity.id],
      queryFn: () => apiFetch<EntityEdgesResponse>(`/api/entities/${entity.id}/edges`),
      staleTime: 300_000,
    })),
  });

  const graphEdges = useMemo(() => {
    const allEdges = edgeQueries.flatMap((query) => query.data?.data ?? []);
    const deduped = new Map<string, EntityEdge>();
    for (const edge of allEdges) {
      if (edgeType !== 'all' && edge.edge_type !== edgeType) {
        continue;
      }
      deduped.set(edge.id, edge);
    }
    return [...deduped.values()].slice(0, 160);
  }, [edgeQueries, edgeType]);

  const graph = useMemo(() => buildGraph(visibleEntities, graphEdges), [visibleEntities, graphEdges]);

  return (
    <section className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-amber">Board</p>
          <h1 className="mt-2 font-serif text-5xl text-ink">The entity graph, capped and honest.</h1>
          <p className="mt-3 max-w-3xl text-lg text-ink-muted">
            The V1 board uses <code className="font-mono">GET /api/entities</code> plus capped per-entity edge calls.
            A future aggregate edge endpoint can unlock full graph scale.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setListView((current) => !current)} variant="secondary">
            <List className="size-4" />
            {listView ? 'Graph view' : 'List view'}
          </Button>
          <Button onClick={() => setEntityType('all')} variant="ghost">
            <RotateCcw className="size-4" />
            Reset
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap gap-3 rounded-2xl border border-thread bg-raised p-4">
        <Filter label="Entity type" value={entityType} options={entityTypes} onChange={setEntityType} />
        <Filter label="Edge type" value={edgeType} options={edgeTypes} onChange={setEdgeType} />
      </div>

      {listView ? (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {visibleEntities.map((entity) => (
            <button
              key={entity.id}
              className="rounded-xl border border-thread bg-surface p-4 text-left hover:bg-raised"
              onClick={() => entityDrawer.openEntity(entity.id)}
            >
              <p className="font-serif text-2xl text-ink">{entity.name}</p>
              <p className="mt-1 font-mono text-[11px] uppercase tracking-[0.18em] text-ink-subtle">{entity.type}</p>
              <p className="mt-3 text-sm text-ink-muted">{entity.source_count} source mentions</p>
            </button>
          ))}
        </div>
      ) : (
        <div className="h-[46rem] w-full overflow-hidden rounded-2xl border border-thread bg-surface">
          <ReactFlow
            className="size-full"
            edges={graph.edges}
            fitView
            nodeTypes={graphNodeTypes}
            nodes={graph.nodes}
            onNodeClick={(_, node) => entityDrawer.openEntity(String(node.id))}
            style={{ height: '100%', width: '100%' }}
          >
            <Background />
            <Controls />
            <MiniMap pannable zoomable />
          </ReactFlow>
        </div>
      )}

      <div className="rounded-xl border border-amber-soft bg-amber-faint p-4 text-sm text-ink-muted">
        Temporal scrubber: the current corpus does not provide enough normalized event dates for a reliable timeline
        control, so the board renders graph and list exploration without pretending a timeline exists.
      </div>
    </section>
  );
}

function rankEntities(entities: EntityRecord[]) {
  return [...entities].sort((left, right) => {
    const leftScore = left.corroboration_score ?? -1;
    const rightScore = right.corroboration_score ?? -1;
    if (rightScore !== leftScore) return rightScore - leftScore;
    if (right.source_count !== left.source_count) return right.source_count - left.source_count;
    return left.name.localeCompare(right.name);
  });
}

function buildGraph(entities: EntityRecord[], entityEdges: EntityEdge[]): { nodes: Node[]; edges: Edge[] } {
  const entityIds = new Set(entities.map((entity) => entity.id));
  const radius = Math.max(240, entities.length * 20);
  const nodes = entities.map<Node>((entity, index) => {
    const angle = (index / Math.max(entities.length, 1)) * Math.PI * 2;
    return {
      id: entity.id,
      type: 'entity',
      position: {
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius,
      },
      data: { ...entity },
    };
  });
  const edges = entityEdges
    .filter((edge) => entityIds.has(edge.source_entity_id) && entityIds.has(edge.target_entity_id))
    .map<Edge>((edge) => ({
      id: edge.id,
      source: edge.source_entity_id,
      target: edge.target_entity_id,
      label: edge.relationship,
      animated: edge.edge_type.includes('CONTRADICTION'),
      style: {
        stroke: edge.edge_type.includes('CONTRADICTION') ? 'var(--carmine)' : edge.edge_type === 'DUPLICATE_OF' ? 'var(--amber)' : 'var(--cobalt)',
        strokeWidth: edge.edge_type.includes('CONTRADICTION') ? 2.5 : 1.5,
      },
    }));
  return { nodes, edges };
}

function Filter({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm text-ink-muted">
      {label}
      <select
        className="rounded-md border border-thread bg-raised px-3 py-2 text-sm text-ink focus:border-amber focus:outline-none"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {option.replaceAll('_', ' ').toLowerCase()}
          </option>
        ))}
      </select>
    </label>
  );
}

function EntityNode({ data }: { data: EntityRecord }) {
  return (
    <div
      aria-label={`${data.type} entity ${data.name}`}
      className={cn(
        'min-w-40 rounded-xl border bg-raised px-4 py-3 shadow-md',
        data.type === 'person' && 'border-entity-person/40',
        data.type === 'location' && 'border-entity-location/40',
        data.type === 'organization' && 'border-entity-org/40',
        data.type !== 'person' && data.type !== 'location' && data.type !== 'organization' && 'border-thread-strong',
      )}
    >
      <Handle position={Position.Top} type="target" />
      <div className="flex items-center gap-2">
        <Network className="size-4 text-amber" />
        <p className="font-serif text-lg text-ink">{data.name}</p>
      </div>
      <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.16em] text-ink-subtle">{data.type}</p>
      <p className="mt-2 text-xs text-ink-muted">
        {data.corroboration_score === null ? 'corroboration not meaningful yet' : formatConfidence(data.corroboration_score)}
      </p>
      <Handle position={Position.Bottom} type="source" />
    </div>
  );
}
