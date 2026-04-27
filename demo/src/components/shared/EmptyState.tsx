export function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-xl border border-dashed border-thread-strong bg-surface px-6 py-10 text-center">
      <h2 className="font-serif text-3xl text-ink">{title}</h2>
      <p className="mx-auto mt-3 max-w-xl text-sm text-ink-muted">{body}</p>
    </div>
  );
}
