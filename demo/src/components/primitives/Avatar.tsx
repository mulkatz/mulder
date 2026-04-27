import * as RadixAvatar from '@radix-ui/react-avatar';
import { cn } from '@/lib/cn';

export const Avatar = ({ className, ...props }: RadixAvatar.AvatarProps) => (
  <RadixAvatar.Root
    className={cn(
      'inline-flex size-9 items-center justify-center overflow-hidden rounded-full bg-amber-soft align-middle',
      className,
    )}
    {...props}
  />
);

export const AvatarImage = ({ className, ...props }: RadixAvatar.AvatarImageProps) => (
  <RadixAvatar.Image className={cn('size-full object-cover', className)} {...props} />
);

export const AvatarFallback = ({ className, ...props }: RadixAvatar.AvatarFallbackProps) => (
  <RadixAvatar.Fallback
    className={cn(
      'flex size-full items-center justify-center font-mono text-[11px] uppercase tracking-[0.16em] text-amber',
      className,
    )}
    {...props}
  />
);
