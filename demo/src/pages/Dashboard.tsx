import { Link } from 'react-router-dom';
import { FileText, BookOpen, GitBranch, AlertCircle, Upload, Eye, ArrowRight, Sparkles, CheckCircle, Flag, Layers } from 'lucide-react';
import EntityBadge from '../components/EntityBadge';
import ConfidenceBadge from '../components/ConfidenceBadge';
import { discoveries, processingQueue, recentActivity, entities } from '../data/mock';

const stats = [
  { label: 'Quellen', value: '38', icon: FileText, change: '+2 diese Woche' },
  { label: 'Berichte', value: '847', icon: BookOpen, change: '+23 diese Woche' },
  { label: 'Akteure', value: '2.156', icon: GitBranch, change: '+84 diese Woche' },
  { label: 'Offene Prüfungen', value: '14', icon: AlertCircle, change: '3 markiert', highlight: true },
];

const activityIcons: Record<string, React.ElementType> = {
  'Bericht freigegeben': CheckCircle,
  'Akteur bestätigt': CheckCircle,
  'Quelle hochgeladen': Upload,
  'Zusammenführung': Layers,
  'Board aktualisiert': Layers,
  'Bericht markiert': Flag,
};

export default function Dashboard() {
  return (
    <div className="p-6 space-y-6">
      {/* Stats Row */}
      <div className="grid grid-cols-4 gap-4">
        {stats.map((stat) => (
          <div
            key={stat.label}
            className={`rounded-[var(--radius)] border bg-card p-4 shadow-hard ${
              stat.highlight ? 'border-amber-400 dark:border-amber-600' : ''
            }`}
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{stat.label}</span>
              <stat.icon size={14} className={stat.highlight ? 'text-amber-500' : 'text-muted-foreground'} />
            </div>
            <div className="mt-2 font-mono text-2xl font-bold text-foreground">{stat.value}</div>
            <div className={`mt-1 text-[11px] ${stat.highlight ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}`}>
              {stat.change}
            </div>
          </div>
        ))}
      </div>

      {/* Two columns */}
      <div className="grid grid-cols-[1fr_380px] gap-6">
        {/* Left Column */}
        <div className="space-y-6">
          {/* Processing Queue */}
          <div className="rounded-[var(--radius)] border bg-card">
            <div className="flex items-center justify-between border-b px-4 py-3">
              <h2 className="text-sm font-semibold">Verarbeitungs-Warteschlange</h2>
              <span className="font-mono text-xs text-muted-foreground">{processingQueue.length} items</span>
            </div>
            <div className="divide-y">
              {processingQueue.map((item) => {
                const activeIdx = item.steps.indexOf(item.step);
                return (
                  <div key={item.id} className="px-4 py-3">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium">{item.title}</span>
                      <span className="font-mono text-xs text-muted-foreground">
                        {item.progress > 0 ? `${item.progress}%` : 'Wartend'}
                      </span>
                    </div>
                    {/* Pipeline Steps */}
                    <div className="mt-2 flex items-center gap-1">
                      {item.steps.map((step, i) => (
                        <div key={step} className="flex items-center">
                          <span
                            className={`font-mono text-[10px] px-1.5 py-0.5 rounded-[var(--radius)] border ${
                              i < activeIdx
                                ? 'bg-primary/10 text-primary border-primary/30'
                                : i === activeIdx
                                ? 'bg-primary text-primary-foreground border-primary'
                                : 'text-muted-foreground border-transparent'
                            }`}
                          >
                            {step}
                          </span>
                          {i < item.steps.length - 1 && (
                            <span className="mx-0.5 text-muted-foreground/40">→</span>
                          )}
                        </div>
                      ))}
                    </div>
                    {item.progress > 0 && (
                      <div className="mt-2 h-1 overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full bg-primary transition-all"
                          style={{ width: `${item.progress}%` }}
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Recent Activity */}
          <div className="rounded-[var(--radius)] border bg-card">
            <div className="flex items-center justify-between border-b px-4 py-3">
              <h2 className="text-sm font-semibold">Letzte Aktivität</h2>
              <button className="text-xs text-primary hover:underline">Alle anzeigen</button>
            </div>
            <div className="divide-y">
              {recentActivity.map((item) => {
                const Icon = activityIcons[item.action] || CheckCircle;
                return (
                  <div key={item.id} className="flex items-start gap-3 px-4 py-2.5">
                    <Icon size={14} className="mt-0.5 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div className="text-xs">
                        <span className="text-muted-foreground">{item.action}:</span>{' '}
                        <span className="font-medium text-foreground">{item.target}</span>
                      </div>
                      <div className="mt-0.5 text-[11px] text-muted-foreground">
                        {item.user} · {item.time}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Right Column */}
        <div className="space-y-6">
          {/* Quick Actions */}
          <div className="grid grid-cols-1 gap-3">
            <Link
              to="/upload"
              className="flex items-center justify-center gap-3 rounded-[var(--radius)] border border-primary bg-primary px-5 py-4 text-sm font-semibold text-primary-foreground shadow-hard-sm no-underline transition-transform hover:translate-y-[-1px]"
            >
              <Upload size={18} />
              Quelle hochladen
            </Link>
            <Link
              to="/sources/1/review/1"
              className="flex items-center justify-center gap-3 rounded-[var(--radius)] border bg-card px-5 py-4 text-sm font-semibold text-foreground shadow-hard-sm no-underline transition-transform hover:translate-y-[-1px]"
            >
              <Eye size={18} />
              Prüfung starten
              <span className="ml-1 flex h-5 min-w-[20px] items-center justify-center rounded-full bg-[#fef3c7] px-1.5 font-mono text-[11px] font-bold text-[#92400e] dark:bg-amber-900/50 dark:text-amber-400">
                14
              </span>
            </Link>
          </div>

          {/* AI Discoveries */}
          <div className="rounded-[var(--radius)] border bg-card">
            <div className="flex items-center justify-between border-b px-4 py-3">
              <div className="flex items-center gap-2">
                <Sparkles size={14} className="text-accent dark:text-accent" />
                <h2 className="text-sm font-semibold">KI-Entdeckungen</h2>
              </div>
              <span className="font-mono text-xs text-muted-foreground">{discoveries.length} new</span>
            </div>
            <div className="divide-y">
              {discoveries.map((d) => (
                <div key={d.id} className="px-4 py-3 space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-xs leading-relaxed text-foreground">{d.description}</p>
                  </div>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    {d.entities.slice(0, 3).map((e) => (
                      <EntityBadge key={e.id} type={e.type} name={e.name} size="xs" />
                    ))}
                    <ConfidenceBadge value={d.confidence} size="xs" />
                  </div>
                  <div className="flex items-center gap-2 pt-1">
                    <button className="flex items-center gap-1 text-[11px] font-medium text-primary hover:underline">
                      Untersuchen <ArrowRight size={10} />
                    </button>
                    <button className="text-[11px] text-muted-foreground hover:text-foreground">Zum Board</button>
                    <button className="text-[11px] text-muted-foreground hover:text-foreground">Verwerfen</button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Top Entities mini */}
          <div className="rounded-[var(--radius)] border bg-card">
            <div className="flex items-center justify-between border-b px-4 py-3">
              <h2 className="text-sm font-semibold">Top-Akteure</h2>
              <Link to="/graph" className="flex items-center gap-1 text-xs text-primary hover:underline no-underline">
                Netzwerk öffnen <ArrowRight size={10} />
              </Link>
            </div>
            <div className="divide-y">
              {entities.slice(0, 5).map((e) => (
                <div key={e.id} className="flex items-center justify-between px-4 py-2">
                  <EntityBadge type={e.type} name={e.name} size="xs" />
                  <span className="font-mono text-[10px] text-muted-foreground">{e.mentions} Erwähnungen</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
