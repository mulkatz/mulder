import { cn } from '@/lib/cn';

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        'animate-pulse-soft rounded-md bg-[linear-gradient(90deg,var(--amber-faint),var(--scrim),var(--amber-faint))] bg-[length:200%_100%]',
        className,
      )}
    />
  );
}
