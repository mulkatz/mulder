import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export function InspectorPanel({
  title,
  subtitle,
  children,
  className,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <aside className={cn('panel min-w-0 overflow-hidden', className)}>
      <div className="border-b border-border p-4">
        <h2 className="text-base font-semibold text-text">{title}</h2>
        {subtitle ? <p className="mt-1 text-sm text-text-muted">{subtitle}</p> : null}
      </div>
      <div className="p-4">{children}</div>
    </aside>
  );
}

export function InspectorSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-b border-border py-4 first:pt-0 last:border-b-0 last:pb-0">
      <h3 className="mb-3 text-xs font-medium text-text-subtle">{title}</h3>
      {children}
    </section>
  );
}
