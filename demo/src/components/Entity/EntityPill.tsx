import type { EntityRecord } from '@/lib/api-types';
import { entityClass } from '@/lib/colors';
import { cn } from '@/lib/cn';
import { useEntityDrawer } from '@/app/stores/EntityDrawerStore';
import { EntityHoverCard } from './EntityHoverCard';

interface EntityPillProps {
  entity: Pick<EntityRecord, 'id' | 'name' | 'type' | 'canonical_id'>;
  size?: 'sm' | 'md';
  interactive?: boolean;
}

export function EntityPill({ entity, size = 'sm', interactive = true }: EntityPillProps) {
  const drawer = useEntityDrawer();
  const pill = (
    <button
      className={cn(
        'inline-flex items-center rounded-full border border-current font-mono tracking-tight',
        entityClass(entity.type),
        size === 'sm' ? 'px-2 py-1 text-[11px]' : 'px-2.5 py-1.5 text-xs',
        entity.canonical_id ? 'shadow-[0_0_0_2px_var(--thread-strong)]' : '',
      )}
      onClick={() => drawer.openEntity(entity.id)}
      type="button"
    >
      {entity.name}
    </button>
  );

  if (!interactive) {
    return pill;
  }

  return <EntityHoverCard entity={entity}>{pill}</EntityHoverCard>;
}
