import { useEffect, useState } from 'react';
import type { EntityRecord } from '@/lib/api-types';
import { useMentionIndex } from '@/app/stores/MentionIndexStore';
import { useEntityDrawer } from '@/app/stores/EntityDrawerStore';
import { useEntity } from '@/features/entities/useEntity';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/primitives/HoverCard';
import { Button } from '@/components/primitives/Button';
import { ConfidenceBar } from '@/components/shared/ConfidenceBar';
import { Skeleton } from '@/components/shared/Skeleton';
import { entityClass } from '@/lib/colors';

export function EntityHoverCard({
  entity,
  children,
}: {
  entity: Pick<EntityRecord, 'id' | 'name' | 'type' | 'canonical_id'>;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const detail = useEntity(entity.id);
  const mentionIndex = useMentionIndex();
  const drawer = useEntityDrawer();

  useEffect(() => {
    if (!open) {
      return;
    }

    const aliases = detail.data?.data.aliases.map((alias) => alias.alias) ?? [];
    const clear = mentionIndex.highlight(entity.id, [entity.name, ...aliases]);

    return () => {
      clear();
    };
  }, [detail.data, entity.id, entity.name, mentionIndex, open]);

  return (
    <HoverCard closeDelay={80} openDelay={120} onOpenChange={setOpen} open={open}>
      <HoverCardTrigger asChild>{children}</HoverCardTrigger>
      <HoverCardContent>
        {detail.isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-7 w-40" />
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <h3 className="font-serif text-2xl text-ink">{detail.data?.data.entity.name ?? entity.name}</h3>
              <span className={`mt-2 inline-flex rounded-full px-2 py-1 font-mono text-[11px] uppercase tracking-[0.16em] ${entityClass(entity.type)}`}>
                {entity.type}
              </span>
            </div>
            <div>
              <p className="mb-2 font-mono text-[11px] uppercase tracking-[0.16em] text-ink-subtle">Aliases</p>
              <div className="space-y-1 text-sm text-ink-muted">
                {(detail.data?.data.aliases ?? []).slice(0, 3).map((alias) => (
                  <p key={alias.id}>{alias.alias}</p>
                ))}
                {(detail.data?.data.aliases ?? []).length === 0 ? <p>No aliases recorded.</p> : null}
              </div>
            </div>
            <ConfidenceBar label="Corroboration" value={detail.data?.data.entity.corroboration_score} />
            <div className="flex items-center justify-between text-sm text-ink-muted">
              <span>Appears in {detail.data?.data.entity.source_count ?? 0} documents</span>
              <Button onClick={() => drawer.openEntity(entity.id)} variant="ghost">
                Open profile
              </Button>
            </div>
          </div>
        )}
      </HoverCardContent>
    </HoverCard>
  );
}
