import { Link } from 'react-router-dom';
import { Upload, Search, FileText, SlidersHorizontal } from 'lucide-react';
import StatusBadge from '../components/StatusBadge';
import { sources } from '../data/mock';

const allSources = [
  ...sources,
  { id: 'src6', title: 'Stern Investigativ', issue: '08/2023', pages: 52, status: 'processed' as const, stories: 6, uploadDate: '2024-01-10' },
  { id: 'src7', title: 'Die ZEIT', issue: '38/2023', pages: 44, status: 'processed' as const, stories: 4, uploadDate: '2024-01-05' },
  { id: 'src8', title: 'Panorama Transcript', issue: 'Nov 2023', pages: 18, status: 'processed' as const, stories: 2, uploadDate: '2023-12-20' },
  { id: 'src9', title: 'EU Parliament Report', issue: 'Q3/2023', pages: 128, status: 'processed' as const, stories: 11, uploadDate: '2023-12-15' },
  { id: 'src10', title: 'BaFin Internal Memo', issue: '2023-09', pages: 8, status: 'error' as const, stories: 0, uploadDate: '2024-02-05' },
  { id: 'src11', title: 'Reuters Wire Archive', issue: 'Oct 2023', pages: 36, status: 'processed' as const, stories: 8, uploadDate: '2024-01-22' },
  { id: 'src12', title: 'Le Monde Diplomatique', issue: '11/2023', pages: 48, status: 'processed' as const, stories: 5, uploadDate: '2024-01-25' },
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

export default function SourceLibrary() {
  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Sources</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            <span className="font-mono font-medium text-foreground">{allSources.length}</span> documents uploaded ·{' '}
            <span className="font-mono font-medium text-foreground">{allSources.filter(s => s.status === 'processed').length}</span> processed
          </p>
        </div>
        <Link
          to="/upload"
          className="flex items-center gap-1.5 rounded-[var(--radius)] border border-primary bg-primary px-4 py-2 text-xs font-medium text-primary-foreground shadow-hard-sm no-underline"
        >
          <Upload size={14} /> Upload Source
        </Link>
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-md">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search sources..."
            className="w-full rounded-[var(--radius)] border bg-card py-2 pl-9 pr-3 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
        <div className="flex items-center gap-1 rounded-[var(--radius)] border bg-card p-0.5">
          <button className="rounded px-2.5 py-1 text-[11px] font-medium bg-primary/10 text-primary">All</button>
          <button className="rounded px-2.5 py-1 text-[11px] text-muted-foreground hover:bg-muted">Processed</button>
          <button className="rounded px-2.5 py-1 text-[11px] text-muted-foreground hover:bg-muted">Processing</button>
          <button className="rounded px-2.5 py-1 text-[11px] text-muted-foreground hover:bg-muted">Error</button>
        </div>
        <button className="flex items-center gap-1.5 rounded-[var(--radius)] border px-3 py-2 text-xs text-muted-foreground hover:bg-secondary">
          <SlidersHorizontal size={12} /> Filters
        </button>
      </div>

      {/* Source Grid */}
      <div className="grid grid-cols-4 gap-4">
        {allSources.map((source, i) => (
          <Link
            key={source.id}
            to={source.status === 'processed' ? `/sources/${source.id === 'src1' ? '1' : source.id}` : '#'}
            className={`group rounded-[var(--radius)] border bg-card no-underline transition-all hover:shadow-hard ${
              source.status === 'error' ? 'opacity-70' : ''
            }`}
          >
            {/* Cover thumbnail */}
            <div className={`relative h-36 rounded-t-[var(--radius)] bg-gradient-to-br ${coverColors[i % coverColors.length]} overflow-hidden`}>
              {/* Simulated magazine cover */}
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
              {/* Status overlay for non-processed */}
              {source.status === 'processing' && (
                <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
                  <div className="rounded bg-black/60 px-3 py-1.5 text-[11px] font-medium text-white">Processing...</div>
                </div>
              )}
              {source.status === 'queued' && (
                <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
                  <div className="rounded bg-black/60 px-3 py-1.5 text-[11px] font-medium text-white">Queued</div>
                </div>
              )}
              {source.status === 'error' && (
                <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
                  <div className="rounded bg-red-600/80 px-3 py-1.5 text-[11px] font-medium text-white">Error</div>
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
                  <span>{source.stories > 0 ? `${source.stories} stories` : 'No stories'}</span>
                </div>
                <span className="font-mono">{source.pages} pages</span>
              </div>
              <div className="mt-1 font-mono text-[9px] text-muted-foreground/60">
                Uploaded {source.uploadDate}
              </div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
