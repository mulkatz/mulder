import { ChevronDown, ExternalLink, Filter, Link2, ShieldAlert } from 'lucide-react';
import { useMemo, useState } from 'react';
import { DataTable, type DataColumn } from '@/components/DataTable';
import { IconButton } from '@/components/IconButton';
import { InspectorPanel, InspectorSection } from '@/components/InspectorPanel';
import { PageHeader } from '@/components/PageHeader';
import { SearchInput } from '@/components/SearchInput';
import { StatusBadge } from '@/components/StatusBadge';
import { Tabs } from '@/components/Tabs';
import { SelectControl, Toolbar } from '@/components/Toolbar';
import { evidenceClaims } from '@/lib/fixtures';
import type { EvidenceClaim, SourceRef } from '@/lib/types';

const tabs = [
  { value: 'all', label: 'All', count: evidenceClaims.length },
  { value: 'corroborated', label: 'Corroborated', count: evidenceClaims.filter((claim) => claim.status === 'corroborated').length },
  { value: 'contradicted', label: 'Contradicted', count: evidenceClaims.filter((claim) => claim.status === 'contradicted').length },
  { value: 'watching', label: 'Watching', count: evidenceClaims.filter((claim) => claim.status === 'watching').length },
  { value: 'unverified', label: 'Unverified', count: evidenceClaims.filter((claim) => claim.status === 'unverified').length },
];

const claimColumns: DataColumn<EvidenceClaim>[] = [
  {
    key: 'claim',
    header: 'Claim',
    render: (claim) => (
      <div className="min-w-0">
        <p className="max-w-2xl truncate font-medium text-text">{claim.claim}</p>
        <p className="mt-1 truncate font-mono text-xs text-text-subtle">{claim.id}</p>
      </div>
    ),
  },
  { key: 'entity', header: 'Entity', className: 'w-44', render: (claim) => <span className="text-text-muted">{claim.entity}</span> },
  { key: 'status', header: 'Status', className: 'w-36', render: (claim) => <StatusBadge status={claim.status} /> },
  {
    key: 'confidence',
    header: 'Confidence',
    className: 'w-36',
    render: (claim) => (
      <div className="flex items-center gap-3">
        <div className="h-1.5 w-20 overflow-hidden rounded-xs bg-field">
          <div className="h-full rounded-xs bg-accent" style={{ width: `${Math.round(claim.confidence * 100)}%` }} />
        </div>
        <span className="font-mono text-xs text-text-muted">{Math.round(claim.confidence * 100)}%</span>
      </div>
    ),
  },
  { key: 'sources', header: 'Sources', className: 'w-24', render: (claim) => <span className="font-mono">{claim.sourceCount}</span> },
  { key: 'lastSeen', header: 'Last seen', className: 'w-36', render: (claim) => <span className="font-mono text-xs">{claim.lastSeen}</span> },
];

const citationColumns: DataColumn<SourceRef>[] = [
  {
    key: 'title',
    header: 'Source',
    render: (source) => (
      <div className="min-w-0">
        <p className="truncate font-medium text-text">{source.title}</p>
        <p className="mt-1 font-mono text-xs text-text-subtle">{source.id}</p>
      </div>
    ),
  },
  { key: 'type', header: 'Type', className: 'w-28', render: (source) => <span className="text-text-muted">{source.type}</span> },
  { key: 'locator', header: 'Locator', className: 'w-24', render: (source) => <span className="font-mono text-xs">{source.locator}</span> },
  {
    key: 'reliability',
    header: 'Reliability',
    className: 'w-28',
    render: (source) => <span className="font-mono text-xs">{Math.round(source.reliability * 100)}%</span>,
  },
];

export function EvidenceWorkspacePage() {
  const [status, setStatus] = useState('all');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState(evidenceClaims[0].id);

  const filteredClaims = useMemo(() => {
    return evidenceClaims.filter((claim) => {
      const statusMatch = status === 'all' || claim.status === status;
      const queryMatch = `${claim.claim} ${claim.entity} ${claim.id}`.toLowerCase().includes(query.toLowerCase());
      return statusMatch && queryMatch;
    });
  }, [query, status]);

  const selectedClaim = filteredClaims.find((claim) => claim.id === selectedId) ?? filteredClaims[0] ?? evidenceClaims[0];

  return (
    <>
      <PageHeader
        actions={
          <button className="inline-flex h-9 items-center gap-2 rounded-md bg-accent px-3 text-sm font-medium text-text-inverse transition-colors hover:bg-accent-hover" type="button">
            <ShieldAlert className="size-4" />
            Review queue
          </button>
        }
        description="Claims, citations, confidence signals, and source reliability in one review surface."
        eyebrow="Evidence Workspace"
        title="Resolve claims with citations"
      />

      <div className="grid gap-4 p-4 sm:p-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <section className="panel min-w-0 overflow-hidden">
          <Toolbar className="gap-3">
            <SearchInput className="w-full sm:max-w-sm" onChange={(event) => setQuery(event.target.value)} placeholder="Filter claims..." value={query} />
            <SelectControl label="Source">
              Any
              <ChevronDown className="size-3.5 text-text-subtle" />
            </SelectControl>
            <SelectControl label="Reliability">
              50%+
              <ChevronDown className="size-3.5 text-text-subtle" />
            </SelectControl>
            <IconButton label="Advanced filters">
              <Filter className="size-4" />
            </IconButton>
          </Toolbar>

          <div className="border-b border-border p-3">
            <Tabs onChange={setStatus} tabs={tabs} value={status} />
          </div>

          <DataTable
            columns={claimColumns}
            emptyMessage="No claims match the current filters"
            getRowKey={(claim) => claim.id}
            minWidth={760}
            onRowClick={(claim) => setSelectedId(claim.id)}
            rows={filteredClaims}
            selectedKey={selectedClaim.id}
          />
        </section>

        <InspectorPanel subtitle={selectedClaim.id} title={selectedClaim.entity}>
          <InspectorSection title="Claim">
            <p className="text-sm text-text">{selectedClaim.claim}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <StatusBadge status={selectedClaim.status} />
              <span className="inline-flex h-6 items-center rounded-sm border border-border bg-field px-2 font-mono text-[11px] text-text-muted">
                {Math.round(selectedClaim.confidence * 100)}% confidence
              </span>
            </div>
          </InspectorSection>

          <InspectorSection title="Signals">
            <div className="flex flex-wrap gap-2">
              {selectedClaim.signals.map((signal) => (
                <span className="rounded-sm border border-border bg-panel-raised px-2 py-1 text-xs text-text-muted" key={signal}>
                  {signal}
                </span>
              ))}
            </div>
          </InspectorSection>

          <InspectorSection title="Citations">
            <div className="-mx-4">
              <DataTable columns={citationColumns} getRowKey={(source) => source.id} minWidth={520} rows={selectedClaim.citations} />
            </div>
          </InspectorSection>

          <InspectorSection title="Source detail">
            <div className="space-y-2">
              {selectedClaim.citations.map((source) => (
                <div className="rounded-md border border-border bg-panel-raised p-3" key={`${selectedClaim.id}-${source.id}`}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-text">{source.title}</p>
                      <p className="mt-1 font-mono text-xs text-text-subtle">
                        {source.date} · {source.locator}
                      </p>
                    </div>
                    <IconButton className="size-7" label={`Open ${source.title}`}>
                      <ExternalLink className="size-3.5" />
                    </IconButton>
                  </div>
                  <div className="mt-3 flex items-center gap-2 text-xs text-text-muted">
                    <Link2 className="size-3.5 text-accent" />
                    <span>Reliability {Math.round(source.reliability * 100)}%</span>
                  </div>
                </div>
              ))}
            </div>
          </InspectorSection>
        </InspectorPanel>
      </div>
    </>
  );
}
