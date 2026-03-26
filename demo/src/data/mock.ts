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

// Related stories with similarity scores for Story Detail page
export interface RelatedStory {
  story: Story;
  similarity: number;
  sharedEntities: Entity[];
  reason: string;
}

export function getRelatedStories(storyId: string): RelatedStory[] {
  const story = stories.find(s => s.id === storyId);
  if (!story) return [];

  const related: RelatedStory[] = [];
  for (const other of stories) {
    if (other.id === storyId) continue;
    const shared = story.entities.filter(e => other.entities.some(oe => oe.id === e.id));
    if (shared.length > 0) {
      related.push({
        story: other,
        similarity: 0.6 + shared.length * 0.08 + Math.random() * 0.05,
        sharedEntities: shared,
        reason: shared.length >= 3
          ? `${shared.length} shared entities — strong overlap`
          : shared.length === 2
          ? 'Multiple shared entities'
          : `Both mention ${shared[0].name}`,
      });
    }
  }
  return related.sort((a, b) => b.similarity - a.similarity).slice(0, 5);
}

// Entity timeline for Entity Detail page
export interface TimelineEntry {
  date: string;
  storyId: string;
  storyTitle: string;
  source: string;
  excerpt: string;
}

export function getEntityTimeline(entityId: string): TimelineEntry[] {
  const dates = ['2019-03-12', '2020-07-22', '2021-01-15', '2021-11-03', '2022-05-18', '2022-09-30', '2023-02-14', '2023-08-07'];
  const entityStories = stories.filter(s => s.entities.some(e => e.id === entityId));
  return entityStories.map((s, i) => ({
    date: dates[i % dates.length],
    storyId: s.id,
    storyTitle: s.title,
    source: s.source,
    excerpt: s.excerpt.slice(0, 120) + '...',
  })).sort((a, b) => a.date.localeCompare(b.date));
}

// Entities connected to a given entity
export function getConnectedEntities(entityId: string): { entity: Entity; sharedStories: number; strength: number }[] {
  const entityStories = stories.filter(s => s.entities.some(e => e.id === entityId));
  const counts = new Map<string, { entity: Entity; count: number }>();

  for (const s of entityStories) {
    for (const e of s.entities) {
      if (e.id === entityId) continue;
      const existing = counts.get(e.id);
      if (existing) existing.count++;
      else counts.set(e.id, { entity: e, count: 1 });
    }
  }

  return Array.from(counts.values())
    .map(({ entity, count }) => ({ entity, sharedStories: count, strength: count / entityStories.length }))
    .sort((a, b) => b.sharedStories - a.sharedStories);
}

// Merge candidates for Entity Detail page
export const mergeCandidates: Record<string, { name: string; similarity: number; mentions: number }[]> = {
  e1: [{ name: 'E. Richter', similarity: 0.92, mentions: 3 }, { name: 'Dr. E. Richter', similarity: 0.88, mentions: 5 }],
  e4: [{ name: 'Meridian Cap. Group', similarity: 0.95, mentions: 2 }, { name: 'Meridian Capital', similarity: 0.91, mentions: 7 }],
  e12: [{ name: 'V. Dragan', similarity: 0.89, mentions: 4 }],
};

// Story full text with entity markup for Story Detail page
export const storyFullTexts: Record<string, string> = {
  s1: `A complex web of shell companies spanning <entity-location>Hamburg</entity-location>, <entity-location>Zürich</entity-location>, and <entity-location>Luxembourg</entity-location> has been quietly funneling billions through what investigators now call the "Meridian Pipeline."

At its center: <entity-person>Dr. Elena Richter</entity-person>, a former <entity-organization>Deutsche Bank</entity-organization> compliance officer turned whistleblower, whose testimony before the <entity-event>Senate Hearing 2023</entity-event> sent shockwaves through European financial regulation.

The investigation began when internal documents surfaced showing that <entity-organization>Meridian Capital Group</entity-organization> had established a network of 47 shell companies across three jurisdictions. The primary hub operated out of <entity-location>Hamburg</entity-location>'s HafenCity district, with subsidiary operations in <entity-location>Zürich</entity-location> and <entity-location>Luxembourg</entity-location>.

"The scale of the operation was breathtaking," says <entity-person>Marcus Webb</entity-person>, the British financial analyst who first raised concerns. "We're talking about €2.3 billion in suspicious transactions over a four-year period."

<entity-organization>BKA</entity-organization> investigators, working alongside <entity-organization>Europol</entity-organization>'s financial crimes unit, have since identified <entity-person>Viktor Dragan</entity-person> as a key figure in the network. Dragan, a <entity-location>Cyprus</entity-location>-based financier, is believed to have orchestrated the layering stage of the laundering process.

The <entity-event>Meridian Audit</entity-event>, conducted by an independent forensic accounting firm, revealed systematic manipulation of compliance reports dating back to 2019. The audit found that over 200 individual transactions had been deliberately miscategorized to avoid triggering regulatory thresholds.

Sources close to the investigation suggest that the full scope of the network may extend well beyond what has been publicly disclosed. "What we've uncovered so far," one senior investigator told Der Spiegel on condition of anonymity, "is likely just the tip of the iceberg."`,
};

export const reviewText = `A complex web of shell companies spanning Hamburg, Zürich, and Luxembourg has been quietly funneling billions through what investigators now call the "Meridian Pipeline."

At its center: <entity-person>Dr. Elena Richter</entity-person>, a former <entity-organization>Deutsche Bank</entity-organization> compliance officer turned whistleblower, whose testimony before the <entity-event>Senate Hearing 2023</entity-event> sent shockwaves through European financial regulation.

The investigation began when internal documents surfaced showing that <entity-organization>Meridian Capital Group</entity-organization> had established a network of 47 shell companies across three jurisdictions. The primary hub operated out of <entity-location>Hamburg</entity-location>'s HafenCity district, with subsidiary operations in <entity-location>Zürich</entity-location> and <entity-location>Luxembourg</entity-location>.

"The scale of the operation was breathtaking," says <entity-person>Marcus Webb</entity-person>, the British financial analyst who first raised concerns. "We're talking about €2.3 billion in suspicious transactions over a four-year period."

<entity-organization>BKA</entity-organization> investigators, working alongside <entity-organization>Europol</entity-organization>'s financial crimes unit, have since identified <entity-person>Viktor Dragan</entity-person> as a key figure in the network. Dragan, a <entity-location>Cyprus</entity-location>-based financier, is believed to have orchestrated the layering stage of the laundering process.

The <entity-event>Meridian Audit</entity-event>, conducted by an independent forensic accounting firm, revealed systematic manipulation of compliance reports dating back to 2019.`;

// --- Evidence Analysis Data ---

export type ContradictionStatus = 'POTENTIAL' | 'CONFIRMED' | 'DISMISSED';

export interface Contradiction {
  id: string;
  claimA: string;
  claimB: string;
  sourceA: string;
  sourceB: string;
  storyA: string;
  storyB: string;
  entity: Entity;
  status: ContradictionStatus;
  geminiAnalysis: string;
}

export const contradictions: Contradiction[] = [
  {
    id: 'c1',
    claimA: 'Dr. Elena Richter left Deutsche Bank voluntarily in March 2021 to pursue whistleblower protections.',
    claimB: 'Dr. Richter was terminated by Deutsche Bank in February 2021 after internal compliance disputes.',
    sourceA: 'Der Spiegel 42/2023, pp. 12-18',
    sourceB: 'SZ Dossier: Financial Networks, pp. 36-42',
    storyA: 'Shadow Networks in European Banking',
    storyB: "Deutsche Bank's Compliance Blind Spots",
    entity: entities[0],
    status: 'CONFIRMED',
    geminiAnalysis: 'Both sources provide detailed accounts of Dr. Richter\'s departure from Deutsche Bank, but differ on whether it was voluntary or forced. The Spiegel account cites Richter\'s own testimony, while the SZ Dossier references internal HR documents. The contradiction is material — the nature of her departure affects her credibility as a whistleblower and potential bias. Recommended: flag for human review and cross-reference with Senate Hearing testimony.',
  },
  {
    id: 'c2',
    claimA: 'Meridian Capital Group established 47 shell companies across three jurisdictions.',
    claimB: 'Investigators identified 62 shell entities linked to Meridian Capital, spanning five jurisdictions including Malta and the Channel Islands.',
    sourceA: 'Der Spiegel 42/2023, pp. 12-18',
    sourceB: 'ZEIT Investigation Special, pp. 12-16',
    storyA: 'Shadow Networks in European Banking',
    storyB: 'The Senate Hearing That Changed Everything',
    entity: entities[3],
    status: 'POTENTIAL',
    geminiAnalysis: 'The discrepancy may reflect different stages of the investigation. The Spiegel figure (47) appears to reference early findings, while the ZEIT report (62) includes entities discovered during the Senate Hearing preparation. The additional jurisdictions (Malta, Channel Islands) were not part of the initial BKA investigation scope. Further analysis needed to determine if these are genuinely contradictory or represent investigation progression.',
  },
  {
    id: 'c3',
    claimA: 'Viktor Dragan is a Cyprus-based financier who orchestrated the layering stage of the laundering process.',
    claimB: 'Viktor Dragan operated primarily from Luxembourg, managing the integration phase of fund repatriation.',
    sourceA: 'Der Spiegel 42/2023, pp. 12-18',
    sourceB: 'SZ Dossier: Financial Networks, pp. 28-35',
    storyA: 'Shadow Networks in European Banking',
    storyB: 'Following the Money: Cyprus to Luxembourg',
    entity: entities[11],
    status: 'POTENTIAL',
    geminiAnalysis: 'The claims differ on both Dragan\'s primary location (Cyprus vs. Luxembourg) and his role (layering vs. integration). It is possible Dragan operated from multiple locations at different times. The role difference may reflect a misunderstanding of his actual position in the network. Pending resolution via source cross-referencing.',
  },
  {
    id: 'c4',
    claimA: 'The BKA launched a joint task force with Europol immediately after receiving Sarah Chen\'s documents.',
    claimB: 'Europol maintained a parallel investigation ("Glass House") that even the BKA was not fully aware of for 18 months.',
    sourceA: 'ZEIT Investigation Special, pp. 4-11',
    sourceB: 'Der Spiegel 42/2023, pp. 24-27',
    storyA: 'Whistleblower Protocol Alpha',
    storyB: "Europol's Silent Investigation",
    entity: entities[5],
    status: 'CONFIRMED',
    geminiAnalysis: 'These claims are directly contradictory regarding the level of coordination between BKA and Europol. If the BKA launched a "joint" task force, they would have been aware of Europol\'s activities. Yet the Spiegel report explicitly states Europol operated in secret. This suggests either the "joint" label was a public-facing characterization, or the Glass House operation was compartmentalized within Europol itself. This contradiction has significant implications for understanding institutional coordination failures.',
  },
  {
    id: 'c5',
    claimA: 'Deutsche Bank\'s compliance department flagged Meridian transactions 14 times between 2019 and 2022.',
    claimB: 'Only 3 formal compliance alerts were filed regarding Meridian Capital between 2019 and 2023, all in 2022.',
    sourceA: 'SZ Dossier: Financial Networks, pp. 36-42',
    sourceB: 'ZEIT Investigation Special, pp. 12-16',
    storyA: "Deutsche Bank's Compliance Blind Spots",
    storyB: 'The Senate Hearing That Changed Everything',
    entity: entities[15],
    status: 'DISMISSED',
    geminiAnalysis: 'After analysis, these claims are not contradictory. The SZ Dossier refers to internal system flags (automated alerts), while the ZEIT report refers to formal compliance alerts (human-filed reports). The 14 automated flags were triaged by the compliance team, and only 3 were escalated to formal alerts. Both accounts are accurate within their respective contexts. Dismissed as a terminology difference rather than a factual contradiction.',
  },
  {
    id: 'c6',
    claimA: 'The Geneva Summit meeting in 2022 involved three attendees who became persons of interest.',
    claimB: 'Five individuals from the Geneva Summit were subsequently identified as persons of interest by FinCEN.',
    sourceA: 'ZEIT Investigation Special, pp. 17-22',
    sourceB: 'ZEIT Investigation Special, pp. 12-16',
    storyA: 'The Geneva Summit: Backroom Deals',
    storyB: 'The Senate Hearing That Changed Everything',
    entity: entities[17],
    status: 'POTENTIAL',
    geminiAnalysis: 'Both claims originate from the same publication (ZEIT) but different articles. The discrepancy in numbers (3 vs. 5) may indicate additional persons of interest were identified after the initial report. The FinCEN reference in the second claim suggests a broader net was cast during international cooperation. Needs clarification on timeline of identification.',
  },
  {
    id: 'c7',
    claimA: 'Marcus Webb first raised concerns about Meridian Capital while working as an external analyst in Hamburg.',
    claimB: 'Webb was an embedded contractor within Meridian Capital Group when he discovered the irregularities.',
    sourceA: 'Der Spiegel 42/2023, pp. 19-23',
    sourceB: 'ZEIT Investigation Special, pp. 4-11',
    storyA: 'The Hamburg Connection',
    storyB: 'Whistleblower Protocol Alpha',
    entity: entities[1],
    status: 'CONFIRMED',
    geminiAnalysis: 'The distinction between "external analyst" and "embedded contractor" is significant. An external analyst would have limited access to internal systems, while an embedded contractor would have had direct access to transaction records. This affects the credibility and scope of his initial findings. The Spiegel interview with Webb himself uses the term "analyst," while the ZEIT report cites BKA investigation documents referring to him as a "contractor." The discrepancy may reflect Webb\'s own framing vs. his contractual status.',
  },
];

export interface CorroborationEntry {
  id: string;
  claim: string;
  entity: Entity;
  independentSourceCount: number;
  corroborationScore: number;
  sourceReliability: number;
  evidenceChainStrength: number;
  sources: { name: string; reliability: number; storyTitle: string }[];
}

export const corroborationEntries: CorroborationEntry[] = [
  {
    id: 'cor1',
    claim: 'Meridian Capital Group operated a network of shell companies spanning Hamburg, Zurich, and Luxembourg.',
    entity: entities[3],
    independentSourceCount: 4,
    corroborationScore: 0.94,
    sourceReliability: 0.92,
    evidenceChainStrength: 0.89,
    sources: [
      { name: 'Der Spiegel', reliability: 0.95, storyTitle: 'Shadow Networks in European Banking' },
      { name: 'SZ Dossier', reliability: 0.91, storyTitle: 'Following the Money: Cyprus to Luxembourg' },
      { name: 'ZEIT Investigation', reliability: 0.88, storyTitle: 'The Senate Hearing That Changed Everything' },
      { name: 'ZEIT Investigation', reliability: 0.85, storyTitle: 'The Geneva Summit: Backroom Deals' },
    ],
  },
  {
    id: 'cor2',
    claim: 'Dr. Elena Richter served as a key whistleblower in the Meridian Capital investigation.',
    entity: entities[0],
    independentSourceCount: 3,
    corroborationScore: 0.91,
    sourceReliability: 0.93,
    evidenceChainStrength: 0.87,
    sources: [
      { name: 'Der Spiegel', reliability: 0.95, storyTitle: 'Shadow Networks in European Banking' },
      { name: 'ZEIT Investigation', reliability: 0.92, storyTitle: 'The Senate Hearing That Changed Everything' },
      { name: 'SZ Dossier', reliability: 0.89, storyTitle: "Deutsche Bank's Compliance Blind Spots" },
    ],
  },
  {
    id: 'cor3',
    claim: 'BKA and Europol conducted investigations into Meridian Capital Group.',
    entity: entities[4],
    independentSourceCount: 3,
    corroborationScore: 0.88,
    sourceReliability: 0.90,
    evidenceChainStrength: 0.82,
    sources: [
      { name: 'ZEIT Investigation', reliability: 0.90, storyTitle: 'Whistleblower Protocol Alpha' },
      { name: 'Der Spiegel', reliability: 0.93, storyTitle: "Europol's Silent Investigation" },
      { name: 'Der Spiegel', reliability: 0.88, storyTitle: 'The Hamburg Connection' },
    ],
  },
  {
    id: 'cor4',
    claim: 'Financial transactions were routed through Cyprus to Luxembourg to Hamburg.',
    entity: entities[14],
    independentSourceCount: 2,
    corroborationScore: 0.79,
    sourceReliability: 0.87,
    evidenceChainStrength: 0.74,
    sources: [
      { name: 'SZ Dossier', reliability: 0.91, storyTitle: 'Following the Money: Cyprus to Luxembourg' },
      { name: 'Der Spiegel', reliability: 0.84, storyTitle: 'Shadow Networks in European Banking' },
    ],
  },
  {
    id: 'cor5',
    claim: 'Viktor Dragan played a central role in the Meridian network operations.',
    entity: entities[11],
    independentSourceCount: 3,
    corroborationScore: 0.76,
    sourceReliability: 0.82,
    evidenceChainStrength: 0.71,
    sources: [
      { name: 'Der Spiegel', reliability: 0.85, storyTitle: 'Shadow Networks in European Banking' },
      { name: 'ZEIT Investigation', reliability: 0.80, storyTitle: 'The Senate Hearing That Changed Everything' },
      { name: 'Der Spiegel', reliability: 0.78, storyTitle: "Europol's Silent Investigation" },
    ],
  },
  {
    id: 'cor6',
    claim: 'Deutsche Bank compliance failures enabled Meridian Capital operations.',
    entity: entities[15],
    independentSourceCount: 2,
    corroborationScore: 0.83,
    sourceReliability: 0.89,
    evidenceChainStrength: 0.78,
    sources: [
      { name: 'SZ Dossier', reliability: 0.93, storyTitle: "Deutsche Bank's Compliance Blind Spots" },
      { name: 'Der Spiegel', reliability: 0.86, storyTitle: 'Shadow Networks in European Banking' },
    ],
  },
  {
    id: 'cor7',
    claim: 'Marcus Webb was the first to raise concerns about Meridian Capital Group.',
    entity: entities[1],
    independentSourceCount: 2,
    corroborationScore: 0.72,
    sourceReliability: 0.85,
    evidenceChainStrength: 0.68,
    sources: [
      { name: 'Der Spiegel', reliability: 0.90, storyTitle: 'The Hamburg Connection' },
      { name: 'ZEIT Investigation', reliability: 0.80, storyTitle: 'Whistleblower Protocol Alpha' },
    ],
  },
  {
    id: 'cor8',
    claim: 'The 2023 Senate Hearing was a turning point in the Meridian investigation.',
    entity: entities[6],
    independentSourceCount: 2,
    corroborationScore: 0.85,
    sourceReliability: 0.88,
    evidenceChainStrength: 0.81,
    sources: [
      { name: 'ZEIT Investigation', reliability: 0.92, storyTitle: 'The Senate Hearing That Changed Everything' },
      { name: 'SZ Dossier', reliability: 0.85, storyTitle: "Deutsche Bank's Compliance Blind Spots" },
    ],
  },
  {
    id: 'cor9',
    claim: 'Sarah Chen received encrypted documents detailing systemic fraud at Meridian.',
    entity: entities[2],
    independentSourceCount: 1,
    corroborationScore: 0.54,
    sourceReliability: 0.78,
    evidenceChainStrength: 0.49,
    sources: [
      { name: 'ZEIT Investigation', reliability: 0.78, storyTitle: 'Whistleblower Protocol Alpha' },
    ],
  },
  {
    id: 'cor10',
    claim: 'Prof. Hans Mueller provided expert testimony on compliance frameworks during the investigation.',
    entity: entities[16],
    independentSourceCount: 1,
    corroborationScore: 0.61,
    sourceReliability: 0.82,
    evidenceChainStrength: 0.55,
    sources: [
      { name: 'SZ Dossier', reliability: 0.82, storyTitle: "Deutsche Bank's Compliance Blind Spots" },
    ],
  },
];

export interface SpatioTemporalEvent {
  id: string;
  title: string;
  timestamp: string;
  location: string;
  lat: number;
  lng: number;
  entities: Entity[];
  entityType: EntityType;
  description: string;
  clusterId: string;
}

export interface TemporalCluster {
  id: string;
  label: string;
  startDate: string;
  endDate: string;
  eventCount: number;
  description: string;
}

export const spatioTemporalEvents: SpatioTemporalEvent[] = [
  {
    id: 'ste1',
    title: 'Meridian Capital Hamburg Office Established',
    timestamp: '2019-03-15',
    location: 'Hamburg',
    lat: 53.55,
    lng: 10.0,
    entities: [entities[3], entities[8]],
    entityType: 'organization',
    description: 'Meridian Capital Group opens HafenCity office, beginning Hamburg operations.',
    clusterId: 'tc1',
  },
  {
    id: 'ste2',
    title: 'First Suspicious Transaction Flagged',
    timestamp: '2019-07-22',
    location: 'Zurich',
    lat: 47.37,
    lng: 8.54,
    entities: [entities[3], entities[9]],
    entityType: 'event',
    description: 'Deutsche Bank automated systems flag first Meridian-linked transaction in Zurich.',
    clusterId: 'tc1',
  },
  {
    id: 'ste3',
    title: 'Cyprus Shell Company Registration',
    timestamp: '2019-11-08',
    location: 'Nicosia',
    lat: 35.17,
    lng: 33.36,
    entities: [entities[14], entities[3]],
    entityType: 'organization',
    description: 'Three shell companies registered in Cyprus, later linked to Meridian Capital network.',
    clusterId: 'tc1',
  },
  {
    id: 'ste4',
    title: 'Luxembourg Holding Structure Created',
    timestamp: '2020-02-14',
    location: 'Luxembourg',
    lat: 49.61,
    lng: 6.13,
    entities: [entities[10], entities[3]],
    entityType: 'organization',
    description: 'Complex holding structure established in Luxembourg for fund cleaning operations.',
    clusterId: 'tc1',
  },
  {
    id: 'ste5',
    title: 'Marcus Webb Begins Investigation',
    timestamp: '2020-09-03',
    location: 'Hamburg',
    lat: 53.55,
    lng: 10.0,
    entities: [entities[1], entities[3], entities[8]],
    entityType: 'person',
    description: 'Financial analyst Marcus Webb starts examining Meridian Capital transaction patterns.',
    clusterId: 'tc2',
  },
  {
    id: 'ste6',
    title: 'Dr. Richter Leaves Deutsche Bank',
    timestamp: '2021-02-28',
    location: 'Hamburg',
    lat: 53.55,
    lng: 10.0,
    entities: [entities[0], entities[15], entities[8]],
    entityType: 'person',
    description: 'Dr. Elena Richter departs Deutsche Bank under disputed circumstances.',
    clusterId: 'tc2',
  },
  {
    id: 'ste7',
    title: 'Sarah Chen Receives Encrypted Documents',
    timestamp: '2021-10-12',
    location: 'Hamburg',
    lat: 53.55,
    lng: 10.0,
    entities: [entities[2], entities[8]],
    entityType: 'person',
    description: 'Journalist Sarah Chen obtains encrypted documents detailing Meridian fraud.',
    clusterId: 'tc2',
  },
  {
    id: 'ste8',
    title: 'BKA-Europol Joint Task Force Formed',
    timestamp: '2022-01-18',
    location: 'Hamburg',
    lat: 53.55,
    lng: 10.0,
    entities: [entities[4], entities[5], entities[8]],
    entityType: 'organization',
    description: 'BKA and Europol announce joint task force targeting Meridian network.',
    clusterId: 'tc3',
  },
  {
    id: 'ste9',
    title: 'Operation Glass House Initiated',
    timestamp: '2022-03-05',
    location: 'The Hague',
    lat: 52.07,
    lng: 4.3,
    entities: [entities[5], entities[11]],
    entityType: 'event',
    description: 'Europol launches secret parallel investigation codenamed "Glass House."',
    clusterId: 'tc3',
  },
  {
    id: 'ste10',
    title: 'Geneva Summit Meeting',
    timestamp: '2022-06-15',
    location: 'Geneva',
    lat: 46.2,
    lng: 6.15,
    entities: [entities[17], entities[3], entities[11]],
    entityType: 'event',
    description: 'Private meeting at Geneva financial summit sets stage for major laundering operation.',
    clusterId: 'tc3',
  },
  {
    id: 'ste11',
    title: 'FinCEN Report Filed',
    timestamp: '2022-11-30',
    location: 'Hamburg',
    lat: 53.55,
    lng: 10.0,
    entities: [entities[12], entities[3], entities[8]],
    entityType: 'organization',
    description: 'FinCEN receives suspicious activity reports linked to Meridian Capital operations.',
    clusterId: 'tc3',
  },
  {
    id: 'ste12',
    title: 'Senate Hearing — Dr. Richter Testimony',
    timestamp: '2023-02-14',
    location: 'Hamburg',
    lat: 53.55,
    lng: 10.0,
    entities: [entities[0], entities[6], entities[3], entities[11]],
    entityType: 'event',
    description: 'Dr. Richter testifies at 2023 Senate hearing, implicating Meridian network and naming Viktor Dragan.',
    clusterId: 'tc4',
  },
  {
    id: 'ste13',
    title: 'Dragan Assets Frozen in Cyprus',
    timestamp: '2023-05-22',
    location: 'Nicosia',
    lat: 35.17,
    lng: 33.36,
    entities: [entities[11], entities[14]],
    entityType: 'person',
    description: 'Viktor Dragan\'s Cyprus-based assets frozen by court order following Senate revelations.',
    clusterId: 'tc4',
  },
  {
    id: 'ste14',
    title: 'Meridian Audit Released',
    timestamp: '2023-08-07',
    location: 'Zurich',
    lat: 47.37,
    lng: 8.54,
    entities: [entities[7], entities[3], entities[9]],
    entityType: 'event',
    description: 'Independent forensic audit reveals systematic compliance report manipulation since 2019.',
    clusterId: 'tc4',
  },
  {
    id: 'ste15',
    title: 'Glass House Operation Concludes',
    timestamp: '2023-10-15',
    location: 'The Hague',
    lat: 52.07,
    lng: 4.3,
    entities: [entities[5], entities[11], entities[3]],
    entityType: 'event',
    description: 'Europol\'s 18-month Glass House investigation concludes with multiple arrest warrants.',
    clusterId: 'tc4',
  },
];

export const temporalClusters: TemporalCluster[] = [
  {
    id: 'tc1',
    label: 'Network Establishment',
    startDate: '2019-01-01',
    endDate: '2020-06-30',
    eventCount: 4,
    description: 'Initial setup of Meridian Capital shell company network across Hamburg, Zurich, Cyprus, and Luxembourg.',
  },
  {
    id: 'tc2',
    label: 'Whistleblower Emergence',
    startDate: '2020-07-01',
    endDate: '2021-12-31',
    eventCount: 3,
    description: 'Key individuals begin investigating and documenting Meridian Capital irregularities.',
  },
  {
    id: 'tc3',
    label: 'Institutional Response',
    startDate: '2022-01-01',
    endDate: '2022-12-31',
    eventCount: 4,
    description: 'Law enforcement agencies initiate formal investigations and international cooperation.',
  },
  {
    id: 'tc4',
    label: 'Public Reckoning',
    startDate: '2023-01-01',
    endDate: '2023-12-31',
    eventCount: 4,
    description: 'Senate hearings, asset freezes, and audit revelations bring the case into public view.',
  },
];
