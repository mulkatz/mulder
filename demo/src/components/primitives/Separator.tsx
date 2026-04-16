import * as RadixSeparator from '@radix-ui/react-separator';
import { cn } from '@/lib/cn';

export function Separator({ className, ...props }: RadixSeparator.SeparatorProps) {
  return <RadixSeparator.Root className={cn('bg-thread data-[orientation=horizontal]:h-px data-[orientation=vertical]:w-px', className)} {...props} />;
}
