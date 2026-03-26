const statusConfig = {
  approved: { label: 'Approved', class: 'text-[#15803d] bg-[#dcfce7] border-[#86efac] dark:text-green-400 dark:bg-green-900/30 dark:border-green-800' },
  needs_review: { label: 'Needs Review', class: 'text-[#92400e] bg-[#fef3c7] border-[#fcd34d] dark:text-amber-400 dark:bg-amber-900/30 dark:border-amber-800' },
  flagged: { label: 'Flagged', class: 'text-[#991b1b] bg-[#fee2e2] border-[#fca5a5] dark:text-red-400 dark:bg-red-900/30 dark:border-red-800' },
  processed: { label: 'Processed', class: 'text-[#15803d] bg-[#dcfce7] border-[#86efac] dark:text-green-400 dark:bg-green-900/30 dark:border-green-800' },
  processing: { label: 'Processing', class: 'text-[#1e40af] bg-[#dbeafe] border-[#93c5fd] dark:text-blue-400 dark:bg-blue-900/30 dark:border-blue-800' },
  queued: { label: 'Queued', class: 'text-muted-foreground bg-muted' },
  error: { label: 'Error', class: 'text-[#991b1b] bg-[#fee2e2] border-[#fca5a5] dark:text-red-400 dark:bg-red-900/30 dark:border-red-800' },
  confirmed: { label: 'Confirmed', class: 'text-[#15803d] bg-[#dcfce7] border-[#86efac] dark:text-green-400 dark:bg-green-900/30 dark:border-green-800' },
  suggested: { label: 'Suggested', class: 'text-[#92400e] bg-[#fef3c7] border-[#fcd34d] dark:text-amber-400 dark:bg-amber-900/30 dark:border-amber-800' },
} as const;

type StatusKey = keyof typeof statusConfig;

export default function StatusBadge({ status }: { status: StatusKey }) {
  const cfg = statusConfig[status];
  return (
    <span className={`inline-flex items-center rounded-[var(--radius)] px-1.5 py-0.5 text-[11px] font-medium border ${cfg.class}`}>
      {cfg.label}
    </span>
  );
}
