/* eslint-disable react-refresh/only-export-components */

import * as RadixDialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { cn } from '@/lib/cn';

export const Dialog = RadixDialog.Root;
export const DialogTrigger = RadixDialog.Trigger;
export const DialogClose = RadixDialog.Close;
export const DialogTitle = RadixDialog.Title;

export function DialogContent({
  className,
  children,
  hideClose = false,
  ...props
}: RadixDialog.DialogContentProps & { hideClose?: boolean }) {
  return (
    <RadixDialog.Portal>
      <RadixDialog.Overlay className="fixed inset-0 bg-overlay/90 backdrop-blur-[2px]" />
      <RadixDialog.Content
        className={cn(
          'fixed left-1/2 top-1/2 z-50 w-[min(92vw,40rem)] -translate-x-1/2 -translate-y-1/2 rounded-xl',
          'border border-thread bg-raised p-6 shadow-xl',
          'data-[state=open]:animate-compose-in',
          className,
        )}
        {...props}
      >
        {!hideClose ? (
          <RadixDialog.Close className="absolute right-4 top-4 rounded-full p-1 text-ink-subtle hover:bg-surface hover:text-ink">
            <X className="size-4" />
          </RadixDialog.Close>
        ) : null}
        {children}
      </RadixDialog.Content>
    </RadixDialog.Portal>
  );
}
