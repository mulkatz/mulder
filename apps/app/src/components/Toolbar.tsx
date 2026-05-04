import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export function Toolbar({ children, className }: { children: ReactNode; className?: string }) {
	return (
		<div className={cn('flex flex-wrap items-center gap-2 border-b border-border bg-panel p-3', className)}>
			{children}
		</div>
	);
}

export function SelectControl({
	children,
	disabled = false,
	label,
	title,
}: {
	children: ReactNode;
	disabled?: boolean;
	label: string;
	title?: string;
}) {
	return (
		<button
			className="field inline-flex h-9 items-center gap-2 px-3 text-sm text-text transition-colors hover:bg-field-hover disabled:text-text-faint disabled:hover:bg-field"
			disabled={disabled}
			title={title}
			type="button"
		>
			<span className="text-text-subtle">{label}</span>
			<span>{children}</span>
		</button>
	);
}
