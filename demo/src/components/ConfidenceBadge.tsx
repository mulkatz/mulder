export default function ConfidenceBadge({ value, size = 'sm' }: { value: number; size?: 'xs' | 'sm' }) {
  const pct = Math.round(value * 100);
  const color = pct >= 85 ? 'text-green-600 dark:text-green-400' : pct >= 50 ? 'text-amber-600 dark:text-amber-400' : 'text-red-600 dark:text-red-400';
  const bg = pct >= 85 ? 'bg-green-50 dark:bg-green-900/30' : pct >= 50 ? 'bg-amber-50 dark:bg-amber-900/30' : 'bg-red-50 dark:bg-red-900/30';

  return (
    <span className={`inline-flex items-center rounded-[var(--radius)] border font-mono font-medium ${color} ${bg} ${
      size === 'xs' ? 'px-1 py-0 text-[10px]' : 'px-1.5 py-0.5 text-[11px]'
    }`}>
      {pct}%
    </span>
  );
}
