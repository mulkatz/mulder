import { Link } from 'react-router-dom';
import { Search, SlidersHorizontal, ArrowUpDown } from 'lucide-react';
import EntityBadge from '../components/EntityBadge';
import ConfidenceBadge from '../components/ConfidenceBadge';
import StatusBadge from '../components/StatusBadge';
import { stories, entityTypeLabels } from '../data/mock';
import type { EntityType } from '../data/mock';

const categories = ['All', 'Investigation', 'Profile', 'Deep Dive', 'Analysis', 'Report'];
const types: EntityType[] = ['person', 'organization', 'event', 'location'];

export default function Stories() {
  return (
    <div className="flex h-[calc(100vh-48px)]">
      {/* Left Sidebar — Facet Filters */}
      <div className="w-56 border-r bg-card overflow-y-auto p-4 space-y-5">
        <div className="flex items-center gap-1.5">
          <SlidersHorizontal size={14} className="text-muted-foreground" />
          <h3 className="text-xs font-semibold">Filters</h3>
        </div>

        {/* Categories */}
        <div>
          <h4 className="mb-2 font-mono text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Category</h4>
          <div className="space-y-1">
            {categories.map((cat, i) => (
              <label key={cat} className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" defaultChecked={i === 0} className="rounded border" />
                <span className="text-xs">{cat}</span>
              </label>
            ))}
          </div>
        </div>

        {/* Entity Types */}
        <div>
          <h4 className="mb-2 font-mono text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Entity Type</h4>
          <div className="space-y-1">
            {types.map(type => (
              <label key={type} className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" defaultChecked className="rounded border" />
                <span className="text-xs">{entityTypeLabels[type]}</span>
              </label>
            ))}
          </div>
        </div>

        {/* Review Status */}
        <div>
          <h4 className="mb-2 font-mono text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Review Status</h4>
          <div className="space-y-1">
            {['Approved', 'Needs Review', 'Flagged'].map(status => (
              <label key={status} className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" defaultChecked className="rounded border" />
                <span className="text-xs">{status}</span>
              </label>
            ))}
          </div>
        </div>

        {/* Confidence Range */}
        <div>
          <h4 className="mb-2 font-mono text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Confidence</h4>
          <input type="range" min="0" max="100" defaultValue="0" className="w-full" />
          <div className="flex justify-between mt-1">
            <span className="font-mono text-[10px] text-muted-foreground">0%</span>
            <span className="font-mono text-[10px] text-muted-foreground">100%</span>
          </div>
        </div>

        {/* Source */}
        <div>
          <h4 className="mb-2 font-mono text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Source</h4>
          <div className="space-y-1">
            {['Der Spiegel', 'ZEIT Investigation', 'SZ Dossier'].map(src => (
              <label key={src} className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" defaultChecked className="rounded border" />
                <span className="text-xs">{src}</span>
              </label>
            ))}
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 overflow-y-auto">
        {/* Search Bar */}
        <div className="sticky top-0 z-10 border-b bg-card/95 backdrop-blur-sm px-6 py-4">
          <div className="relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              placeholder="Search stories — try natural language like &quot;financial transactions through shell companies&quot;"
              className="w-full rounded-[var(--radius)] border bg-background py-2.5 pl-10 pr-4 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary"
            />
          </div>
          <div className="mt-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Showing <span className="font-mono font-medium text-foreground">{stories.length}</span> stories</span>
            </div>
            <button className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
              <ArrowUpDown size={12} /> Sort by Relevance
            </button>
          </div>
        </div>

        {/* Story List */}
        <div className="divide-y">
          {stories.map((story) => (
            <Link
              key={story.id}
              to={`/stories/${story.id}`}
              className="block px-6 py-4 hover:bg-muted/30 transition-colors no-underline"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <h3 className="text-sm font-semibold text-foreground">{story.title}</h3>
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground shrink-0">
                      {story.category}
                    </span>
                  </div>
                  <p className="text-xs leading-relaxed text-muted-foreground line-clamp-2">{story.excerpt}</p>
                  <div className="mt-2 flex items-center gap-2 flex-wrap">
                    {story.entities.slice(0, 4).map((e) => (
                      <EntityBadge key={e.id} type={e.type} name={e.name} size="xs" />
                    ))}
                    {story.entities.length > 4 && (
                      <span className="text-[10px] text-muted-foreground">+{story.entities.length - 4}</span>
                    )}
                  </div>
                </div>
                <div className="flex flex-col items-end gap-1.5 shrink-0">
                  <ConfidenceBadge value={story.confidence} />
                  <StatusBadge status={story.reviewStatus} />
                  <span className="font-mono text-[10px] text-muted-foreground">{story.source}</span>
                  <span className="font-mono text-[10px] text-muted-foreground">pp. {story.pages}</span>
                </div>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
