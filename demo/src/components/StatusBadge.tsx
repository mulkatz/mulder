const statusConfig = {
  approved: { label: 'Approved', class: 'text-green-700 bg-green-50 dark:text-green-400 dark:bg-green-900/30' },
  needs_review: { label: 'Needs Review', class: 'text-amber-700 bg-amber-50 dark:text-amber-400 dark:bg-amber-900/30' },
  flagged: { label: 'Flagged', class: 'text-red-700 bg-red-50 dark:text-red-400 dark:bg-red-900/30' },
  processed: { label: 'Processed', class: 'text-green-700 bg-green-50 dark:text-green-400 dark:bg-green-900/30' },
  processing: { label: 'Processing', class: 'text-blue-700 bg-blue-50 dark:text-blue-400 dark:bg-blue-900/30' },
  queued: { label: 'Queued', class: 'text-muted-foreground bg-muted' },
  error: { label: 'Error', class: 'text-red-700 bg-red-50 dark:text-red-400 dark:bg-red-900/30' },
  confirmed: { label: 'Confirmed', class: 'text-green-700 bg-green-50 dark:text-green-400 dark:bg-green-900/30' },
  suggested: { label: 'Suggested', class: 'text-amber-700 bg-amber-50 dark:text-amber-400 dark:bg-amber-900/30' },
} as const;

type StatusKey = keyof typeof statusConfig;

export default function StatusBadge({ status }: { status: StatusKey }) {
  const cfg = statusConfig[status];
  return (
    <span className={`inline-flex items-center rounded-[var(--radius)] border px-1.5 py-0.5 text-[11px] font-medium ${cfg.class}`}>
      {cfg.label}
    </span>
  );
}
