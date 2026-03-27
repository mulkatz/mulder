import { Link } from 'react-router-dom';
import { Search, GitBranch, Filter } from 'lucide-react';
import EntityBadge from '../components/EntityBadge';
import ConfidenceBadge from '../components/ConfidenceBadge';
import StatusBadge from '../components/StatusBadge';
import { entities, entityTypeLabels } from '../data/mock';
import type { EntityType } from '../data/mock';

const types: EntityType[] = ['person', 'organization', 'event', 'location'];
const statuses = ['confirmed', 'suggested'] as const;
const statusLabels: Record<typeof statuses[number], string> = {
  confirmed: 'Bestätigt',
  suggested: 'Vorgeschlagen',
};

function countByType(type: EntityType) {
  return entities.filter(e => e.type === type).length;
}

function countByStatus(status: 'confirmed' | 'suggested') {
  return entities.filter(e => e.status === status).length;
}

export default function EntityList() {
  return (
    <div className="flex h-[calc(100vh-48px)]">
      {/* Left Sidebar — Facet Filters */}
      <div className="w-56 border-r bg-card overflow-y-auto p-4 space-y-5">
        <div className="flex items-center gap-1.5">
          <Filter size={14} className="text-muted-foreground" />
          <h3 className="text-xs font-semibold">Filter</h3>
        </div>

        {/* Entity Types */}
        <div>
          <h4 className="mb-2 font-mono text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Akteur-Typ</h4>
          <div className="space-y-1">
            {types.map(type => (
              <label key={type} className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" defaultChecked className="rounded border" />
                <span className="text-xs">{entityTypeLabels[type]}</span>
                <span className="ml-auto font-mono text-[10px] text-muted-foreground">{countByType(type)}</span>
              </label>
            ))}
          </div>
        </div>

        {/* Status */}
        <div>
          <h4 className="mb-2 font-mono text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Status</h4>
          <div className="space-y-1">
            {statuses.map(status => (
              <label key={status} className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" defaultChecked className="rounded border" />
                <span className="text-xs">{statusLabels[status]}</span>
                <span className="ml-auto font-mono text-[10px] text-muted-foreground">{countByStatus(status)}</span>
              </label>
            ))}
          </div>
        </div>

        {/* Confidence Range */}
        <div>
          <h4 className="mb-2 font-mono text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Konfidenz</h4>
          <input type="range" min="0" max="100" defaultValue="0" className="w-full" />
          <div className="flex justify-between mt-1">
            <span className="font-mono text-[10px] text-muted-foreground">0%</span>
            <span className="font-mono text-[10px] text-muted-foreground">100%</span>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 overflow-y-auto">
        {/* Search Bar */}
        <div className="sticky top-0 z-10 border-b bg-card/95 backdrop-blur-sm px-6 py-4">
          <div className="relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              placeholder="Akteure durchsuchen..."
              className="w-full rounded-[var(--radius)] border bg-background py-2.5 pl-10 pr-4 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary"
            />
          </div>
          <div className="mt-3 flex items-center justify-between">
            <span className="text-xs text-muted-foreground">Zeige <span className="font-mono font-medium text-foreground">{entities.length}</span> Akteure</span>
          </div>
        </div>

        {/* Entity List */}
        <div className="divide-y">
          {entities.map((entity) => (
            <Link
              key={entity.id}
              to={`/entities/${entity.id}`}
              className="block px-6 py-4 hover:bg-muted/30 transition-colors no-underline"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <h3 className="text-sm font-semibold text-foreground">{entity.name}</h3>
                    <EntityBadge type={entity.type} name={entityTypeLabels[entity.type]} size="xs" />
                  </div>
                  <div className="mt-1.5 flex items-center gap-3 text-xs text-muted-foreground">
                    <span className="font-mono">{entity.mentions} Erwähnungen</span>
                    <span className="flex items-center gap-1">
                      <GitBranch size={11} />
                      <span className="font-mono">{entity.connections} Verbindungen</span>
                    </span>
                  </div>
                </div>
                <div className="flex flex-col items-end gap-1.5 shrink-0">
                  <ConfidenceBadge value={entity.confidence} />
                  <StatusBadge status={entity.status} />
                </div>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
