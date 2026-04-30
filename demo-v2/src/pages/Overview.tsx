import { AlertTriangle, Archive, Database, Network, Play, ShieldCheck } from 'lucide-react';
import { DataTable, type DataColumn } from '@/components/DataTable';
import { InspectorPanel, InspectorSection } from '@/components/InspectorPanel';
import { MetricCard } from '@/components/MetricCard';
import { PageHeader } from '@/components/PageHeader';
import { StatusBadge } from '@/components/StatusBadge';
import { Toolbar } from '@/components/Toolbar';
import { activity, findings, metrics, runs, trend } from '@/lib/fixtures';
import type { ActivityEvent, AnalysisRun, Finding } from '@/lib/types';

const activeRuns = runs.filter((run) => run.status === 'running' || run.status === 'queued' || run.status === 'watching');

const activeRunColumns: DataColumn<AnalysisRun>[] = [
  {
    key: 'title',
    header: 'Run',
    render: (run) => (
      <div className="min-w-0">
        <p className="truncate font-medium text-text">{run.title}</p>
        <p className="mt-1 truncate font-mono text-xs text-text-subtle">{run.id}</p>
      </div>
    ),
  },
  { key: 'mode', header: 'Mode', render: (run) => <span className="text-text-muted">{run.mode}</span> },
  { key: 'status', header: 'Status', render: (run) => <StatusBadge status={run.status} /> },
  {
    key: 'progress',
    header: 'Progress',
    render: (run) => (
      <div className="flex items-center gap-3">
        <div className="h-1.5 w-28 overflow-hidden rounded-xs bg-field">
          <div className="h-full rounded-xs bg-accent" style={{ width: `${run.progress}%` }} />
        </div>
        <span className="font-mono text-xs text-text-muted">{run.progress}%</span>
      </div>
    ),
  },
  { key: 'findings', header: 'Findings', render: (run) => <span className="font-mono text-sm">{run.findings}</span> },
];

const activityColumns: DataColumn<ActivityEvent>[] = [
  {
    key: 'event',
    header: 'Event',
    render: (event) => (
      <div>
        <p className="font-medium text-text">{event.label}</p>
        <p className="mt-1 text-xs text-text-muted">{event.detail}</p>
      </div>
    ),
  },
  { key: 'time', header: 'Time', className: 'w-24', render: (event) => <span className="font-mono text-xs">{event.time}</span> },
  { key: 'status', header: 'Status', className: 'w-28', render: (event) => <StatusBadge status={event.status} /> },
];

function FindingRow({ finding }: { finding: Finding }) {
  return (
    <div className="border-b border-border px-4 py-3 last:border-b-0">
      <div className="flex items-center justify-between gap-3">
        <StatusBadge status={finding.severity} />
        <span className="font-mono text-xs text-text-subtle">{finding.createdAt}</span>
      </div>
      <p className="mt-3 font-medium text-text">{finding.title}</p>
      <p className="mt-1 text-sm text-text-muted">{finding.summary}</p>
      <p className="mt-2 font-mono text-xs text-text-subtle">{finding.entity}</p>
    </div>
  );
}

export function OverviewPage() {
  return (
    <>
      <PageHeader
        actions={
          <button className="inline-flex h-9 items-center gap-2 rounded-md bg-accent px-3 text-sm font-medium text-text-inverse transition-colors hover:bg-accent-hover" type="button">
            <Play className="size-4" />
            Start analysis
          </button>
        }
        description="System pulse, corpus health, active analyses, and high-signal findings."
        eyebrow="Overview"
        title="Analysis control plane"
      />

      <div className="space-y-4 p-4 sm:p-6">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard icon={<Archive className="size-4" />} metric={metrics[0]} />
          <MetricCard icon={<Network className="size-4" />} metric={metrics[1]} />
          <MetricCard icon={<AlertTriangle className="size-4" />} metric={metrics[2]} />
          <MetricCard icon={<ShieldCheck className="size-4" />} metric={metrics[3]} />
        </div>

        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
          <section className="panel min-w-0 overflow-hidden">
            <Toolbar>
              <div className="flex items-center gap-2">
                <Database className="size-4 text-accent" />
                <h2 className="font-medium text-text">Active analyses</h2>
              </div>
              <span className="ml-auto font-mono text-xs text-text-subtle">{activeRuns.length} live</span>
            </Toolbar>
            <DataTable columns={activeRunColumns} getRowKey={(run) => run.id} minWidth={660} rows={activeRuns} />
          </section>

          <InspectorPanel subtitle="Claims and entities needing attention" title="Recent findings">
            <div className="-m-4">
              {findings.map((finding) => (
                <FindingRow finding={finding} key={finding.id} />
              ))}
            </div>
          </InspectorPanel>
        </div>

        <div className="grid gap-4 xl:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
          <InspectorPanel title="Corpus trend">
            <InspectorSection title="Indexed documents">
              <div className="flex h-36 items-end gap-2">
                {trend.map((value, index) => (
                  <div className="flex flex-1 flex-col items-center gap-2" key={`${value}-${index}`}>
                    <div className="w-full rounded-t-sm bg-accent" style={{ height: `${Math.max(16, value)}%` }} />
                    <span className="font-mono text-[10px] text-text-faint">{index + 1}</span>
                  </div>
                ))}
              </div>
            </InspectorSection>
            <InspectorSection title="Queue">
              <div className="grid grid-cols-3 gap-2">
                <div className="rounded-md bg-field p-3">
                  <p className="font-mono text-lg font-semibold">04</p>
                  <p className="text-xs text-text-muted">Running</p>
                </div>
                <div className="rounded-md bg-field p-3">
                  <p className="font-mono text-lg font-semibold">12</p>
                  <p className="text-xs text-text-muted">Queued</p>
                </div>
                <div className="rounded-md bg-field p-3">
                  <p className="font-mono text-lg font-semibold">02</p>
                  <p className="text-xs text-text-muted">Blocked</p>
                </div>
              </div>
            </InspectorSection>
          </InspectorPanel>

          <section className="panel min-w-0 overflow-hidden">
            <Toolbar>
              <h2 className="font-medium text-text">Activity</h2>
            </Toolbar>
            <DataTable columns={activityColumns} getRowKey={(event) => event.id} minWidth={640} rows={activity} />
          </section>
        </div>
      </div>
    </>
  );
}
