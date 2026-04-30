import { cn } from '@/lib/cn';

const toneByStatus: Record<string, string> = {
	completed: 'bg-success-soft text-success border-success/20',
	corroborated: 'bg-success-soft text-success border-success/20',
	running: 'bg-info-soft text-info border-info/20',
	queued: 'bg-field text-text-muted border-border',
	watching: 'bg-warning-soft text-warning border-warning/20',
	contradicted: 'bg-danger-soft text-danger border-danger/20',
	failed: 'bg-danger-soft text-danger border-danger/20',
	unverified: 'bg-field text-text-muted border-border',
	low: 'bg-field text-text-muted border-border',
	medium: 'bg-warning-soft text-warning border-warning/20',
	high: 'bg-danger-soft text-danger border-danger/20',
	critical: 'bg-danger text-text-inverse border-danger',
};

export function StatusBadge({ status, className }: { status: string; className?: string }) {
	return (
		<span
			className={cn(
				'inline-flex h-6 items-center rounded-sm border px-2 font-mono text-[11px] capitalize leading-none',
				toneByStatus[status] ?? 'bg-field text-text-muted border-border',
				className,
			)}
		>
			{status.replaceAll('_', ' ')}
		</span>
	);
}
