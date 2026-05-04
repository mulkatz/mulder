import { AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

const iconByTone = {
	error: AlertCircle,
	info: CheckCircle2,
	loading: Loader2,
};

const toneClass = {
	error: 'border-danger/20 bg-danger-soft text-danger',
	info: 'border-border bg-panel-raised text-text-muted',
	loading: 'border-border bg-panel-raised text-text-muted',
};

export function StateNotice({
	children,
	className,
	tone = 'info',
	title,
}: {
	children?: ReactNode;
	className?: string;
	tone?: keyof typeof toneClass;
	title: string;
}) {
	const Icon = iconByTone[tone];

	return (
		<div className={cn('rounded-md border p-3 text-sm', toneClass[tone], className)}>
			<div className="flex items-start gap-2">
				<Icon className={cn('mt-0.5 size-4 shrink-0', tone === 'loading' && 'animate-spin')} />
				<div>
					<p className="font-medium">{title}</p>
					{children ? <div className="mt-1 text-text-muted">{children}</div> : null}
				</div>
			</div>
		</div>
	);
}
