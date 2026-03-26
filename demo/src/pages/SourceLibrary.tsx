import { useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Upload, Search, FileText, SlidersHorizontal, LayoutGrid, List, ArrowUpDown, ChevronUp, ChevronDown } from 'lucide-react';
import StatusBadge from '../components/StatusBadge';
import { sources, type Source } from '../data/mock';

const allSources = [
  ...sources,
  { id: 'src9', title: 'Ancient Aliens Magazin', issue: '15/2023', pages: 44, status: 'processed' as const, stories: 1, uploadDate: '2024-09-15' },
  { id: 'src10', title: 'Bild der Wissenschaft', issue: '02/2018', pages: 52, status: 'processed' as const, stories: 1, uploadDate: '2024-09-18' },
  { id: 'src11', title: 'FAZ Wochenendbeilage', issue: 'Jan 2024', pages: 40, status: 'processed' as const, stories: 1, uploadDate: '2024-09-25' },
  { id: 'src12', title: 'Magazin 2000', issue: 'Ausgabe 395', pages: 68, status: 'processed' as const, stories: 2, uploadDate: '2024-08-28' },
  { id: 'src13', title: 'Navy Times', issue: 'Nov 2004', pages: 32, status: 'error' as const, stories: 0, uploadDate: '2024-10-08' },
  { id: 'src14', title: 'Stern', issue: '48/2017', pages: 76, status: 'processed' as const, stories: 3, uploadDate: '2024-08-12' },
  { id: 'src15', title: 'New York Times (Reprint)', issue: 'Dez 2017', pages: 24, status: 'processed' as const, stories: 1, uploadDate: '2024-09-20' },
];

const coverColors = [
  'from-red-600 to-red-800',
  'from-blue-600 to-blue-800',
  'from-amber-500 to-amber-700',
  'from-emerald-600 to-emerald-800',
  'from-gray-500 to-gray-700',
  'from-indigo-600 to-indigo-800',
  'from-teal-600 to-teal-800',
  'from-orange-500 to-orange-700',
  'from-violet-600 to-violet-800',
  'from-rose-600 to-rose-800',
  'from-cyan-600 to-cyan-800',
  'from-fuchsia-600 to-fuchsia-800',
];

type SortField = 'title' | 'issue' | 'pages' | 'stories' | 'status' | 'uploadDate';

const statusOrder: Record<Source['status'], number> = {
  error: 0,
  queued: 1,
  processing: 2,
  processed: 3,
};

const statusFilters: { label: string; value: Source['status'] | 'all' }[] = [
  { label: 'Alle', value: 'all' },
  { label: 'Verarbeitet', value: 'processed' },
  { label: 'In Bearbeitung', value: 'processing' },
  { label: 'Fehler', value: 'error' },
];

function compareSources(a: Source, b: Source, field: SortField): number {
  switch (field) {
    case 'pages':
    case 'stories':
      return a[field] - b[field];
    case 'status':
      return statusOrder[a.status] - statusOrder[b.status];
    case 'title':
    case 'issue':
    case 'uploadDate':
      return a[field].localeCompare(b[field]);
  }
}

function sourceHref(source: Source): string {
  if (source.status !== 'processed') return '#';
  return `/sources/${source.id === 'src1' ? '1' : source.id}`;
}

// --- Table internals ---

const columns: { field: SortField; label: string; className: string; align?: 'right' }[] = [
  { field: 'title', label: 'Titel', className: 'flex-1 min-w-0' },
  { field: 'issue', label: 'Ausgabe', className: 'w-28' },
  { field: 'pages', label: 'Seiten', className: 'w-16', align: 'right' },
  { field: 'stories', label: 'Berichte', className: 'w-20', align: 'right' },
  { field: 'status', label: 'Status', className: 'w-24' },
  { field: 'uploadDate', label: 'Hochgeladen', className: 'w-28', align: 'right' },
];

function SortIcon({ field, sortBy, sortAsc }: { field: SortField; sortBy: SortField; sortAsc: boolean }) {
  if (field !== sortBy) return <ArrowUpDown size={10} className="text-muted-foreground/40 shrink-0" />;
  return sortAsc
    ? <ChevronUp size={10} className="text-primary shrink-0" />
    : <ChevronDown size={10} className="text-primary shrink-0" />;
}

function SourceTable({
  sources: data,
  sortBy,
  sortAsc,
  onSort,
}: {
  sources: Source[];
  sortBy: SortField;
  sortAsc: boolean;
  onSort: (field: SortField) => void;
}) {
  return (
    <div className="rounded-[var(--radius)] border bg-card overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-4 px-4 py-2 border-b bg-muted/30">
        {columns.map(col => (
          <button
            key={col.field}
            onClick={() => onSort(col.field)}
            className={`flex items-center gap-1 font-mono text-[10px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors ${col.className} ${
              col.align === 'right' ? 'justify-end' : ''
            } ${col.field === sortBy ? 'text-foreground' : ''}`}
          >
            {col.label}
            <SortIcon field={col.field} sortBy={sortBy} sortAsc={sortAsc} />
          </button>
        ))}
      </div>

      {/* Rows */}
      <div className="divide-y">
        {data.map(source => (
          <Link
            key={source.id}
            to={sourceHref(source)}
            className={`flex items-center gap-4 px-4 py-2.5 no-underline transition-colors hover:bg-muted/30 ${
              source.status === 'error' ? 'opacity-60' : ''
            }`}
          >
            <div className="flex-1 min-w-0">
              <span className="text-xs font-semibold text-foreground truncate block" title={source.title}>
                {source.title}
              </span>
            </div>
            <div className="w-28 font-mono text-xs text-muted-foreground truncate">
              {source.issue}
            </div>
            <div className="w-16 font-mono text-xs text-muted-foreground text-right">
              {source.pages}
            </div>
            <div className="w-20 font-mono text-xs text-muted-foreground text-right">
              {source.stories > 0 ? source.stories : '\u2014'}
            </div>
            <div className="w-24">
              <StatusBadge status={source.status} />
            </div>
            <div className="w-28 font-mono text-[11px] text-muted-foreground text-right">
              {source.uploadDate}
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}

// --- Main component ---

export default function SourceLibrary() {
  const [view, setView] = useState<'grid' | 'table'>('grid');
  const [sortBy, setSortBy] = useState<SortField>('uploadDate');
  const [sortAsc, setSortAsc] = useState(false);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<Source['status'] | 'all'>('all');

  const filtered = useMemo(() => {
    let result: Source[] = allSources;
    if (statusFilter !== 'all') {
      result = result.filter(s => s.status === statusFilter);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(s =>
        s.title.toLowerCase().includes(q) || s.issue.toLowerCase().includes(q)
      );
    }
    return [...result].sort((a, b) => {
      const diff = compareSources(a, b, sortBy);
      return sortAsc ? diff : -diff;
    });
  }, [statusFilter, search, sortBy, sortAsc]);

  const handleSort = (field: SortField) => {
    if (sortBy === field) {
      setSortAsc(!sortAsc);
    } else {
      setSortBy(field);
      setSortAsc(false);
    }
  };

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Quellen</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            <span className="font-mono font-medium text-foreground">{filtered.length}</span>{' '}
            {filtered.length !== allSources.length ? `von ${allSources.length} ` : ''}Dokumente ·{' '}
            <span className="font-mono font-medium text-foreground">{allSources.filter(s => s.status === 'processed').length}</span> verarbeitet
          </p>
        </div>
        <Link
          to="/upload"
          className="flex items-center gap-1.5 rounded-[var(--radius)] border border-primary bg-primary px-4 py-2 text-xs font-medium text-primary-foreground shadow-hard-sm no-underline"
        >
          <Upload size={14} /> Quelle hochladen
        </Link>
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-md">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            placeholder="Quellen durchsuchen..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full rounded-[var(--radius)] border bg-card py-2 pl-9 pr-3 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
        <div className="flex items-center gap-1 rounded-[var(--radius)] border bg-card p-0.5">
          {statusFilters.map(sf => (
            <button
              key={sf.value}
              onClick={() => setStatusFilter(sf.value)}
              className={`rounded px-2.5 py-1 text-[11px] font-medium transition-colors ${
                statusFilter === sf.value
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:bg-muted'
              }`}
            >
              {sf.label}
            </button>
          ))}
        </div>
        <button className="flex items-center gap-1.5 rounded-[var(--radius)] border px-3 py-2 text-xs text-muted-foreground hover:bg-secondary">
          <SlidersHorizontal size={12} /> Filter
        </button>

        {/* View toggle */}
        <div className="flex items-center gap-1 rounded-[var(--radius)] border bg-card p-0.5">
          <button
            onClick={() => setView('grid')}
            className={`flex items-center justify-center rounded p-1.5 transition-colors ${
              view === 'grid'
                ? 'bg-primary/10 text-primary'
                : 'text-muted-foreground hover:bg-muted'
            }`}
            title="Kachelansicht"
          >
            <LayoutGrid size={14} />
          </button>
          <button
            onClick={() => setView('table')}
            className={`flex items-center justify-center rounded p-1.5 transition-colors ${
              view === 'table'
                ? 'bg-primary/10 text-primary'
                : 'text-muted-foreground hover:bg-muted'
            }`}
            title="Tabellenansicht"
          >
            <List size={14} />
          </button>
        </div>
      </div>

      {/* Content */}
      {view === 'grid' ? (
        <div className="grid grid-cols-4 gap-4">
          {filtered.map((source, i) => (
            <Link
              key={source.id}
              to={sourceHref(source)}
              className={`group rounded-[var(--radius)] border bg-card no-underline transition-all hover:shadow-hard ${
                source.status === 'error' ? 'opacity-70' : ''
              }`}
            >
              {/* Cover thumbnail */}
              <div className={`relative h-36 rounded-t-[var(--radius)] bg-gradient-to-br ${coverColors[i % coverColors.length]} overflow-hidden`}>
                <div className="absolute inset-0 p-4 flex flex-col justify-between">
                  <div>
                    <div className="h-1.5 w-16 rounded bg-white/30 mb-1.5" />
                    <div className="h-2.5 w-28 rounded bg-white/60 mb-1" />
                    <div className="h-2.5 w-20 rounded bg-white/40" />
                  </div>
                  <div className="flex items-end justify-between">
                    <div className="font-mono text-[10px] text-white/50">{source.issue}</div>
                    <div className="font-mono text-[10px] text-white/50">{source.pages}p</div>
                  </div>
                </div>
                {source.status === 'processing' && (
                  <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
                    <div className="rounded bg-black/60 px-3 py-1.5 text-[11px] font-medium text-white">In Bearbeitung...</div>
                  </div>
                )}
                {source.status === 'queued' && (
                  <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
                    <div className="rounded bg-black/60 px-3 py-1.5 text-[11px] font-medium text-white">Wartend</div>
                  </div>
                )}
                {source.status === 'error' && (
                  <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
                    <div className="rounded bg-red-600/80 px-3 py-1.5 text-[11px] font-medium text-white">Fehler</div>
                  </div>
                )}
              </div>

              {/* Info */}
              <div className="p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-xs font-semibold text-foreground truncate group-hover:text-primary transition-colors">
                      {source.title}
                    </div>
                    <div className="font-mono text-[10px] text-muted-foreground mt-0.5">{source.issue}</div>
                  </div>
                  <StatusBadge status={source.status} />
                </div>
                <div className="mt-2 flex items-center justify-between text-[10px] text-muted-foreground">
                  <div className="flex items-center gap-1">
                    <FileText size={10} />
                    <span>{source.stories > 0 ? `${source.stories} Berichte` : 'Keine Berichte'}</span>
                  </div>
                  <span className="font-mono">{source.pages} Seiten</span>
                </div>
                <div className="mt-1 font-mono text-[9px] text-muted-foreground/60">
                  Hochgeladen {source.uploadDate}
                </div>
              </div>
            </Link>
          ))}
        </div>
      ) : (
        <SourceTable sources={filtered} sortBy={sortBy} sortAsc={sortAsc} onSort={handleSort} />
      )}
    </div>
  );
}
