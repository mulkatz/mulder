import { OverviewRibbon } from '@/components/Desk/OverviewRibbon';
import { RecentlyAdded } from '@/components/Desk/RecentlyAdded';
import { WorthFollowing } from '@/components/Desk/WorthFollowing';
import { copy } from '@/lib/copy';

export function DeskPage() {
  return (
    <section className="space-y-10">
      <div className="max-w-3xl">
        <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-amber">{copy.nav.desk}</p>
        <h1 className="mt-2 font-serif text-5xl text-ink">{copy.desk.title}</h1>
        <p className="mt-3 text-lg text-ink-muted">{copy.desk.body}</p>
      </div>

      <OverviewRibbon />

      <section className="space-y-4">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h2 className="mt-2 font-serif text-3xl text-ink">{copy.desk.recent.title}</h2>
          </div>
        </div>
        <RecentlyAdded />
      </section>

      <section className="space-y-4">
        <div>
          <h2 className="mt-2 font-serif text-3xl text-ink">{copy.desk.leads.title}</h2>
        </div>
        <WorthFollowing />
      </section>
    </section>
  );
}
