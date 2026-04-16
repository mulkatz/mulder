/* eslint-disable react-refresh/only-export-components */

import * as RadixAccordion from '@radix-ui/react-accordion';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/cn';

export const Accordion = RadixAccordion.Root;

export const AccordionItem = ({ className, ...props }: RadixAccordion.AccordionItemProps) => (
  <RadixAccordion.Item className={cn('border-b border-thread last:border-b-0', className)} {...props} />
);

export const AccordionTrigger = ({
  className,
  children,
  ...props
}: RadixAccordion.AccordionTriggerProps) => (
  <RadixAccordion.Header>
    <RadixAccordion.Trigger
      className={cn(
        'group flex w-full items-start justify-between gap-3 px-4 py-4 text-left',
        'data-[state=open]:bg-surface/80 hover:bg-surface/60',
        className,
      )}
      {...props}
    >
      <span className="min-w-0 flex-1">{children}</span>
      <ChevronDown className="mt-0.5 size-4 shrink-0 text-ink-subtle transition-transform group-data-[state=open]:rotate-180" />
    </RadixAccordion.Trigger>
  </RadixAccordion.Header>
);

export const AccordionContent = ({ className, ...props }: RadixAccordion.AccordionContentProps) => (
  <RadixAccordion.Content className={cn('overflow-hidden px-4 pb-4 data-[state=open]:animate-compose-in', className)} {...props} />
);
