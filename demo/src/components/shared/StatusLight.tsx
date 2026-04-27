import { cn } from '@/lib/cn';

type Tone = 'amber' | 'sage' | 'carmine' | 'ash';

const toneClass: Record<Tone, string> = {
  amber: 'bg-amber',
  sage: 'bg-sage',
  carmine: 'bg-carmine',
  ash: 'bg-ink-faint',
};

export function StatusLight({ tone = 'ash', className }: { tone?: Tone; className?: string }) {
  return <span aria-hidden className={cn('status-dot', toneClass[tone], className)} />;
}
