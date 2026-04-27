import { forwardRef, type InputHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      className={cn(
        'w-full rounded-md border border-thread bg-raised px-3 py-2 text-sm text-ink',
        'placeholder:text-ink-faint focus:border-amber focus:outline-none',
        className,
      )}
      {...props}
    />
  );
});
