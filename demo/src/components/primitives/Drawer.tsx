import { Dialog, DialogContent } from '@/components/primitives/Dialog';
import { cn } from '@/lib/cn';

export { Dialog as Drawer };

export function DrawerContent(props: Parameters<typeof DialogContent>[0]) {
  return (
    <DialogContent
      {...props}
      className={cn(
        'left-auto right-0 top-0 h-screen w-[min(92vw,30rem)] translate-x-0 translate-y-0 rounded-none rounded-l-xl shadow-drawer',
        props.className,
      )}
    />
  );
}
