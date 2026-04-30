import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export function Toolbar({ children, className }: { children: ReactNode; className?: string }) {
	return (
		<div className={cn('flex flex-wrap items-center gap-2 border-b border-border bg-panel p-3', className)}>
			{children}
		</div>
	);
}

export function SelectControl({ label, children }: { label: string; children: ReactNode }) {
	return (
		<button
			className="field inline-flex h-9 items-center gap-2 px-3 text-sm text-text transition-colors hover:bg-field-hover"
			type="button"
		>
			<span className="text-text-subtle">{label}</span>
			<span>{children}</span>
		</button>
	);
}
