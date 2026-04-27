/* eslint-disable react-refresh/only-export-components */

import * as RadixToggleGroup from '@radix-ui/react-toggle-group';
import { cn } from '@/lib/cn';

export const ToggleGroup = RadixToggleGroup.Root;

export function ToggleGroupItem({ className, ...props }: RadixToggleGroup.ToggleGroupItemProps) {
  return (
    <RadixToggleGroup.Item
      className={cn(
        'inline-flex items-center gap-2 rounded-full border border-thread bg-surface px-3 py-1.5 text-xs text-ink-muted transition-colors',
        'hover:bg-raised hover:text-ink',
        'data-[state=on]:border-amber data-[state=on]:bg-amber-soft data-[state=on]:text-amber',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber/40',
        className,
      )}
      {...props}
    />
  );
}
