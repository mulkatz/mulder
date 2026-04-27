export const ENTITY_CLASS = {
  person: 'entity-person',
  location: 'entity-location',
  organization: 'entity-org',
  event: 'entity-event',
  concept: 'entity-concept',
  date: 'entity-date',
} as const;

export function entityClass(type: string): string {
  const normalized = type.toLowerCase() as keyof typeof ENTITY_CLASS;
  return ENTITY_CLASS[normalized] ?? 'entity-concept';
}
