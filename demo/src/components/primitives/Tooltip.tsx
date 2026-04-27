/* eslint-disable react-refresh/only-export-components */

import * as RadixTooltip from '@radix-ui/react-tooltip';
import { cn } from '@/lib/cn';

export const Tooltip = RadixTooltip.Root;
export const TooltipTrigger = RadixTooltip.Trigger;

export function TooltipContent({ className, ...props }: RadixTooltip.TooltipContentProps) {
  return (
    <RadixTooltip.Portal>
      <RadixTooltip.Content
        className={cn('z-50 rounded-md border border-thread bg-raised px-2 py-1 text-xs text-ink shadow-md', className)}
        sideOffset={8}
        {...props}
      />
    </RadixTooltip.Portal>
  );
}
