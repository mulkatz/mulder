import { AlertTriangle } from 'lucide-react';

export function ErrorState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-carmine/30 bg-carmine-faint p-6 text-carmine">
      <div className="mb-3 flex items-center gap-2">
        <AlertTriangle className="size-4" />
        <h2 className="font-serif text-2xl">{title}</h2>
      </div>
      <p className="max-w-2xl text-sm text-ink">{body}</p>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}
