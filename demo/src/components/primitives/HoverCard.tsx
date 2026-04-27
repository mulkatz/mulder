/* eslint-disable react-refresh/only-export-components */

import * as RadixHoverCard from '@radix-ui/react-hover-card';
import { cn } from '@/lib/cn';

export const HoverCard = RadixHoverCard.Root;
export const HoverCardTrigger = RadixHoverCard.Trigger;

export function HoverCardContent({ className, ...props }: RadixHoverCard.HoverCardContentProps) {
  return (
    <RadixHoverCard.Portal>
      <RadixHoverCard.Content
        align="start"
        className={cn(
          'z-50 w-80 rounded-lg border border-thread bg-raised p-4 shadow-lg',
          'data-[state=open]:animate-compose-in',
          className,
        )}
        sideOffset={12}
        {...props}
      />
    </RadixHoverCard.Portal>
  );
}
