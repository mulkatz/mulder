import { Search } from 'lucide-react';
import type { InputHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

export function SearchInput({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
	return (
		<label className={cn('field flex h-9 min-w-0 items-center gap-2 px-3 text-text-subtle', className)}>
			<Search className="size-4 shrink-0" />
			<input
				className="min-w-0 flex-1 bg-transparent text-sm text-text outline-none placeholder:text-text-faint"
				type="search"
				{...props}
			/>
		</label>
	);
}
