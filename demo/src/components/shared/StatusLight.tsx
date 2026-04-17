import { cn } from '@/lib/cn';

type StatusTone = 'amber' | 'sage' | 'carmine' | 'cobalt' | 'ink';

const toneClass: Record<StatusTone, string> = {
  amber: 'bg-amber',
  sage: 'bg-sage',
  carmine: 'bg-carmine',
  cobalt: 'bg-cobalt',
  ink: 'bg-ink-subtle',
};

export function StatusLight({ tone = 'amber', className }: { tone?: StatusTone; className?: string }) {
  return <span aria-hidden="true" className={cn('inline-flex size-1.5 shrink-0 rounded-full', toneClass[tone], className)} />;
}
