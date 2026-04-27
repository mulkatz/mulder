/* eslint-disable react-refresh/only-export-components */

import * as RadixTabs from '@radix-ui/react-tabs';
import { cn } from '@/lib/cn';

export const Tabs = RadixTabs.Root;

export function TabsList({ className, ...props }: RadixTabs.TabsListProps) {
  return (
    <RadixTabs.List
      className={cn('inline-flex items-center gap-2 border-b border-thread', className)}
      {...props}
    />
  );
}

export function TabsTrigger({ className, ...props }: RadixTabs.TabsTriggerProps) {
  return (
    <RadixTabs.Trigger
      className={cn(
        'relative inline-flex items-center gap-2 px-3 py-2 text-sm text-ink-muted transition-colors',
        'hover:text-ink',
        'data-[state=active]:text-ink',
        'data-[state=active]:after:absolute data-[state=active]:after:-bottom-px data-[state=active]:after:left-0',
        'data-[state=active]:after:right-0 data-[state=active]:after:h-[2px] data-[state=active]:after:bg-amber',
        className,
      )}
      {...props}
    />
  );
}

export function TabsContent({ className, ...props }: RadixTabs.TabsContentProps) {
  return <RadixTabs.Content className={cn('pt-4 outline-none', className)} {...props} />;
}
