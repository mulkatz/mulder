export default function ConfidenceBadge({ value, size = 'sm' }: { value: number; size?: 'xs' | 'sm' }) {
  const pct = Math.round(value * 100);
  const color = pct >= 85
    ? 'text-[#15803d] dark:text-green-400'
    : pct >= 50
    ? 'text-[#92400e] dark:text-amber-400'
    : 'text-[#991b1b] dark:text-red-400';
  const bg = pct >= 85
    ? 'bg-[#dcfce7] border-[#86efac] dark:bg-green-900/30 dark:border-green-800'
    : pct >= 50
    ? 'bg-[#fef3c7] border-[#fcd34d] dark:bg-amber-900/30 dark:border-amber-800'
    : 'bg-[#fee2e2] border-[#fca5a5] dark:bg-red-900/30 dark:border-red-800';

  return (
    <span className={`inline-flex items-center rounded-[var(--radius)] border font-mono font-medium ${color} ${bg} ${
      size === 'xs' ? 'px-1 py-0 text-[10px]' : 'px-1.5 py-0.5 text-[11px]'
    }`}>
      {pct}%
    </span>
  );
}
