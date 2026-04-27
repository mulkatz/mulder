import { formatRelativeTimestamp, formatTimestamp } from '@/lib/format';

export function Timestamp({ value }: { value: string }) {
  return (
    <time className="font-mono text-[11px] uppercase tracking-[0.16em] text-ink-subtle" dateTime={value} title={formatTimestamp(value)}>
      {formatRelativeTimestamp(value)}
    </time>
  );
}
