import { ArrowRight } from 'lucide-react';
import { useMemo } from 'react';
import { useAuditDrawer } from '@/app/stores/AuditDrawerStore';
import { useEntityDrawer } from '@/app/stores/EntityDrawerStore';
import { ConfidenceBar } from '@/components/shared/ConfidenceBar';
import { StatusLight } from '@/components/shared/StatusLight';
import { Skeleton } from '@/components/shared/Skeleton';
import { useContradictions } from '@/features/evidence/useContradictions';
import { useEntities } from '@/features/entities/useEntities';
import { copy } from '@/lib/copy';

function formatCount(value: number) {
  return new Intl.NumberFormat('en-US').format(value);
}

type Lead =
  | {
      id: string;
      kind: 'contradiction';
      title: string;
      detail: string;
      tone: 'carmine';
      action: string;
    }
  | {
      id: string;
      kind: 'entity';
      entityId: string;
      title: string;
      detail: string;
      tone: 'sage';
      confidence: number | null;
    };

export function WorthFollowing() {
  const contradictions = useContradictions({ status: 'confirmed', limit: 3 });
  const entities = useEntities({ limit: 50 });
  const audit = useAuditDrawer();
  const drawer = useEntityDrawer();

  const leads = useMemo<Lead[]>(() => {
    const contradictionLeads =
      contradictions.data?.data.map((item) => ({
        id: item.id,
        kind: 'contradiction' as const,
        title: copy.desk.leads.contradiction,
        detail: copy.desk.leads.contradictionDetail(
          item.attributes.attribute,
          item.attributes.valueA,
          item.attributes.valueB,
        ),
        tone: 'carmine' as const,
        action: copy.desk.leads.openAudit,
      })) ?? [];

    const rankedEntities = [...(entities.data?.data ?? [])]
      .filter((entity) => typeof entity.corroboration_score === 'number')
      .sort((left, right) => {
        const leftScore = left.corroboration_score ?? 0;
        const rightScore = right.corroboration_score ?? 0;
        if (rightScore !== leftScore) {
          return rightScore - leftScore;
        }

        return right.source_count - left.source_count;
      })
      .slice(0, 3)
      .map((entity) => ({
        id: entity.id,
        kind: 'entity' as const,
        entityId: entity.id,
        title: copy.desk.leads.entity,
        detail: copy.desk.leads.entityDetail(entity.name, formatCount(entity.source_count)),
        tone: 'sage' as const,
        confidence: entity.corroboration_score,
      }));

    return [...contradictionLeads, ...rankedEntities].slice(0, 8);
  }, [contradictions.data, entities.data]);

  if (contradictions.isLoading || entities.isLoading) {
    return (
      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-36 rounded-2xl" />
        <Skeleton className="h-36 rounded-2xl" />
      </div>
    );
  }

  if (leads.length === 0) {
    return (
      <div className="rounded-2xl border border-thread bg-surface p-6 text-sm text-ink-muted">
        {copy.desk.leads.empty}
      </div>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {leads.map((lead) => (
        <button
          key={lead.id}
          className="group rounded-2xl border border-thread bg-surface p-5 text-left transition-colors hover:bg-raised"
          onClick={() => {
            if (lead.kind === 'entity') {
              drawer.openEntity(lead.entityId);
              return;
            }

            audit.openAudit('contradictions');
          }}
          type="button"
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-ink-subtle">{lead.title}</p>
              <p className="mt-2 font-serif text-2xl text-ink">{lead.detail}</p>
            </div>
            <StatusLight tone={lead.tone} className="mt-1" />
          </div>
          {lead.kind === 'entity' ? (
            <div className="mt-4">
              <ConfidenceBar label={copy.desk.leads.corroboration} value={lead.confidence} />
            </div>
          ) : (
            <div className="mt-4 flex items-center justify-between gap-3 text-sm text-ink-muted">
              <span>{lead.action}</span>
              <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
            </div>
          )}
        </button>
      ))}
    </div>
  );
}
