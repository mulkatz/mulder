import { Link } from 'react-router-dom';
import { FileText, BookOpen, GitBranch, AlertCircle, Upload, Eye, ArrowRight, Sparkles, CheckCircle, Flag, Layers, Radar } from 'lucide-react';
import EntityBadge from '../components/EntityBadge';
import ConfidenceBadge from '../components/ConfidenceBadge';
import { discoveries, processingQueue, recentActivity, semanticPatterns, stories } from '../data/mock';

const stats = [
  { label: 'Quellen', value: '38', icon: FileText, change: '+2 diese Woche', to: '/sources' },
  { label: 'Berichte', value: '847', icon: BookOpen, change: '+23 diese Woche', to: '/stories' },
  { label: 'Akteure', value: '2.156', icon: GitBranch, change: '+84 diese Woche', to: '/entities' },
  { label: 'Offene Prüfungen', value: '14', icon: AlertCircle, change: '3 markiert', highlight: true, to: '/sources/1/review/1' },
];

const activityIcons: Record<string, React.ElementType> = {
  'Bericht freigegeben': CheckCircle,
  'Akteur bestätigt': CheckCircle,
  'Quelle hochgeladen': Upload,
  'Zusammenführung': Layers,
  'Board aktualisiert': Layers,
  'Bericht markiert': Flag,
};

function getStoryTitle(id: string): string {
  return stories.find(s => s.id === id)?.title ?? id;
}

export default function Dashboard() {
  return (
    <div className="p-6 space-y-6">
      {/* Stats Row — each card is a link */}
      <div className="grid grid-cols-4 gap-4">
        {stats.map((stat) => (
          <Link
            key={stat.label}
            to={stat.to}
            className={`rounded-[var(--radius)] border bg-card p-4 shadow-hard no-underline transition-transform hover:translate-y-[-1px] ${
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
          </Link>
        ))}
      </div>

      {/* Queue + Quick Actions — compact row */}
      <div className="flex gap-4 items-start">
        {/* Processing Queue */}
        <div className="flex-1 rounded-[var(--radius)] border bg-card">
          <div className="flex items-center justify-between border-b px-4 py-2.5">
            <h2 className="text-sm font-semibold">Verarbeitungs-Warteschlange</h2>
            <span className="font-mono text-xs text-muted-foreground">{processingQueue.length} Einträge</span>
          </div>
          <div className="divide-y">
            {processingQueue.map((item) => {
              const activeIdx = item.steps.indexOf(item.step);
              return (
                <div key={item.id} className="px-4 py-2 flex items-center gap-4">
                  <span className="text-xs font-medium shrink-0 min-w-[180px]">{item.title}</span>
                  <div className="flex items-center gap-1 flex-1">
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
                  <span className="font-mono text-xs text-muted-foreground shrink-0 w-14 text-right">
                    {item.progress > 0 ? `${item.progress}%` : 'Wartend'}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Quick Actions */}
        <div className="flex gap-3 shrink-0">
          <Link
            to="/upload"
            className="flex items-center gap-2 rounded-[var(--radius)] border border-primary bg-primary px-4 py-2.5 text-xs font-semibold text-primary-foreground shadow-hard-sm no-underline hover:opacity-90"
          >
            <Upload size={14} />
            Quelle hochladen
          </Link>
          <Link
            to="/sources/1/review/1"
            className="flex items-center gap-2 rounded-[var(--radius)] border bg-card px-4 py-2.5 text-xs font-semibold text-foreground shadow-hard-sm no-underline hover:bg-muted/50"
          >
            <Eye size={14} />
            Prüfung starten
            <span className="flex h-5 min-w-[20px] items-center justify-center rounded-full bg-[#fef3c7] px-1.5 font-mono text-[10px] font-bold text-[#92400e] dark:bg-amber-900/50 dark:text-amber-400">
              14
            </span>
          </Link>
        </div>
      </div>

      {/* KI-Entdeckungen — full width, 3-column grid */}
      <div className="rounded-[var(--radius)] border bg-card">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div className="flex items-center gap-2">
            <Sparkles size={14} className="text-accent dark:text-accent" />
            <h2 className="text-sm font-semibold">KI-Entdeckungen</h2>
          </div>
          <span className="font-mono text-xs text-muted-foreground">{discoveries.length} neu</span>
        </div>
        <div className="grid grid-cols-3 divide-x">
          {discoveries.map((d) => (
            <div key={d.id} className="px-4 py-3 space-y-2">
              <p className="text-xs leading-relaxed text-foreground">{d.description}</p>
              <div className="flex items-center gap-1.5 flex-wrap">
                {d.entities.slice(0, 3).map((e) => (
                  <EntityBadge key={e.id} type={e.type} name={e.name} href={'/entities/' + e.id} size="xs" />
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

      {/* Semantische Muster + Letzte Aktivität */}
      <div className="grid grid-cols-[1fr_340px] gap-6">
      <div className="rounded-[var(--radius)] border bg-card relative overflow-hidden">
          {/* Subtle AI-powered indicator: top border accent */}
          <div className="absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r from-primary/60 via-primary/20 to-primary/60" />
          <div className="flex items-center justify-between border-b px-4 py-3">
            <div className="flex items-center gap-2">
              <Radar size={14} className="text-primary" />
              <h2 className="text-sm font-semibold">Semantische Muster</h2>
              <span className="font-mono text-[10px] px-1.5 py-0.5 rounded-[var(--radius)] border border-primary/30 bg-primary/5 text-primary">
                pgvector
              </span>
            </div>
            <span className="font-mono text-xs text-muted-foreground">{semanticPatterns.length} erkannt</span>
          </div>
          <div className="divide-y">
            {semanticPatterns.map((pattern) => (
              <div key={pattern.id} className="px-4 py-3 space-y-2">
                {/* Header: label + similarity + story count */}
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-foreground">{pattern.label}</span>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[10px] text-muted-foreground">
                      {pattern.storyIds.length} Berichte
                    </span>
                    <span className="font-mono text-[10px] px-1.5 py-0.5 rounded-[var(--radius)] border border-primary/30 bg-primary/5 text-primary">
                      {Math.round(pattern.vectorSimilarity * 100)}% Vektor
                    </span>
                  </div>
                </div>
                <p className="text-[11px] text-muted-foreground leading-relaxed">{pattern.description}</p>

                {/* Keyword groups per story — the core visual */}
                <div className="space-y-0">
                  {pattern.keywords.map((kwGroup, i) => (
                    <div key={i}>
                      <div className="flex items-start gap-2 py-1">
                        <Link
                          to={`/stories/${pattern.storyIds[i]}`}
                          className="font-mono text-[10px] text-muted-foreground shrink-0 mt-0.5 hover:text-primary no-underline"
                        >
                          {pattern.storyIds[i]}
                        </Link>
                        <div className="flex items-center gap-1 flex-wrap">
                          {kwGroup.map((kw) => (
                            <span
                              key={kw}
                              className="font-mono text-[10px] px-1.5 py-0.5 rounded-[var(--radius)] border bg-muted/50 text-foreground"
                            >
                              {kw}
                            </span>
                          ))}
                        </div>
                      </div>
                      {/* Connecting line between story groups */}
                      {i < pattern.keywords.length - 1 && (
                        <div className="flex items-center gap-1.5 pl-7 py-0.5">
                          <div className="h-px flex-1 bg-gradient-to-r from-primary/30 via-primary/10 to-transparent" />
                          <span className="font-mono text-[9px] text-primary/50 shrink-0">semantisch verbunden</span>
                          <div className="h-px flex-1 bg-gradient-to-l from-primary/30 via-primary/10 to-transparent" />
                        </div>
                      )}
                    </div>
                  ))}
                </div>

                {/* Story titles as subtle links */}
                <div className="flex items-center gap-1.5 flex-wrap pt-1">
                  {pattern.storyIds.map((sid, i) => (
                    <span key={sid} className="flex items-center gap-1">
                      {i > 0 && <span className="text-muted-foreground/40 text-[10px]">+</span>}
                      <Link
                        to={`/stories/${sid}`}
                        className="text-[10px] text-muted-foreground hover:text-primary no-underline truncate max-w-[200px]"
                        title={getStoryTitle(sid)}
                      >
                        {getStoryTitle(sid)}
                      </Link>
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
      </div>

      {/* Letzte Aktivität */}
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
    </div>
  );
}
