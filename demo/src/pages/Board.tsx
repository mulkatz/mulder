import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Search, Sparkles, Share2, Download, StickyNote, MessageSquare, ExternalLink } from 'lucide-react';
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
  linkedId?: string; // story ID or entity ID for navigation
}

interface Connection {
  from: string;
  to: string;
  label?: string;
  style?: 'solid' | 'dashed';
}

const cards: BoardCard[] = [
  {
    id: 'bc1', type: 'story', x: 60, y: 40, linkedId: 's1',
    title: 'Das Tic-Tac-Objekt über dem Pazifik',
    content: 'Commander Fravor beobachtete ein weißes, ovales Objekt ohne sichtbare Antriebssysteme. Es beschleunigte auf geschätzte 46.000 km/h...',
    source: 'MUFON UFO Journal 03/2017',
    entities: [{ name: 'David Fravor', type: 'person' }, { name: 'US Navy', type: 'organization' }],
  },
  {
    id: 'bc2', type: 'story', x: 480, y: 20, linkedId: 's5',
    title: 'Pentagons geheimes UFO-Programm',
    content: 'Von 2007 bis 2012 betrieb das Pentagon mit $22 Mio. Budget das AATIP. Elizondo trat 2017 aus Protest zurück...',
    source: 'Der Spiegel 47/2017',
    entities: [{ name: 'Luis Elizondo', type: 'person' }, { name: 'AATIP', type: 'organization' }],
  },
  {
    id: 'bc3', type: 'entity', x: 320, y: 280, linkedId: 'e14',
    title: 'Pentagon',
    entityType: 'organization',
    connections: 16,
  },
  {
    id: 'bc4', type: 'story', x: 60, y: 340, linkedId: 's8',
    title: 'David Gruschs Aussage vor dem Kongress',
    content: 'Grusch sagte unter Eid aus, die US-Regierung verfüge über ein Bergungsprogramm für nicht-menschliche Fahrzeuge...',
    source: 'Congressional Record Juli 2023',
    entities: [{ name: 'David Grusch', type: 'person' }, { name: 'Washington D.C.', type: 'location' }],
  },
  {
    id: 'bc5', type: 'note', x: 730, y: 250,
    title: 'Kernfrage',
    content: 'Warum bestätigte das Pentagon Elizondos Rolle bei AATIP zunächst, revidierte die Aussage dann aber? Abgleich mit Reids Brief an NBC nötig.',
  },
  {
    id: 'bc6', type: 'entity', x: 520, y: 400, linkedId: 'e3',
    title: 'Luis Elizondo',
    entityType: 'person',
    connections: 14,
  },
  {
    id: 'bc7', type: 'story', x: 730, y: 60, linkedId: 's12',
    title: 'AARO vs. die Whistleblower',
    content: 'Kirkpatricks AARO fand „keine empirischen Beweise" für außerirdische Technologie. Grusch spricht von Vertuschung...',
    source: 'FAZ Wochenendbeilage Jan 2024',
    entities: [{ name: 'Sean Kirkpatrick', type: 'person' }, { name: 'AARO', type: 'organization' }],
  },
  {
    id: 'bc8', type: 'note', x: 340, y: 500,
    title: 'Zeitlücke',
    content: 'Zwischen AATIP-Einstellung (2012) und NYT-Enthüllung (Dez 2017) — 5 Jahre. Hat Elizondo das Programm inoffiziell weitergeführt, wie er behauptet?',
  },
];

const connections: Connection[] = [
  { from: 'bc1', to: 'bc3', label: 'erwähnt' },
  { from: 'bc2', to: 'bc3', label: 'enthüllt' },
  { from: 'bc4', to: 'bc3', label: 'beschuldigt' },
  { from: 'bc3', to: 'bc6', label: 'verknüpft' },
  { from: 'bc5', to: 'bc6', style: 'dashed' },
  { from: 'bc7', to: 'bc4', label: 'widerspricht' },
  { from: 'bc8', to: 'bc6', style: 'dashed' },
  { from: 'bc8', to: 'bc2', style: 'dashed' },
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
          <h1 className="text-sm font-semibold">UAP-Chronologie — Verbindungen</h1>
          <span className="rounded-[var(--radius)] bg-muted px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
            8 Karten · 8 Verbindungen
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button className="flex items-center gap-1.5 rounded-[var(--radius)] border px-3 py-1.5 text-xs text-muted-foreground hover:bg-secondary">
            <Search size={12} /> Berichte suchen
          </button>
          <button className="flex items-center gap-1.5 rounded-[var(--radius)] border px-3 py-1.5 text-xs text-muted-foreground hover:bg-secondary">
            <StickyNote size={12} /> Notiz
          </button>
          <button className="flex items-center gap-1.5 rounded-[var(--radius)] border bg-accent/20 px-3 py-1.5 text-xs hover:bg-accent/30">
            <Sparkles size={12} /> KI-Vorschläge
          </button>
          <div className="h-4 border-l" />
          <button className="flex items-center gap-1.5 rounded-[var(--radius)] border px-3 py-1.5 text-xs text-muted-foreground hover:bg-secondary">
            <Share2 size={12} /> Teilen
          </button>
          <button className="flex items-center gap-1.5 rounded-[var(--radius)] border px-3 py-1.5 text-xs text-muted-foreground hover:bg-secondary">
            <Download size={12} /> Exportieren
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
                  <div className="border-t px-3 py-1.5 flex items-center justify-between">
                    <span className="font-mono text-[9px] text-muted-foreground">{card.source}</span>
                    {card.linkedId && (
                      <Link
                        to={`/stories/${card.linkedId}`}
                        className="flex items-center gap-1 text-[9px] text-primary no-underline hover:underline"
                        onClick={e => e.stopPropagation()}
                      >
                        <ExternalLink size={8} /> Bericht
                      </Link>
                    )}
                  </div>
                </div>
              )}

              {card.type === 'entity' && (
                <div className="w-[180px] rounded-[var(--radius)] border bg-card shadow-hard-sm hover:shadow-hard transition-shadow">
                  <div className="p-3">
                    <EntityBadge type={card.entityType!} name={card.title} href={card.linkedId ? `/entities/${card.linkedId}` : undefined} size="sm" />
                    <div className="mt-2 font-mono text-[10px] text-muted-foreground">
                      {card.connections} Verbindungen
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
