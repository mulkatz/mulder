import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export function PageHeader({
	eyebrow,
	title,
	description,
	actions,
	className,
}: {
	eyebrow: string;
	title: string;
	description: string;
	actions?: ReactNode;
	className?: string;
}) {
	return (
		<div
			className={cn(
				'flex flex-col justify-between gap-4 border-b border-border bg-canvas px-4 py-5 sm:px-6 lg:flex-row lg:items-end',
				className,
			)}
		>
			<div className="min-w-0">
				<p className="font-mono text-xs text-accent">{eyebrow}</p>
				<h1 className="mt-1 text-2xl font-semibold text-text">{title}</h1>
				<p className="mt-1 max-w-3xl text-sm text-text-muted">{description}</p>
			</div>
			{actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
		</div>
	);
}
