import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/cn';

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  children: ReactNode;
}

export function IconButton({ label, children, className, type = 'button', ...props }: IconButtonProps) {
  return (
    <button
      aria-label={label}
      className={cn(
        'inline-flex size-9 items-center justify-center rounded-md border border-border bg-panel text-text-muted transition-colors hover:border-border-strong hover:bg-field hover:text-text disabled:opacity-50',
        className,
      )}
      type={type}
      {...props}
    >
      {children}
    </button>
  );
}
