/* eslint-disable react-refresh/only-export-components */

import * as RadixPopover from '@radix-ui/react-popover';
import { cn } from '@/lib/cn';

export const Popover = RadixPopover.Root;
export const PopoverTrigger = RadixPopover.Trigger;
export const PopoverAnchor = RadixPopover.Anchor;

export function PopoverContent({ className, ...props }: RadixPopover.PopoverContentProps) {
  return (
    <RadixPopover.Portal>
      <RadixPopover.Content
        sideOffset={8}
        className={cn(
          'z-50 w-72 rounded-md border border-thread bg-raised p-4 text-sm text-ink shadow-lg',
          'data-[state=open]:animate-compose-in',
          className,
        )}
        {...props}
      />
    </RadixPopover.Portal>
  );
}
