import * as RadixScrollArea from '@radix-ui/react-scroll-area';
import { cn } from '@/lib/cn';

export const ScrollArea = ({ className, children, ...props }: RadixScrollArea.ScrollAreaProps) => (
  <RadixScrollArea.Root className={cn('overflow-hidden', className)} {...props}>
    <RadixScrollArea.Viewport className="size-full rounded-[inherit]">{children}</RadixScrollArea.Viewport>
    <RadixScrollArea.Scrollbar className="flex touch-none select-none p-0.5 transition-colors" orientation="vertical">
      <RadixScrollArea.Thumb className="relative flex-1 rounded-full bg-thread" />
    </RadixScrollArea.Scrollbar>
    <RadixScrollArea.Scrollbar className="flex touch-none select-none p-0.5 transition-colors" orientation="horizontal">
      <RadixScrollArea.Thumb className="relative flex-1 rounded-full bg-thread" />
    </RadixScrollArea.Scrollbar>
    <RadixScrollArea.Corner />
  </RadixScrollArea.Root>
);
