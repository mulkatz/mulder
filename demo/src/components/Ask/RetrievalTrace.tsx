import { ChevronDown, ChevronUp } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button } from '@/components/primitives/Button';
import type { EntityRecord, SearchExplain } from '@/lib/api-types';
import { copy } from '@/lib/copy';

const STRATEGIES = ['vector', 'fulltext', 'graph'] as const;

export function RetrievalTrace({
  explain,
  entityMap,
  rerankApplied,
}: {
  explain: SearchExplain;
  entityMap: Map<string, EntityRecord>;
  rerankApplied: boolean;
}) {
  const [open, setOpen] = useState(false);

  const maxCount = useMemo(
    () => Math.max(1, ...STRATEGIES.map((strategy) => explain.counts[strategy] ?? 0)),
    [explain.counts],
  );

  return (
    <section className="rounded-2xl border border-thread bg-raised p-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-amber">{copy.ask.answer.trace}</p>
          <p className="mt-2 text-sm text-ink-muted">Inspect which retrieval lanes contributed and whether reranking ran.</p>
        </div>
        <Button onClick={() => setOpen((current) => !current)} variant="ghost">
          {open ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
        </Button>
      </div>

      {open ? (
        <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
          <div className="space-y-4">
            <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-ink-subtle">{copy.ask.trace.strategies}</p>
            {STRATEGIES.map((strategy) => {
              const count = explain.counts[strategy] ?? 0;
              const width = `${(count / maxCount) * 100}%`;

              return (
                <div key={strategy} className="space-y-1.5">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-ink-subtle">{strategy}</span>
                    <span className="font-mono text-[11px] text-ink-subtle">{count}</span>
                  </div>
                  <div className="h-2 rounded-full bg-thread">
                    <div className="h-full rounded-full bg-amber transition-[width] duration-base ease-out" style={{ width }} />
                  </div>
                </div>
              );
            })}
          </div>

          <div className="space-y-5">
            <div className="space-y-2">
              <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-ink-subtle">{copy.ask.trace.seedEntities}</p>
              <div className="flex flex-wrap gap-2">
                {explain.seed_entity_ids.length > 0 ? (
                  explain.seed_entity_ids.map((entityId) => (
                    <span key={entityId} className="rounded-full border border-thread px-2 py-1 text-sm text-ink-muted">
                      {entityMap.get(entityId)?.name ?? entityId}
                    </span>
                  ))
                ) : (
                  <span className="text-sm text-ink-muted">{copy.ask.trace.none}</span>
                )}
              </div>
            </div>

            <div className="space-y-2">
              <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-ink-subtle">{copy.ask.trace.rerank}</p>
              <span className="inline-flex rounded-full border border-thread px-3 py-1.5 text-sm text-ink">
                {rerankApplied ? copy.ask.trace.rerankApplied : copy.ask.trace.rerankSkipped}
              </span>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
