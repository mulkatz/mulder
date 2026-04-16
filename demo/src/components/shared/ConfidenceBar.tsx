import { cn } from '@/lib/cn';
import { formatConfidence } from '@/lib/format';

export function ConfidenceBar({
  value,
  className,
  label,
}: {
  value: number | null | undefined;
  className?: string;
  label?: string;
}) {
  const normalized = typeof value === 'number' ? Math.max(0, Math.min(value, 1)) : 0;

  return (
    <div className={cn('space-y-1', className)}>
      {label ? (
        <div className="flex items-center justify-between gap-2">
          <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-subtle">{label}</span>
          <span className="font-mono text-[11px] text-ink-subtle">{formatConfidence(value)}</span>
        </div>
      ) : null}
      <div className="h-1.5 rounded-full bg-thread">
        <div className="h-full rounded-full bg-amber transition-[width] duration-base ease-out" style={{ width: `${normalized * 100}%` }} />
      </div>
    </div>
  );
}
