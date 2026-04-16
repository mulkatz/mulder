import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

type ButtonVariant = 'primary' | 'secondary' | 'ghost';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = 'primary', type = 'button', ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-md border px-4 py-2 text-sm transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-60',
        variant === 'primary' &&
          'border-amber bg-amber text-ink-inverse hover:border-amber-hover hover:bg-amber-hover',
        variant === 'secondary' &&
          'border-thread bg-surface text-ink hover:border-thread-strong hover:bg-raised',
        variant === 'ghost' && 'border-transparent bg-transparent text-ink-muted hover:bg-surface hover:text-ink',
        className,
      )}
      type={type}
      {...props}
    />
  );
});
