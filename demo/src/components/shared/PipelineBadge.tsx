import { cn } from '@/lib/cn';

const STATUS_CLASS: Record<string, string> = {
  ingested: 'bg-thread text-ink-muted',
  extracted: 'bg-cobalt-faint text-cobalt',
  segmented: 'bg-cobalt-faint text-cobalt',
  enriched: 'bg-amber-faint text-amber',
  embedded: 'bg-sage-faint text-sage',
  graphed: 'bg-sage-faint text-sage',
  analyzed: 'bg-sage-faint text-sage',
};

export function PipelineBadge({ status }: { status: string }) {
  return (
    <span className={cn('rounded-full px-2 py-1 font-mono text-[11px] uppercase tracking-[0.16em]', STATUS_CLASS[status] ?? 'bg-thread text-ink-muted')}>
      {status}
    </span>
  );
}
