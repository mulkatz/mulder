import { AlertTriangle, Archive, Gauge, Network, ServerCog } from 'lucide-react';
import type React from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/primitives/Button';
import { ErrorState } from '@/components/shared/ErrorState';
import { PipelineBadge } from '@/components/shared/PipelineBadge';
import { Timestamp } from '@/components/shared/Timestamp';
import { useDocuments } from '@/features/documents/useDocuments';
import { useEntities } from '@/features/entities/useEntities';
import { useContradictions } from '@/features/evidence/useContradictions';
import { useEvidenceSummary } from '@/features/evidence/useEvidenceSummary';
import { useJobs } from '@/features/jobs/useJobs';
import { useStatus } from '@/features/status/useStatus';
import { routes } from '@/lib/routes';

export function DeskPage() {
  const summary = useEvidenceSummary();
  const status = useStatus();
  const documents = useDocuments({ limit: 12 });
  const entities = useEntities({ limit: 100 });
  const contradictions = useContradictions({ status: 'all', limit: 6 });
  const jobs = useJobs({ limit: 6 });

  if (summary.isError || documents.isError) {
    return <ErrorState title="Desk unavailable" body="The API did not return the archive overview." />;
  }

  const evidence = summary.data?.data;
  const recentDocuments = [...(documents.data?.data ?? [])].sort((left, right) => right.created_at.localeCompare(left.created_at)).slice(0, 5);
  const topEntities = [...(entities.data?.data ?? [])]
    .sort((left, right) => right.source_count - left.source_count)
    .slice(0, 5);
  const activeJobs = status.data?.data.jobs.pending || status.data?.data.jobs.running;

  return (
    <section className="space-y-8">
      <div className="overflow-hidden rounded-[2rem] border border-thread bg-surface shadow-md">
        <div className="grid gap-8 p-8 lg:grid-cols-[minmax(0,1fr)_24rem] lg:p-10">
          <div>
            <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-amber">The Desk</p>
            <h1 className="mt-3 max-w-4xl font-serif text-5xl text-ink md:text-6xl">A live briefing from the archive.</h1>
            <p className="mt-4 max-w-2xl text-lg text-ink-muted">
              Everything here comes through the real API: evidence summary, document catalog, job state, entities, and
              contradictions. Sparse corpus statistics stay explicitly marked as insufficient.
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
              <Button onClick={() => window.dispatchEvent(new Event('mulder:open-upload'))}>
                Upload document
              </Button>
              <Link
                className="inline-flex items-center justify-center rounded-md border border-thread bg-raised px-4 py-2 text-sm text-ink no-underline hover:bg-surface"
                to={routes.ask()}
              >
                Ask the archive
              </Link>
            </div>
          </div>
          <div className="rounded-2xl border border-thread bg-raised p-5">
            <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-subtle">Runtime pulse</p>
            <div className="mt-4 grid grid-cols-2 gap-3">
              <MiniMetric label="Pending jobs" value={String(status.data?.data.jobs.pending ?? '—')} />
              <MiniMetric label="Running jobs" value={String(status.data?.data.jobs.running ?? '—')} />
              <MiniMetric label="Failed jobs" value={String(status.data?.data.jobs.failed ?? '—')} />
              <MiniMetric label="Budget left" value={`$${Math.round(status.data?.data.budget.remaining_usd ?? 0)}`} />
            </div>
            <p className="mt-4 text-sm text-ink-muted">
              {activeJobs ? 'Worker activity is visible in the job lane below.' : 'No active worker jobs right now.'}
            </p>
          </div>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Metric icon={<Archive />} label="Documents" value={String(evidence?.sources.total ?? '—')} />
        <Metric icon={<Network />} label="Entities" value={String(evidence?.entities.total ?? '—')} />
        <Metric
          icon={<Gauge />}
          label="Corroboration"
          value={
            evidence?.entities.avg_corroboration === null || evidence?.entities.avg_corroboration === undefined
              ? 'Insufficient'
              : `${Math.round(evidence.entities.avg_corroboration * 100)}%`
          }
        />
        <Metric
          icon={<AlertTriangle />}
          label="Contradictions"
          value={String((evidence?.contradictions.potential ?? 0) + (evidence?.contradictions.confirmed ?? 0))}
        />
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
        <Panel title="Recently added">
          <div className="divide-y divide-thread">
            {recentDocuments.map((document) => (
              <Link
                className="flex items-center justify-between gap-4 py-4 no-underline"
                key={document.id}
                to={routes.caseFile(document.id)}
              >
                <div className="min-w-0">
                  <p className="truncate font-serif text-2xl text-ink">{document.filename}</p>
                  <Timestamp value={document.created_at} />
                </div>
                <PipelineBadge status={document.status} />
              </Link>
            ))}
          </div>
        </Panel>

        <Panel title="Worth following">
          <div className="space-y-3">
            {(contradictions.data?.data ?? []).slice(0, 3).map((edge) => (
              <div key={edge.id} className="rounded-xl border border-carmine-soft bg-carmine-faint p-4">
                <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-carmine">
                  {edge.edge_type.replaceAll('_', ' ').toLowerCase()}
                </p>
                <p className="mt-1 font-serif text-xl text-ink">{edge.relationship}</p>
                <p className="mt-2 text-sm text-ink-muted">
                  {edge.attributes.valueA} vs {edge.attributes.valueB}
                </p>
              </div>
            ))}
            {topEntities.map((entity) => (
              <Link
                className="flex items-center justify-between rounded-xl border border-thread bg-surface p-3 no-underline"
                key={entity.id}
                to={routes.board()}
              >
                <span className="font-serif text-lg text-ink">{entity.name}</span>
                <span className="font-mono text-xs text-ink-muted">{entity.source_count} sources</span>
              </Link>
            ))}
          </div>
        </Panel>
      </div>

      <Panel title="Recent jobs">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {(jobs.data?.data ?? []).map((job) => (
            <div key={job.id} className="rounded-xl border border-thread bg-surface p-4">
              <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-subtle">{job.type}</p>
              <p className="mt-2 font-serif text-2xl capitalize text-ink">{job.status.replaceAll('_', ' ')}</p>
              <p className="mt-2 text-xs text-ink-muted">{job.id}</p>
            </div>
          ))}
          {jobs.data?.data.length === 0 ? (
            <div className="rounded-xl border border-thread bg-surface p-4 text-sm text-ink-muted">
              <ServerCog className="mb-2 size-5 text-ink-subtle" />
              No jobs have been recorded yet.
            </div>
          ) : null}
        </div>
      </Panel>
    </section>
  );
}

function Metric({ icon, label, value }: { icon: React.ReactElement; label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-thread bg-surface p-5 shadow-xs">
      <div className="flex items-center gap-3 text-ink-subtle">
        {icon}
        <p className="font-mono text-[11px] uppercase tracking-[0.18em]">{label}</p>
      </div>
      <p className="mt-4 font-serif text-4xl capitalize text-ink">{value}</p>
    </div>
  );
}

function MiniMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-surface p-3">
      <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink-subtle">{label}</p>
      <p className="mt-1 font-serif text-2xl text-ink">{value}</p>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-thread bg-raised p-5 shadow-xs">
      <h2 className="font-serif text-3xl text-ink">{title}</h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}
