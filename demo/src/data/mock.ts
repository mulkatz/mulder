export type EntityType = 'person' | 'organization' | 'event' | 'location';

export interface Entity {
  id: string;
  name: string;
  type: EntityType;
  mentions: number;
  connections: number;
  confidence: number;
  status: 'confirmed' | 'suggested';
}

export interface Story {
  id: string;
  title: string;
  source: string;
  pages: string;
  category: string;
  confidence: number;
  reviewStatus: 'approved' | 'needs_review' | 'flagged';
  excerpt: string;
  entities: Entity[];
}

export interface Source {
  id: string;
  title: string;
  issue: string;
  pages: number;
  status: 'processed' | 'processing' | 'queued' | 'error';
  stories: number;
  uploadDate: string;
}

export interface Discovery {
  id: string;
  description: string;
  confidence: number;
  entities: Entity[];
  stories: string[];
}

export const entities: Entity[] = [
  { id: 'e1', name: 'Dr. Elena Richter', type: 'person', mentions: 47, connections: 12, confidence: 0.94, status: 'confirmed' },
  { id: 'e2', name: 'Marcus Webb', type: 'person', mentions: 31, connections: 8, confidence: 0.91, status: 'confirmed' },
  { id: 'e3', name: 'Sarah Chen', type: 'person', mentions: 28, connections: 9, confidence: 0.88, status: 'confirmed' },
  { id: 'e4', name: 'Meridian Capital Group', type: 'organization', mentions: 63, connections: 15, confidence: 0.97, status: 'confirmed' },
  { id: 'e5', name: 'BKA', type: 'organization', mentions: 22, connections: 7, confidence: 0.95, status: 'confirmed' },
  { id: 'e6', name: 'Europol', type: 'organization', mentions: 18, connections: 6, confidence: 0.93, status: 'confirmed' },
  { id: 'e7', name: 'Senate Hearing 2023', type: 'event', mentions: 14, connections: 11, confidence: 0.89, status: 'confirmed' },
  { id: 'e8', name: 'Meridian Audit', type: 'event', mentions: 9, connections: 5, confidence: 0.82, status: 'suggested' },
  { id: 'e9', name: 'Hamburg', type: 'location', mentions: 41, connections: 13, confidence: 0.99, status: 'confirmed' },
  { id: 'e10', name: 'Zürich', type: 'location', mentions: 35, connections: 10, confidence: 0.98, status: 'confirmed' },
  { id: 'e11', name: 'Luxembourg', type: 'location', mentions: 27, connections: 8, confidence: 0.97, status: 'confirmed' },
  { id: 'e12', name: 'Viktor Dragan', type: 'person', mentions: 19, connections: 6, confidence: 0.85, status: 'suggested' },
  { id: 'e13', name: 'FinCEN', type: 'organization', mentions: 15, connections: 5, confidence: 0.92, status: 'confirmed' },
  { id: 'e14', name: 'Whistleblower Meeting', type: 'event', mentions: 7, connections: 4, confidence: 0.76, status: 'suggested' },
  { id: 'e15', name: 'Cyprus', type: 'location', mentions: 12, connections: 4, confidence: 0.90, status: 'confirmed' },
  { id: 'e16', name: 'Deutsche Bank', type: 'organization', mentions: 24, connections: 9, confidence: 0.96, status: 'confirmed' },
  { id: 'e17', name: 'Prof. Hans Müller', type: 'person', mentions: 11, connections: 5, confidence: 0.87, status: 'confirmed' },
  { id: 'e18', name: 'Geneva Summit', type: 'event', mentions: 8, connections: 6, confidence: 0.80, status: 'suggested' },
];

export const stories: Story[] = [
  {
    id: 's1',
    title: 'Shadow Networks in European Banking',
    source: 'Der Spiegel 42/2023',
    pages: '12–18',
    category: 'Investigation',
    confidence: 0.92,
    reviewStatus: 'approved',
    excerpt: 'A complex web of shell companies spanning Hamburg, Zürich, and Luxembourg has been quietly funneling billions through what investigators now call the "Meridian Pipeline." At its center: Dr. Elena Richter, a former Deutsche Bank compliance officer turned whistleblower.',
    entities: [entities[0], entities[3], entities[9], entities[10], entities[15]],
  },
  {
    id: 's2',
    title: 'The Hamburg Connection',
    source: 'Der Spiegel 42/2023',
    pages: '19–23',
    category: 'Profile',
    confidence: 0.87,
    reviewStatus: 'approved',
    excerpt: 'Marcus Webb, the British financial analyst who first raised concerns about Meridian Capital Group\'s operations in Hamburg, describes months of mounting pressure. "They knew I was looking," he says.',
    entities: [entities[1], entities[3], entities[8], entities[4]],
  },
  {
    id: 's3',
    title: 'Whistleblower Protocol Alpha',
    source: 'ZEIT Investigation Special',
    pages: '4–11',
    category: 'Deep Dive',
    confidence: 0.72,
    reviewStatus: 'needs_review',
    excerpt: 'The encrypted documents Sarah Chen received in October painted a devastating picture of systemic fraud. The BKA and Europol launched a joint task force — but internal resistance slowed the investigation.',
    entities: [entities[2], entities[4], entities[5], entities[13]],
  },
  {
    id: 's4',
    title: 'Following the Money: Cyprus to Luxembourg',
    source: 'SZ Dossier: Financial Networks',
    pages: '28–35',
    category: 'Analysis',
    confidence: 0.91,
    reviewStatus: 'approved',
    excerpt: 'The transaction records reveal a clear pattern: funds entered through Cyprus, were cleaned in Luxembourg holding structures, and re-emerged as legitimate investments in Hamburg real estate.',
    entities: [entities[14], entities[10], entities[8], entities[3]],
  },
  {
    id: 's5',
    title: 'The Senate Hearing That Changed Everything',
    source: 'ZEIT Investigation Special',
    pages: '12–16',
    category: 'Report',
    confidence: 0.85,
    reviewStatus: 'approved',
    excerpt: 'When Dr. Richter took the stand at the 2023 Senate hearing, her testimony implicated not just Meridian but a network of enablers across European finance. Viktor Dragan\'s name surfaced for the first time.',
    entities: [entities[0], entities[6], entities[3], entities[11]],
  },
  {
    id: 's6',
    title: 'Europol\'s Silent Investigation',
    source: 'Der Spiegel 42/2023',
    pages: '24–27',
    category: 'Investigation',
    confidence: 0.78,
    reviewStatus: 'needs_review',
    excerpt: 'For eighteen months, Europol maintained a parallel investigation that even the BKA was not fully aware of. The operation, codenamed "Glass House," targeted the upper echelons of the network.',
    entities: [entities[5], entities[4], entities[11], entities[9]],
  },
  {
    id: 's7',
    title: 'Deutsche Bank\'s Compliance Blind Spots',
    source: 'SZ Dossier: Financial Networks',
    pages: '36–42',
    category: 'Analysis',
    confidence: 0.89,
    reviewStatus: 'approved',
    excerpt: 'Internal documents obtained by the Süddeutsche Zeitung reveal that Deutsche Bank\'s compliance department flagged Meridian transactions 14 times between 2019 and 2022 — each time, the alerts were closed without action.',
    entities: [entities[15], entities[3], entities[0], entities[16]],
  },
  {
    id: 's8',
    title: 'The Geneva Summit: Backroom Deals',
    source: 'ZEIT Investigation Special',
    pages: '17–22',
    category: 'Investigation',
    confidence: 0.68,
    reviewStatus: 'needs_review',
    excerpt: 'A private meeting at the 2022 Geneva financial summit allegedly set the stage for Meridian\'s most ambitious money laundering operation yet. Three attendees have since become persons of interest.',
    entities: [entities[17], entities[3], entities[11], entities[9]],
  },
];

export const sources: Source[] = [
  { id: 'src1', title: 'Der Spiegel', issue: '42/2023', pages: 84, status: 'processed', stories: 4, uploadDate: '2024-01-15' },
  { id: 'src2', title: 'ZEIT Investigation Special', issue: 'Q4/2023', pages: 64, status: 'processed', stories: 3, uploadDate: '2024-01-18' },
  { id: 'src3', title: 'SZ Dossier: Financial Networks', issue: '2023', pages: 96, status: 'processed', stories: 2, uploadDate: '2024-01-20' },
  { id: 'src4', title: 'Handelsblatt Special', issue: '12/2023', pages: 48, status: 'processing', stories: 0, uploadDate: '2024-02-01' },
  { id: 'src5', title: 'Financial Times Investigation', issue: 'Jan 2024', pages: 32, status: 'queued', stories: 0, uploadDate: '2024-02-03' },
];

export const discoveries: Discovery[] = [
  {
    id: 'd1',
    description: 'Dr. Richter and Viktor Dragan appear in 3 overlapping stories with shared connections to Meridian Capital — potential undiscovered relationship.',
    confidence: 0.84,
    entities: [entities[0], entities[11], entities[3]],
    stories: ['s1', 's5'],
  },
  {
    id: 'd2',
    description: '4 stories describe similar financial transaction patterns through Cyprus → Luxembourg → Hamburg. Possible systematic methodology.',
    confidence: 0.79,
    entities: [entities[14], entities[10], entities[8]],
    stories: ['s1', 's4'],
  },
  {
    id: 'd3',
    description: 'New entity cluster: "Glass House" operation mentioned in connection with FinCEN reports. Cross-reference with Senate Hearing testimony suggested.',
    confidence: 0.71,
    entities: [entities[5], entities[12], entities[6]],
    stories: ['s6', 's5'],
  },
];

export const processingQueue = [
  { id: 'pq1', title: 'Handelsblatt Special 12/2023', step: 'Segment', progress: 65, steps: ['OCR', 'Layout', 'Segment', 'Enrich', 'Embed', 'Graph'] },
  { id: 'pq2', title: 'Financial Times Investigation', step: 'Queued', progress: 0, steps: ['OCR', 'Layout', 'Segment', 'Enrich', 'Embed', 'Graph'] },
];

export const recentActivity = [
  { id: 'a1', action: 'Story approved', target: 'Deutsche Bank\'s Compliance Blind Spots', user: 'Sarah M.', time: '12 min ago' },
  { id: 'a2', action: 'Entity confirmed', target: 'Viktor Dragan', user: 'Alex K.', time: '28 min ago' },
  { id: 'a3', action: 'Source uploaded', target: 'Handelsblatt Special 12/2023', user: 'Franz L.', time: '1h ago' },
  { id: 'a4', action: 'Merge completed', target: 'Dr. E. Richter → Dr. Elena Richter', user: 'Sarah M.', time: '2h ago' },
  { id: 'a5', action: 'Board updated', target: 'Operation Sunrise', user: 'Alex K.', time: '3h ago' },
  { id: 'a6', action: 'Story flagged', target: 'The Geneva Summit: Backroom Deals', user: 'Franz L.', time: '4h ago' },
];

export const entityTypeColors: Record<EntityType, string> = {
  person: 'entity-person',
  organization: 'entity-organization',
  event: 'entity-event',
  location: 'entity-location',
};

export const entityTypeLabels: Record<EntityType, string> = {
  person: 'Person',
  organization: 'Organization',
  event: 'Event',
  location: 'Location',
};

export const reviewText = `A complex web of shell companies spanning Hamburg, Zürich, and Luxembourg has been quietly funneling billions through what investigators now call the "Meridian Pipeline."

At its center: <entity-person>Dr. Elena Richter</entity-person>, a former <entity-organization>Deutsche Bank</entity-organization> compliance officer turned whistleblower, whose testimony before the <entity-event>Senate Hearing 2023</entity-event> sent shockwaves through European financial regulation.

The investigation began when internal documents surfaced showing that <entity-organization>Meridian Capital Group</entity-organization> had established a network of 47 shell companies across three jurisdictions. The primary hub operated out of <entity-location>Hamburg</entity-location>'s HafenCity district, with subsidiary operations in <entity-location>Zürich</entity-location> and <entity-location>Luxembourg</entity-location>.

"The scale of the operation was breathtaking," says <entity-person>Marcus Webb</entity-person>, the British financial analyst who first raised concerns. "We're talking about €2.3 billion in suspicious transactions over a four-year period."

<entity-organization>BKA</entity-organization> investigators, working alongside <entity-organization>Europol</entity-organization>'s financial crimes unit, have since identified <entity-person>Viktor Dragan</entity-person> as a key figure in the network. Dragan, a <entity-location>Cyprus</entity-location>-based financier, is believed to have orchestrated the layering stage of the laundering process.

The <entity-event>Meridian Audit</entity-event>, conducted by an independent forensic accounting firm, revealed systematic manipulation of compliance reports dating back to 2019.`;
