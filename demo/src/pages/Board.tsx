import { useState } from 'react';
import { Search, Sparkles, Share2, Download, StickyNote, MessageSquare } from 'lucide-react';
import EntityBadge from '../components/EntityBadge';
import type { EntityType } from '../data/mock';

interface BoardCard {
  id: string;
  type: 'story' | 'entity' | 'note';
  x: number;
  y: number;
  title: string;
  content?: string;
  source?: string;
  entityType?: EntityType;
  entities?: { name: string; type: EntityType }[];
  connections?: number;
}

interface Connection {
  from: string;
  to: string;
  label?: string;
  style?: 'solid' | 'dashed';
}

const cards: BoardCard[] = [
  {
    id: 'bc1', type: 'story', x: 60, y: 40,
    title: 'Shadow Networks in European Banking',
    content: 'A complex web of shell companies spanning Hamburg, Zürich, and Luxembourg has been quietly funneling billions...',
    source: 'Der Spiegel 42/2023',
    entities: [{ name: 'Dr. Elena Richter', type: 'person' }, { name: 'Meridian Capital', type: 'organization' }],
  },
  {
    id: 'bc2', type: 'story', x: 480, y: 20,
    title: 'The Hamburg Connection',
    content: 'Marcus Webb, the British financial analyst who first raised concerns about Meridian operations in Hamburg...',
    source: 'Der Spiegel 42/2023',
    entities: [{ name: 'Marcus Webb', type: 'person' }, { name: 'Hamburg', type: 'location' }],
  },
  {
    id: 'bc3', type: 'entity', x: 320, y: 280,
    title: 'Meridian Capital Group',
    entityType: 'organization',
    connections: 15,
  },
  {
    id: 'bc4', type: 'story', x: 60, y: 340,
    title: 'Following the Money: Cyprus to Luxembourg',
    content: 'The transaction records reveal a clear pattern: funds entered through Cyprus, cleaned in Luxembourg...',
    source: 'SZ Dossier',
    entities: [{ name: 'Cyprus', type: 'location' }, { name: 'Luxembourg', type: 'location' }],
  },
  {
    id: 'bc5', type: 'note', x: 730, y: 250,
    title: 'Key Question',
    content: 'What is Viktor Dragan\'s exact role? The Cyprus connection suggests he orchestrates the layering stage. Need to cross-reference with FinCEN data.',
  },
  {
    id: 'bc6', type: 'entity', x: 520, y: 400,
    title: 'Viktor Dragan',
    entityType: 'person',
    connections: 6,
  },
  {
    id: 'bc7', type: 'story', x: 730, y: 60,
    title: 'Senate Hearing That Changed Everything',
    content: 'When Dr. Richter took the stand, her testimony implicated not just Meridian but a network of enablers...',
    source: 'ZEIT Investigation',
    entities: [{ name: 'Senate Hearing 2023', type: 'event' }, { name: 'Dr. Elena Richter', type: 'person' }],
  },
  {
    id: 'bc8', type: 'note', x: 340, y: 500,
    title: 'Timeline Gap',
    content: 'Between the Meridian Audit (Q2 2022) and the Senate Hearing (Oct 2023) — 16 months unaccounted for. What happened in this period?',
  },
];

const connections: Connection[] = [
  { from: 'bc1', to: 'bc3', label: 'mentions' },
  { from: 'bc2', to: 'bc3', label: 'exposes' },
  { from: 'bc4', to: 'bc3', label: 'traces funds to' },
  { from: 'bc3', to: 'bc6', label: 'linked to' },
  { from: 'bc5', to: 'bc6', style: 'dashed' },
  { from: 'bc7', to: 'bc1', label: 'confirms' },
  { from: 'bc8', to: 'bc6', style: 'dashed' },
  { from: 'bc8', to: 'bc4', style: 'dashed' },
];

function getCardCenter(card: BoardCard): { x: number; y: number } {
  const w = card.type === 'note' ? 220 : card.type === 'entity' ? 180 : 280;
  const h = card.type === 'note' ? 120 : card.type === 'entity' ? 80 : 160;
  return { x: card.x + w / 2, y: card.y + h / 2 };
}

export default function Board() {
  const [selectedCard, setSelectedCard] = useState<string | null>(null);

  return (
    <div className="flex flex-col h-[calc(100vh-48px)]">
      {/* Board Toolbar */}
      <div className="border-b px-4 py-2 flex items-center justify-between bg-card">
        <div className="flex items-center gap-3">
          <h1 className="text-sm font-semibold">Operation Sunrise — Investigation Links</h1>
          <span className="rounded-[var(--radius)] bg-muted px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
            8 cards · 8 connections
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button className="flex items-center gap-1.5 rounded-[var(--radius)] border px-3 py-1.5 text-xs text-muted-foreground hover:bg-secondary">
            <Search size={12} /> Find Stories
          </button>
          <button className="flex items-center gap-1.5 rounded-[var(--radius)] border px-3 py-1.5 text-xs text-muted-foreground hover:bg-secondary">
            <StickyNote size={12} /> Add Note
          </button>
          <button className="flex items-center gap-1.5 rounded-[var(--radius)] border bg-accent/20 px-3 py-1.5 text-xs hover:bg-accent/30">
            <Sparkles size={12} /> AI Suggestions
          </button>
          <div className="h-4 border-l" />
          <button className="flex items-center gap-1.5 rounded-[var(--radius)] border px-3 py-1.5 text-xs text-muted-foreground hover:bg-secondary">
            <Share2 size={12} /> Share
          </button>
          <button className="flex items-center gap-1.5 rounded-[var(--radius)] border px-3 py-1.5 text-xs text-muted-foreground hover:bg-secondary">
            <Download size={12} /> Export
          </button>
        </div>
      </div>

      {/* Canvas */}
      <div className="flex-1 relative overflow-auto" style={{
        backgroundImage: 'radial-gradient(circle, hsl(var(--border)) 1px, transparent 1px)',
        backgroundSize: '20px 20px',
      }}>
        {/* SVG Connection Lines */}
        <svg className="absolute inset-0 w-full h-full pointer-events-none" style={{ minWidth: '1200px', minHeight: '700px' }}>
          {connections.map((conn) => {
            const from = cards.find(c => c.id === conn.from)!;
            const to = cards.find(c => c.id === conn.to)!;
            const start = getCardCenter(from);
            const end = getCardCenter(to);
            const midX = (start.x + end.x) / 2;
            const midY = (start.y + end.y) / 2;
            return (
              <g key={`${conn.from}-${conn.to}`}>
                <line
                  x1={start.x} y1={start.y}
                  x2={end.x} y2={end.y}
                  stroke="hsl(var(--muted-foreground) / 0.25)"
                  strokeWidth={conn.style === 'dashed' ? 1 : 1.5}
                  strokeDasharray={conn.style === 'dashed' ? '4 4' : undefined}
                />
                {conn.label && (
                  <text
                    x={midX} y={midY - 6}
                    textAnchor="middle"
                    className="fill-muted-foreground"
                    style={{ fontSize: '9px', fontFamily: "'JetBrains Mono', monospace" }}
                  >
                    {conn.label}
                  </text>
                )}
              </g>
            );
          })}
        </svg>

        {/* Cards */}
        <div className="relative" style={{ minWidth: '1200px', minHeight: '700px' }}>
          {cards.map((card) => (
            <div
              key={card.id}
              className={`absolute cursor-pointer transition-shadow ${
                selectedCard === card.id ? 'ring-2 ring-primary' : ''
              }`}
              style={{ left: card.x, top: card.y }}
              onClick={() => setSelectedCard(selectedCard === card.id ? null : card.id)}
            >
              {card.type === 'story' && (
                <div className="w-[280px] rounded-[var(--radius)] border bg-card shadow-hard-sm hover:shadow-hard transition-shadow">
                  <div className="border-b px-3 py-2 flex items-center justify-between">
                    <span className="text-xs font-semibold truncate pr-2">{card.title}</span>
                    <MessageSquare size={10} className="text-muted-foreground shrink-0" />
                  </div>
                  <div className="px-3 py-2">
                    <p className="text-[11px] leading-relaxed text-muted-foreground line-clamp-3">{card.content}</p>
                    <div className="mt-2 flex items-center gap-1 flex-wrap">
                      {card.entities?.map((e, i) => (
                        <EntityBadge key={i} type={e.type} name={e.name} size="xs" />
                      ))}
                    </div>
                  </div>
                  <div className="border-t px-3 py-1.5 font-mono text-[9px] text-muted-foreground">
                    {card.source}
                  </div>
                </div>
              )}

              {card.type === 'entity' && (
                <div className="w-[180px] rounded-[var(--radius)] border bg-card shadow-hard-sm hover:shadow-hard transition-shadow">
                  <div className="p-3">
                    <EntityBadge type={card.entityType!} name={card.title} size="sm" />
                    <div className="mt-2 font-mono text-[10px] text-muted-foreground">
                      {card.connections} connections
                    </div>
                  </div>
                </div>
              )}

              {card.type === 'note' && (
                <div className="w-[220px] rounded-[var(--radius)] border-2 border-dashed border-accent bg-accent/10 shadow-hard-sm hover:shadow-hard transition-shadow">
                  <div className="px-3 py-2 flex items-center gap-1.5 border-b border-dashed border-accent/30">
                    <StickyNote size={10} className="text-accent-foreground/60" />
                    <span className="text-[11px] font-semibold text-accent-foreground">{card.title}</span>
                  </div>
                  <div className="px-3 py-2">
                    <p className="text-[11px] leading-relaxed text-accent-foreground/80 font-mono">{card.content}</p>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
