import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import type { Metric } from '@/lib/types';

const toneClass = {
	neutral: 'text-text-muted',
	good: 'text-success',
	warning: 'text-warning',
	danger: 'text-danger',
} satisfies Record<Metric['tone'], string>;

function DeltaIcon({ tone }: { tone: Metric['tone'] }) {
	if (tone === 'good') return <ArrowUpRight className="size-3.5" />;
	if (tone === 'danger' || tone === 'warning') return <ArrowDownRight className="size-3.5" />;
	return <Minus className="size-3.5" />;
}

export function MetricCard({ metric, icon }: { metric: Metric; icon: ReactNode }) {
	return (
		<section className="panel p-4">
			<div className="flex items-center justify-between gap-3">
				<div className="flex size-9 items-center justify-center rounded-md bg-field text-text-muted">{icon}</div>
				<span className={cn('inline-flex items-center gap-1 text-xs', toneClass[metric.tone])}>
					<DeltaIcon tone={metric.tone} />
					{metric.delta}
				</span>
			</div>
			<p className="mt-5 font-mono text-[28px] font-semibold leading-none text-text">{metric.value}</p>
			<p className="mt-2 text-sm text-text-muted">{metric.label}</p>
		</section>
	);
}
