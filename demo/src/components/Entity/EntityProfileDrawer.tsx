import { useQueries } from '@tanstack/react-query';
import { ArrowRight } from 'lucide-react';
import { useEntityDrawer } from '@/app/stores/EntityDrawerStore';
import { Drawer, DrawerContent } from '@/components/primitives/Drawer';
import { Separator } from '@/components/primitives/Separator';
import { Button } from '@/components/primitives/Button';
import { ConfidenceBar } from '@/components/shared/ConfidenceBar';
import { Skeleton } from '@/components/shared/Skeleton';
import { useEntity } from '@/features/entities/useEntity';
import { useEntityEdges } from '@/features/entities/useEntityEdges';
import { apiFetch } from '@/lib/api-client';
import type { EntityDetailResponse } from '@/lib/api-types';
import { entityClass } from '@/lib/colors';

export function EntityProfileDrawer() {
  const drawer = useEntityDrawer();
  const detail = useEntity(drawer.entityId);
  const edges = useEntityEdges(drawer.entityId);
  const relatedIds = [...new Set((edges.data?.data ?? []).flatMap((edge) => [edge.source_entity_id, edge.target_entity_id]))]
    .filter((id) => id !== drawer.entityId)
    .slice(0, 6);

  const related = useQueries({
    queries: relatedIds.map((id) => ({
      queryKey: ['entities', 'detail', id],
      queryFn: () => apiFetch<EntityDetailResponse>(`/api/entities/${id}`),
      staleTime: 300_000,
    })),
  });

  const relatedMap = new Map(
    related
      .map((query) => query.data?.data.entity)
      .filter((entity): entity is NonNullable<typeof entity> => Boolean(entity))
      .map((entity) => [entity.id, entity]),
  );

  return (
    <Drawer onOpenChange={(open) => (!open ? drawer.close() : undefined)} open={drawer.open}>
      <DrawerContent aria-describedby={undefined}>
        {detail.isLoading ? (
          <div className="space-y-4">
            <Skeleton className="h-8 w-40" />
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : detail.data ? (
          <div className="space-y-5">
            <div>
              <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-amber">Entity profile</p>
              <h2 className="mt-2 font-serif text-4xl text-ink">{detail.data.data.entity.name}</h2>
              <span className={`mt-3 inline-flex rounded-full px-2 py-1 font-mono text-[11px] uppercase tracking-[0.16em] ${entityClass(detail.data.data.entity.type)}`}>
                {detail.data.data.entity.type}
              </span>
            </div>
            <ConfidenceBar label="Corroboration" value={detail.data.data.entity.corroboration_score} />
            <div className="grid grid-cols-2 gap-3 rounded-xl border border-thread bg-surface p-4 text-sm">
              <div>
                <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-ink-subtle">Sources</p>
                <p className="mt-1 text-ink">{detail.data.data.entity.source_count}</p>
              </div>
              <div>
                <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-ink-subtle">Taxonomy</p>
                <p className="mt-1 text-ink">{detail.data.data.entity.taxonomy_status}</p>
              </div>
            </div>
            <Separator />
            <section>
              <h3 className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-subtle">Aliases</h3>
              <div className="mt-3 flex flex-wrap gap-2">
                {detail.data.data.aliases.length > 0 ? (
                  detail.data.data.aliases.map((alias) => (
                    <span key={alias.id} className="rounded-full border border-thread px-2 py-1 text-sm text-ink-muted">
                      {alias.alias}
                    </span>
                  ))
                ) : (
                  <p className="text-sm text-ink-muted">No aliases recorded.</p>
                )}
              </div>
            </section>
            <Separator />
            <section>
              <h3 className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-subtle">Attributes</h3>
              <dl className="mt-3 space-y-3">
                {Object.entries(detail.data.data.entity.attributes).length > 0 ? (
                  Object.entries(detail.data.data.entity.attributes).map(([key, value]) => (
                    <div key={key} className="grid grid-cols-[9rem_1fr] gap-3 text-sm">
                      <dt className="font-mono uppercase tracking-[0.14em] text-ink-subtle">{key}</dt>
                      <dd className="text-ink">{String(value)}</dd>
                    </div>
                  ))
                ) : (
                  <p className="text-sm text-ink-muted">No structured attributes are stored for this entity yet.</p>
                )}
              </dl>
            </section>
            <Separator />
            <section>
              <h3 className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-subtle">Related entities</h3>
              <div className="mt-3 space-y-2">
                {(edges.data?.data ?? []).slice(0, 6).map((edge) => {
                  const relatedId = edge.source_entity_id === drawer.entityId ? edge.target_entity_id : edge.source_entity_id;
                  const relatedEntity = relatedMap.get(relatedId);

                  return (
                    <button
                      key={edge.id}
                      className="flex w-full items-center justify-between rounded-lg border border-thread bg-surface px-3 py-3 text-left hover:bg-raised"
                      onClick={() => drawer.openEntity(relatedId)}
                      type="button"
                    >
                      <div>
                        <p className="text-sm text-ink">{relatedEntity?.name ?? relatedId}</p>
                        <p className="mt-1 font-mono text-[11px] uppercase tracking-[0.14em] text-ink-subtle">{edge.relationship}</p>
                      </div>
                      <ArrowRight className="size-4 text-ink-subtle" />
                    </button>
                  );
                })}
              </div>
            </section>
            <Separator />
            <div className="flex items-center justify-end gap-3">
              <Button disabled variant="secondary">
                Merge…
              </Button>
              <Button disabled variant="secondary">
                See on Board
              </Button>
              <Button onClick={drawer.close}>Close</Button>
            </div>
          </div>
        ) : null}
      </DrawerContent>
    </Drawer>
  );
}
