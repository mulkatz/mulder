import { formatPageRange } from '@/lib/format';

export function PageRange({ start, end }: { start: number | null | undefined; end: number | null | undefined }) {
  return <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-ink-subtle">{formatPageRange(start, end)}</span>;
}
