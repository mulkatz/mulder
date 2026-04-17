import { ArrowRight } from 'lucide-react';
import { Button } from '@/components/primitives/Button';
import { StatusLight } from '@/components/shared/StatusLight';
import { Skeleton } from '@/components/shared/Skeleton';
import { useAuditDrawer } from '@/app/stores/AuditDrawerStore';
import { useEvidenceSummary } from '@/features/evidence/useEvidenceSummary';
import { copy } from '@/lib/copy';

function formatCount(value: number) {
  return new Intl.NumberFormat('en-US').format(value);
}

function Tile({
  label,
  value,
  caption,
  tone = 'amber',
  onClick,
}: {
  label: string;
  value: string;
  caption?: string;
  tone?: 'amber' | 'sage' | 'carmine' | 'cobalt';
  onClick?: () => void;
}) {
  if (onClick) {
    return (
      <button
        className="group flex min-h-36 flex-col justify-between rounded-2xl border border-thread bg-surface p-5 text-left transition-colors hover:bg-raised"
        onClick={onClick}
        type="button"
      >
        <div className="flex items-start justify-between gap-3">
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-subtle">{label}</p>
          <StatusLight tone={tone} className="mt-1" />
        </div>
        <div>
          <p className="font-serif text-5xl leading-none text-ink">{value}</p>
          {caption ? <p className="mt-3 max-w-[14rem] text-sm text-ink-muted">{caption}</p> : null}
        </div>
      </button>
    );
  }

  return (
    <div className="group flex min-h-36 flex-col justify-between rounded-2xl border border-thread bg-surface p-5 text-left transition-colors hover:bg-raised">
      <div className="flex items-start justify-between gap-3">
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-subtle">{label}</p>
        <StatusLight tone={tone} className="mt-1" />
      </div>
      <div>
        <p className="font-serif text-5xl leading-none text-ink">{value}</p>
        {caption ? <p className="mt-3 max-w-[14rem] text-sm text-ink-muted">{caption}</p> : null}
      </div>
    </div>
  );
}

export function OverviewRibbon() {
  const summary = useEvidenceSummary();
  const audit = useAuditDrawer();

  if (summary.isLoading) {
    return (
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton key={index} className="h-36 rounded-2xl" />
        ))}
      </div>
    );
  }

  const data = summary.data?.data;
  const documents = data ? formatCount(data.sources.total) : '—';
  const entities = data ? formatCount(data.entities.total) : '—';
  const contradictions = data ? formatCount(data.contradictions.potential + data.contradictions.confirmed) : '—';
  const coverage = data
    ? `${Math.round((data.entities.scored / Math.max(data.entities.total, 1)) * 100)}%`
    : '—';

  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      <Tile
        caption={copy.desk.ribbon.documents}
        label={copy.desk.ribbon.documents}
        tone="cobalt"
        value={documents}
      />
      <Tile
        caption={copy.desk.ribbon.entities}
        label={copy.desk.ribbon.entities}
        tone="sage"
        value={entities}
      />
      <Tile
        caption={copy.desk.ribbon.contradictions}
        label={copy.desk.ribbon.contradictions}
        tone="carmine"
        value={contradictions}
        onClick={() => audit.openAudit('contradictions')}
      />
      <Tile
        caption={copy.desk.ribbon.coverage}
        label={copy.desk.ribbon.coverage}
        tone="amber"
        value={coverage}
      />
      <div className="md:col-span-2 xl:col-span-4">
        <div className="flex items-center justify-between rounded-xl border border-thread bg-surface px-4 py-3 text-sm text-ink-muted">
          <span>{copy.desk.ribbonNote}</span>
          <Button onClick={() => audit.openAudit('summary')} variant="ghost">
            {copy.desk.leads.openAudit}
            <ArrowRight className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
