import type { EntityType } from '../data/mock';

const styles: Record<EntityType, string> = {
  person: 'entity-person',
  organization: 'entity-organization',
  event: 'entity-event',
  location: 'entity-location',
};

export default function EntityBadge({ type, name, size = 'sm' }: { type: EntityType; name: string; size?: 'xs' | 'sm' }) {
  return (
    <span
      className={`inline-flex items-center rounded-[var(--radius)] border px-1.5 font-mono font-medium ${styles[type]} ${
        size === 'xs' ? 'py-0 text-[10px]' : 'py-0.5 text-[11px]'
      }`}
      style={{ borderColor: 'currentColor', borderWidth: '1px', borderStyle: 'solid' }}
    >
      {name}
    </span>
  );
}
