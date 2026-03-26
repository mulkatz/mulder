import { Link, useParams } from 'react-router-dom';
import { ChevronRight, BookOpen, GitBranch, ExternalLink, Kanban, BarChart3, Sparkles } from 'lucide-react';
import EntityBadge from '../components/EntityBadge';
import ConfidenceBadge from '../components/ConfidenceBadge';
import StatusBadge from '../components/StatusBadge';
import { stories, storyFullTexts, getRelatedStories } from '../data/mock';
import type { EntityType } from '../data/mock';

const entityCssMap: Record<EntityType, { bg: string; text: string; border: string }> = {
  person: { bg: 'bg-entity-person-bg', text: 'text-entity-person', border: 'border-entity-person/40' },
  organization: { bg: 'bg-entity-organization-bg', text: 'text-entity-organization', border: 'border-entity-organization/40' },
  event: { bg: 'bg-entity-event-bg', text: 'text-entity-event', border: 'border-entity-event/40' },
  location: { bg: 'bg-entity-location-bg', text: 'text-entity-location', border: 'border-entity-location/40' },
};

function renderHighlightedText(text: string) {
  const parts = text.split(/(<entity-(?:person|organization|event|location)>.*?<\/entity-(?:person|organization|event|location)>)/g);
  return parts.map((part, i) => {
    const match = part.match(/<entity-(person|organization|event|location)>(.*?)<\/entity-/);
    if (match) {
      const type = match[1] as EntityType;
      const name = match[2];
      const css = entityCssMap[type];
      return (
        <Link
          key={i}
          to={`/entities/${name.replace(/\s/g, '-').toLowerCase()}`}
          className={`${css.bg} ${css.text} rounded-sm px-1 py-0.5 font-mono text-[12px] font-medium no-underline hover:opacity-80 border-b-2 ${css.border}`}
        >
          {name}
        </Link>
      );
    }
    return <span key={i}>{part}</span>;
  });
}

export default function StoryDetail() {
  const { id } = useParams();
  const story = stories.find(s => s.id === (id || 's1')) || stories[0];
  const fullText = storyFullTexts[story.id] || storyFullTexts['s1'];
  const related = getRelatedStories(story.id);

  return (
    <div className="flex h-[calc(100vh-48px)]">
      {/* Main content */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-6 py-6">
          {/* Breadcrumb */}
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-4">
            <Link to="/stories" className="hover:text-foreground no-underline text-muted-foreground">Stories</Link>
            <ChevronRight size={12} />
            <span className="text-foreground font-medium truncate">{story.title}</span>
          </div>

          {/* Story header */}
          <div className="mb-6">
            <div className="flex items-center gap-2 mb-2">
              <span className="rounded bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                {story.category}
              </span>
              <ConfidenceBadge value={story.confidence} />
              <StatusBadge status={story.reviewStatus} />
            </div>
            <h1 className="text-2xl font-bold tracking-tight mb-2">{story.title}</h1>
            <div className="flex items-center gap-4 text-xs text-muted-foreground">
              <span className="font-mono">{story.source}</span>
              <span>pp. {story.pages}</span>
              <Link to="/sources/1" className="flex items-center gap-1 text-primary no-underline hover:underline">
                <ExternalLink size={10} /> View Source PDF
              </Link>
            </div>
          </div>

          {/* Entity tags */}
          <div className="mb-6 flex items-center gap-2 flex-wrap">
            <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mr-1">Entities:</span>
            {story.entities.map((e) => (
              <Link key={e.id} to={`/entities/${e.id}`} className="no-underline">
                <EntityBadge type={e.type} name={e.name} size="sm" />
              </Link>
            ))}
          </div>

          {/* Full text with entity highlights */}
          <div className="rounded-[var(--radius)] border bg-card p-6">
            <div className="prose prose-sm max-w-none space-y-4 text-[14px] leading-[1.8]">
              {fullText.split('\n\n').map((paragraph, i) => (
                <p key={i} className="text-foreground">{renderHighlightedText(paragraph)}</p>
              ))}
            </div>
          </div>

          {/* Action bar */}
          <div className="mt-4 flex items-center gap-2">
            <Link
              to="/sources/1/review/1"
              className="flex items-center gap-1.5 rounded-[var(--radius)] border px-3 py-1.5 text-xs text-muted-foreground no-underline hover:bg-secondary"
            >
              <BookOpen size={12} /> Open in Review
            </Link>
            <Link
              to="/graph"
              className="flex items-center gap-1.5 rounded-[var(--radius)] border px-3 py-1.5 text-xs text-muted-foreground no-underline hover:bg-secondary"
            >
              <GitBranch size={12} /> Show in Graph
            </Link>
            <Link
              to="/boards/1"
              className="flex items-center gap-1.5 rounded-[var(--radius)] border px-3 py-1.5 text-xs text-muted-foreground no-underline hover:bg-secondary"
            >
              <Kanban size={12} /> Add to Board
            </Link>
          </div>
        </div>
      </div>

      {/* Right sidebar — Related Stories */}
      <div className="w-[340px] border-l bg-card overflow-y-auto">
        <div className="p-4">
          <div className="flex items-center gap-2 mb-4">
            <Sparkles size={14} className="text-accent dark:text-accent" />
            <h2 className="text-sm font-semibold">Related Stories</h2>
          </div>
          <p className="text-[11px] text-muted-foreground mb-4 leading-relaxed">
            Stories with overlapping entities, similar topics, or matching semantic patterns — found automatically across all documents.
          </p>

          <div className="space-y-3">
            {related.map(({ story: rel, similarity, sharedEntities, reason }) => (
              <Link
                key={rel.id}
                to={`/stories/${rel.id}`}
                className="block rounded-[var(--radius)] border p-3 no-underline transition-colors hover:bg-muted/50 hover:shadow-hard-sm"
              >
                {/* Similarity bar */}
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-1.5">
                    <BarChart3 size={10} className="text-primary" />
                    <span className="font-mono text-[10px] font-bold text-primary">
                      {Math.round(similarity * 100)}% match
                    </span>
                  </div>
                  <span className="text-[10px] text-muted-foreground">{rel.source}</span>
                </div>

                {/* Similarity indicator bar */}
                <div className="h-1 w-full overflow-hidden rounded-full bg-muted mb-2">
                  <div
                    className="h-full rounded-full bg-primary/60"
                    style={{ width: `${similarity * 100}%` }}
                  />
                </div>

                <div className="text-xs font-semibold text-foreground mb-1">{rel.title}</div>
                <p className="text-[11px] text-muted-foreground line-clamp-2 mb-2">{rel.excerpt}</p>

                {/* Shared entities */}
                <div className="flex items-center gap-1 flex-wrap mb-1.5">
                  {sharedEntities.map((e) => (
                    <EntityBadge key={e.id} type={e.type} name={e.name} size="xs" />
                  ))}
                </div>

                {/* Reason */}
                <div className="flex items-center gap-1.5 rounded bg-accent/10 dark:bg-accent/10 px-2 py-1">
                  <Sparkles size={9} className="text-accent-foreground/60 shrink-0" />
                  <span className="font-mono text-[9px] text-accent-foreground/80">{reason}</span>
                </div>
              </Link>
            ))}
          </div>

          {/* Cross-document insight callout */}
          <div className="mt-6 rounded-[var(--radius)] border-2 border-dashed border-accent/40 bg-accent/5 p-3">
            <div className="flex items-center gap-1.5 mb-2">
              <Sparkles size={12} className="text-accent dark:text-accent" />
              <span className="text-[11px] font-semibold text-accent-foreground">Cross-Document Insight</span>
            </div>
            <p className="text-[11px] leading-relaxed text-accent-foreground/80">
              This story shares entities with <span className="font-mono font-bold">{related.length} other stories</span> across{' '}
              <span className="font-mono font-bold">
                {new Set(related.map(r => r.story.source)).size} different sources
              </span>. Overlapping facts suggest a connected narrative.
            </p>
            <Link
              to="/graph"
              className="mt-2 inline-flex items-center gap-1 text-[11px] font-medium text-primary no-underline hover:underline"
            >
              Explore connections in Graph <ChevronRight size={10} />
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
