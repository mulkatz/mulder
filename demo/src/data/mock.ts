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
  // Personen (0-12)
  { id: 'e1', name: 'David Fravor', type: 'person', mentions: 38, connections: 10, confidence: 0.96, status: 'confirmed' },
  { id: 'e2', name: 'Bob Lazar', type: 'person', mentions: 45, connections: 8, confidence: 0.72, status: 'suggested' },
  { id: 'e3', name: 'Luis Elizondo', type: 'person', mentions: 52, connections: 14, confidence: 0.91, status: 'confirmed' },
  { id: 'e4', name: 'Charles Halt', type: 'person', mentions: 29, connections: 7, confidence: 0.93, status: 'confirmed' },
  { id: 'e5', name: 'Jim Penniston', type: 'person', mentions: 24, connections: 6, confidence: 0.78, status: 'suggested' },
  { id: 'e6', name: 'Ryan Graves', type: 'person', mentions: 31, connections: 9, confidence: 0.94, status: 'confirmed' },
  { id: 'e7', name: 'David Grusch', type: 'person', mentions: 27, connections: 11, confidence: 0.85, status: 'confirmed' },
  { id: 'e8', name: 'Fife Symington', type: 'person', mentions: 18, connections: 5, confidence: 0.89, status: 'confirmed' },
  { id: 'e9', name: 'Jesse Marcel', type: 'person', mentions: 22, connections: 6, confidence: 0.82, status: 'suggested' },
  { id: 'e10', name: 'Harry Reid', type: 'person', mentions: 20, connections: 8, confidence: 0.94, status: 'confirmed' },
  { id: 'e11', name: 'Alex Dietrich', type: 'person', mentions: 16, connections: 5, confidence: 0.92, status: 'confirmed' },
  { id: 'e12', name: 'Kevin Day', type: 'person', mentions: 14, connections: 5, confidence: 0.90, status: 'confirmed' },
  { id: 'e13', name: 'Sean Kirkpatrick', type: 'person', mentions: 15, connections: 6, confidence: 0.91, status: 'confirmed' },
  // Organisationen (13-19)
  { id: 'e14', name: 'Pentagon', type: 'organization', mentions: 67, connections: 16, confidence: 0.99, status: 'confirmed' },
  { id: 'e15', name: 'AATIP', type: 'organization', mentions: 41, connections: 12, confidence: 0.95, status: 'confirmed' },
  { id: 'e16', name: 'AARO', type: 'organization', mentions: 28, connections: 9, confidence: 0.97, status: 'confirmed' },
  { id: 'e17', name: 'US Navy', type: 'organization', mentions: 44, connections: 13, confidence: 0.98, status: 'confirmed' },
  { id: 'e18', name: 'SOBEPS', type: 'organization', mentions: 19, connections: 5, confidence: 0.90, status: 'confirmed' },
  { id: 'e19', name: 'MUFON', type: 'organization', mentions: 23, connections: 7, confidence: 0.92, status: 'confirmed' },
  { id: 'e20', name: 'RAF', type: 'organization', mentions: 17, connections: 4, confidence: 0.95, status: 'confirmed' },
  // Ereignisse (20-26)
  { id: 'e21', name: 'Rendlesham Forest Incident', type: 'event', mentions: 33, connections: 10, confidence: 0.96, status: 'confirmed' },
  { id: 'e22', name: 'Phoenix Lights Sichtung', type: 'event', mentions: 25, connections: 8, confidence: 0.94, status: 'confirmed' },
  { id: 'e23', name: 'USS Nimitz Encounter', type: 'event', mentions: 36, connections: 11, confidence: 0.97, status: 'confirmed' },
  { id: 'e24', name: 'Roswell-Absturz', type: 'event', mentions: 48, connections: 12, confidence: 0.88, status: 'confirmed' },
  { id: 'e25', name: 'Belgische UFO-Welle', type: 'event', mentions: 21, connections: 7, confidence: 0.93, status: 'confirmed' },
  { id: 'e26', name: 'Senate UAP Hearing 2023', type: 'event', mentions: 15, connections: 9, confidence: 0.91, status: 'confirmed' },
  { id: 'e27', name: 'NYT-Enthüllung 2017', type: 'event', mentions: 18, connections: 10, confidence: 0.95, status: 'confirmed' },
  // Orte (27-32)
  { id: 'e28', name: 'Area 51, Nevada', type: 'location', mentions: 39, connections: 9, confidence: 0.99, status: 'confirmed' },
  { id: 'e29', name: 'Rendlesham Forest, Suffolk', type: 'location', mentions: 30, connections: 8, confidence: 0.98, status: 'confirmed' },
  { id: 'e30', name: 'Phoenix, Arizona', type: 'location', mentions: 22, connections: 6, confidence: 0.97, status: 'confirmed' },
  { id: 'e31', name: 'Roswell, New Mexico', type: 'location', mentions: 35, connections: 7, confidence: 0.99, status: 'confirmed' },
  { id: 'e32', name: 'Eupen, Belgien', type: 'location', mentions: 16, connections: 5, confidence: 0.95, status: 'confirmed' },
  { id: 'e33', name: 'Washington D.C.', type: 'location', mentions: 42, connections: 11, confidence: 0.99, status: 'confirmed' },
];

export const stories: Story[] = [
  {
    id: 's1',
    title: 'Das Tic-Tac-Objekt über dem Pazifik',
    source: 'MUFON UFO Journal 03/2017',
    pages: '12–24',
    category: 'Augenzeugen-Bericht',
    confidence: 0.95,
    reviewStatus: 'approved',
    excerpt: 'Am 14. November 2004 beobachtete Commander David Fravor von der USS Nimitz ein weißes, ovales Objekt ohne sichtbare Antriebssysteme über dem Pazifik. Das Objekt beschleunigte innerhalb von Sekunden auf geschätzte 46.000 km/h — ohne Überschallknall.',
    entities: [entities[0], entities[16], entities[22], entities[14]],
  },
  {
    id: 's2',
    title: 'Die Nächte von Rendlesham Forest',
    source: 'MoD Rendlesham Files 1981',
    pages: '1–18',
    category: 'Militär-Dokument',
    confidence: 0.91,
    reviewStatus: 'approved',
    excerpt: 'In den Nächten des 26. und 28. Dezember 1980 beobachteten US-Militärangehörige nahe RAF Woodbridge unerklärliche Lichterscheinungen im Rendlesham Forest. Lt. Col. Charles Halt dokumentierte erhöhte Strahlungswerte am mutmaßlichen Landeplatz.',
    entities: [entities[3], entities[4], entities[20], entities[28]],
  },
  {
    id: 's3',
    title: 'Bob Lazars Element 115: Genie oder Schwindler?',
    source: 'Magazin 2000 Ausgabe 395',
    pages: '14–28',
    category: 'Investigativ-Recherche',
    confidence: 0.72,
    reviewStatus: 'needs_review',
    excerpt: 'Bob Lazar behauptet seit 1989, am geheimen S-4-Komplex bei Area 51 an der Reverse-Engineering-Forschung außerirdischer Antriebstechnologie gearbeitet zu haben. Element 115, das er als Treibstoff nannte, wurde 2003 tatsächlich synthetisiert — doch seine Bildungsangaben bleiben unverifizierbar.',
    entities: [entities[1], entities[27], entities[13]],
  },
  {
    id: 's4',
    title: 'Phoenix Lights: Die Nacht, in der Arizona den Atem anhielt',
    source: 'MUFON UFO Journal 03/2017',
    pages: '28–38',
    category: 'Augenzeugen-Bericht',
    confidence: 0.93,
    reviewStatus: 'approved',
    excerpt: 'Am 13. März 1997 beobachteten Tausende Einwohner Arizonas eine riesige V-Formation am Nachthimmel über Phoenix. Governor Fife Symington verspottete die Berichte zunächst öffentlich — um zehn Jahre später seine eigene Sichtung zuzugeben.',
    entities: [entities[7], entities[21], entities[29]],
  },
  {
    id: 's5',
    title: 'Pentagons geheimes UFO-Programm',
    source: 'Der Spiegel 47/2017',
    pages: '94–103',
    category: 'Investigativ-Recherche',
    confidence: 0.89,
    reviewStatus: 'approved',
    excerpt: 'Von 2007 bis 2012 betrieb das Pentagon mit 22 Millionen Dollar Budget das Advanced Aerospace Threat Identification Program (AATIP). Luis Elizondo, der das Programm leitete, trat 2017 aus Protest gegen die Geheimhaltung zurück.',
    entities: [entities[2], entities[13], entities[14], entities[9]],
  },
  {
    id: 's6',
    title: 'Der Absturz von Roswell: Was wirklich geschah',
    source: 'GEP Journal 02/2020',
    pages: '4–18',
    category: 'Wissenschaftliche Analyse',
    confidence: 0.84,
    reviewStatus: 'approved',
    excerpt: 'Im Juli 1947 entdeckte Rancher Mac Brazel Trümmer auf seiner Farm bei Roswell, New Mexico. Major Jesse Marcel von der Roswell Army Air Field untersuchte den Fund. Die erste Pressemitteilung sprach von einer „fliegenden Untertasse" — am nächsten Tag wurde auf „Wetterballon" korrigiert.',
    entities: [entities[8], entities[23], entities[30]],
  },
  {
    id: 's7',
    title: 'Belgiens schwarze Dreiecke: Die SOBEPS-Akten',
    source: 'SOBEPS Bulletin 04/1990',
    pages: '1–28',
    category: 'Wissenschaftliche Analyse',
    confidence: 0.88,
    reviewStatus: 'approved',
    excerpt: 'Zwischen November 1989 und April 1990 dokumentierte die SOBEPS über 2.600 Sichtungsberichte dreieckiger Objekte über Belgien. Am 30. März 1990 wurden zwei F-16 aus Beauvechain zur Verfolgung gestartet — die Radaraufzeichnungen bleiben umstritten.',
    entities: [entities[17], entities[24], entities[31]],
  },
  {
    id: 's8',
    title: 'David Gruschs Aussage: „Nicht-menschliche Intelligenz"',
    source: 'Congressional Record Juli 2023',
    pages: '44–62',
    category: 'Regierungsdokument',
    confidence: 0.86,
    reviewStatus: 'approved',
    excerpt: 'Am 26. Juli 2023 sagte der ehemalige Geheimdienstoffizier David Grusch vor dem US-Kongress unter Eid aus, dass die US-Regierung über ein jahrzehntelanges Bergungsprogramm für nicht-menschliche Fahrzeuge verfüge. AARO-Direktor Sean Kirkpatrick widersprach: Es gebe „keine glaubwürdigen Beweise".',
    entities: [entities[6], entities[13], entities[15], entities[25], entities[32]],
  },
  {
    id: 's9',
    title: 'Die Enthüllung: Wie die New York Times das Pentagon zwang',
    source: 'Die ZEIT 51/2017',
    pages: '12–20',
    category: 'Hintergrundbericht',
    confidence: 0.90,
    reviewStatus: 'approved',
    excerpt: 'Am 16. Dezember 2017 veröffentlichte die New York Times die Existenz des geheimen Pentagon-Programms AATIP. Luis Elizondo, der ehemalige Programmleiter, hatte das FLIR1-Video an die Öffentlichkeit gebracht — ein Wendepunkt in der UAP-Debatte.',
    entities: [entities[2], entities[14], entities[13], entities[26]],
  },
  {
    id: 's10',
    title: 'USS Roosevelt: Tägliche Begegnungen über dem Atlantik',
    source: 'MUFON UFO Journal 03/2017',
    pages: '40–50',
    category: 'Augenzeugen-Bericht',
    confidence: 0.91,
    reviewStatus: 'approved',
    excerpt: 'Lt. Ryan Graves von der VFA-11 „Red Rippers" berichtete von nahezu täglichen UAP-Sichtungen über Monate hinweg im Sommer 2014 bis März 2015. Die Objekte wurden als „dunkle Würfel in einer transparenten Kugel" beschrieben — ohne sichtbaren Antrieb.',
    entities: [entities[5], entities[16], entities[13]],
  },
  {
    id: 's11',
    title: 'Die Halt-Memo: Warum ein Offizier sein Schweigen brach',
    source: 'Der Spiegel 47/2017',
    pages: '106–112',
    category: 'Hintergrundbericht',
    confidence: 0.85,
    reviewStatus: 'needs_review',
    excerpt: 'Lt. Col. Charles Halt verfasste am 13. Januar 1981 ein offizielles Memo an das britische Verteidigungsministerium über die Vorfälle im Rendlesham Forest. Jahrzehnte später unterzeichnete er eine eidesstattliche Erklärung mit deutlich weitergehenden Behauptungen.',
    entities: [entities[3], entities[20], entities[28], entities[13]],
  },
  {
    id: 's12',
    title: 'AARO vs. die Whistleblower',
    source: 'FAZ Wochenendbeilage Jan 2024',
    pages: '2–10',
    category: 'Investigativ-Recherche',
    confidence: 0.87,
    reviewStatus: 'approved',
    excerpt: 'Das All-domain Anomaly Resolution Office unter Sean Kirkpatrick kam 2024 zu dem Schluss, es gebe „keine empirischen Beweise" für außerirdische Technologie. David Grusch und seine Unterstützer sprechen von institutioneller Vertuschung.',
    entities: [entities[12], entities[15], entities[6], entities[13]],
  },
  {
    id: 's13',
    title: '22 Millionen Dollar für die Wahrheit',
    source: 'Die ZEIT 51/2017',
    pages: '21–27',
    category: 'Hintergrundbericht',
    confidence: 0.82,
    reviewStatus: 'needs_review',
    excerpt: 'Senator Harry Reid initiierte 2007 das AATIP-Programm mit $22 Millionen aus dem Verteidigungshaushalt. Der Großteil floss an Robert Bigelows Firma BAASS — inklusive Forschung zu Warp-Antrieben und der berüchtigten Skinwalker Ranch.',
    entities: [entities[9], entities[14], entities[13], entities[32]],
  },
  {
    id: 's14',
    title: 'Das Petit-Rechain-Foto: Anatomie einer Fälschung',
    source: 'Bild der Wissenschaft 02/2018',
    pages: '32–38',
    category: 'Wissenschaftliche Analyse',
    confidence: 0.94,
    reviewStatus: 'approved',
    excerpt: 'Das ikonische Foto des dreieckigen Objekts von Petit-Rechain galt 20 Jahre lang als stärkster Beweis der belgischen UFO-Welle. Am 26. Juli 2011 gestand Patrick Marechal: Er hatte es aus einem Stück Styropor mit vier Glühbirnen gebastelt.',
    entities: [entities[17], entities[24], entities[31]],
  },
];

export const sources: Source[] = [
  { id: 'src1', title: 'MUFON UFO Journal', issue: '03/2017', pages: 96, status: 'processed', stories: 3, uploadDate: '2024-08-15' },
  { id: 'src2', title: 'Der Spiegel', issue: '47/2017', pages: 84, status: 'processed', stories: 2, uploadDate: '2024-08-20' },
  { id: 'src3', title: 'Die ZEIT', issue: '51/2017', pages: 48, status: 'processed', stories: 2, uploadDate: '2024-08-22' },
  { id: 'src4', title: 'SOBEPS Bulletin', issue: '04/1990', pages: 72, status: 'processed', stories: 1, uploadDate: '2024-09-01' },
  { id: 'src5', title: 'MoD Rendlesham Files', issue: '1981', pages: 36, status: 'processed', stories: 1, uploadDate: '2024-09-05' },
  { id: 'src6', title: 'GEP Journal', issue: '02/2020', pages: 52, status: 'processed', stories: 1, uploadDate: '2024-09-10' },
  { id: 'src7', title: 'Congressional Record', issue: 'Juli 2023', pages: 128, status: 'processing', stories: 0, uploadDate: '2024-10-01' },
  { id: 'src8', title: 'Focus', issue: '05/2024', pages: 56, status: 'queued', stories: 0, uploadDate: '2024-10-05' },
];

export const discoveries: Discovery[] = [
  {
    id: 'd1',
    description: 'David Fravor und Luis Elizondo tauchen in 3 überlappenden Berichten auf, mit gemeinsamen Verbindungen zum Pentagon — möglicherweise unentdeckter Zusammenhang über das AATIP-Programm.',
    confidence: 0.84,
    entities: [entities[0], entities[2], entities[13]],
    stories: ['s1', 's5'],
  },
  {
    id: 'd2',
    description: '4 Berichte beschreiben identische Merkmale bei militärischen UAP-Sichtungen: keine sichtbaren Antriebssysteme, Überschall-Beschleunigung ohne Knall. Mögliche systematische Übereinstimmung.',
    confidence: 0.79,
    entities: [entities[0], entities[5], entities[16]],
    stories: ['s1', 's10'],
  },
  {
    id: 'd3',
    description: 'Neues Entity-Cluster: „Disclosure-Bewegung" — Elizondo, Reid und Grusch sind im Zeitraum 2017–2023 miteinander verknüpft. Kreuzreferenz mit Congressional Record empfohlen.',
    confidence: 0.71,
    entities: [entities[2], entities[9], entities[6]],
    stories: ['s5', 's8'],
  },
];

export const processingQueue = [
  { id: 'pq1', title: 'Congressional Record Juli 2023', step: 'Enrich', progress: 72, steps: ['OCR', 'Layout', 'Segment', 'Enrich', 'Embed', 'Graph'] },
  { id: 'pq2', title: 'Focus 05/2024', step: 'Wartend', progress: 0, steps: ['OCR', 'Layout', 'Segment', 'Enrich', 'Embed', 'Graph'] },
];

export const recentActivity = [
  { id: 'a1', action: 'Bericht freigegeben', target: 'Die Halt-Memo: Warum ein Offizier sein Schweigen brach', user: 'Sarah M.', time: 'vor 12 Min.' },
  { id: 'a2', action: 'Akteur bestätigt', target: 'David Fravor', user: 'Alex K.', time: 'vor 28 Min.' },
  { id: 'a3', action: 'Quelle hochgeladen', target: 'Focus 05/2024', user: 'Franz L.', time: 'vor 1 Std.' },
  { id: 'a4', action: 'Zusammenführung', target: 'L. Elizondo → Luis Elizondo', user: 'Sarah M.', time: 'vor 2 Std.' },
  { id: 'a5', action: 'Board aktualisiert', target: 'UAP-Chronologie', user: 'Alex K.', time: 'vor 3 Std.' },
  { id: 'a6', action: 'Bericht markiert', target: '22 Millionen Dollar für die Wahrheit', user: 'Franz L.', time: 'vor 4 Std.' },
];

export const entityTypeColors: Record<EntityType, string> = {
  person: 'entity-person',
  organization: 'entity-organization',
  event: 'entity-event',
  location: 'entity-location',
};

export const entityTypeLabels: Record<EntityType, string> = {
  person: 'Person',
  organization: 'Organisation',
  event: 'Ereignis',
  location: 'Ort',
};

// --- Semantic Patterns (Vector-DB driven, NOT keyword matching) ---

export interface SemanticPattern {
  id: string;
  label: string;
  description: string;
  storyIds: string[];
  keywords: string[][]; // per story: the different words used to describe the SAME phenomenon
  vectorSimilarity: number;
}

export const semanticPatterns: SemanticPattern[] = [
  {
    id: 'sp1',
    label: 'Antriebsloses Flugobjekt',
    description: 'Objekte ohne erkennbare Antriebssysteme, die konventionelle Flugeigenschaften überschreiten',
    storyIds: ['s1', 's7', 's10'],
    keywords: [
      ['weißes, ovales Objekt', 'keine Antriebssysteme', '46.000 km/h'],
      ['dreieckige Objekte', 'F-16-Verfolgung', 'Radarerfassung'],
      ['dunkle Würfel in transparenter Kugel', 'ohne sichtbaren Antrieb'],
    ],
    vectorSimilarity: 0.89,
  },
  {
    id: 'sp2',
    label: 'Institutionelle Vertuschung',
    description: 'Offizielle Stellen leugnen oder minimieren UAP-Evidenz trotz interner Belege',
    storyIds: ['s5', 's8', 's9', 's12'],
    keywords: [
      ['geheimes Programm', 'Protest gegen Geheimhaltung'],
      ['unter Eid', 'Bergungsprogramm', 'keine glaubwürdigen Beweise'],
      ['Pentagon zwang', 'FLIR1-Video an die Öffentlichkeit'],
      ['keine empirischen Beweise', 'institutionelle Vertuschung'],
    ],
    vectorSimilarity: 0.86,
  },
  {
    id: 'sp3',
    label: 'Späte Revisionen',
    description: 'Zeugen oder Beteiligte revidieren Aussagen Jahre bis Jahrzehnte nach dem Ereignis',
    storyIds: ['s4', 's11', 's14'],
    keywords: [
      ['verspottete zunächst', 'zehn Jahre später eigene Sichtung'],
      ['Jahrzehnte später', 'weitergehende Behauptungen'],
      ['20 Jahre als stärkster Beweis', 'gestand: aus Styropor gebastelt'],
    ],
    vectorSimilarity: 0.82,
  },
  {
    id: 'sp4',
    label: 'Physische Spurensicherung',
    description: 'Messbare physische Anomalien an mutmaßlichen Sichtungsorten',
    storyIds: ['s2', 's6', 's1'],
    keywords: [
      ['erhöhte Strahlungswerte', 'Eindrücke im Boden'],
      ['Trümmer auf seiner Farm', 'fliegende Untertasse'],
      ['Beschleunigungen von 5.370 g', 'Forward Looking Infrared'],
    ],
    vectorSimilarity: 0.78,
  },
];

// Semantic reasons: precomputed explanations for story-pairs that share a semantic pattern
const semanticReasons: Record<string, string> = {
  's1→s7': 'Beide beschreiben Objekte ohne konventionelle Antriebssysteme — obwohl unterschiedliche Formen (oval vs. dreieckig) und Jahrzehnte auseinander (2004 vs. 1990)',
  's1→s10': 'Militärpiloten beobachten manövrierfähige Objekte ohne Antrieb — unterschiedliche Ozeanregionen (Pazifik vs. Atlantik), unterschiedliche Objektbeschreibungen',
  's7→s10': 'Radarbestätigte Sichtungen unbekannter Flugobjekte durch Militär — verschiedene Länder (Belgien vs. USA), verschiedene Epochen',
  's5→s8': 'Regierungsmitarbeiter berichten über systematische Geheimhaltung von UAP-Untersuchungen — 6 Jahre Abstand, gleiche institutionelle Muster',
  's5→s9': 'Die AATIP-Enthüllung aus zwei Perspektiven — Elizondos Rücktritt und die mediale Aufdeckung als korrespondierende Ereignisse',
  's5→s12': 'Pentagon-Programme unter Verschluss — AATIP 2007-2012 und AARO 2022-2024 zeigen wiederkehrende Muster der Informationskontrolle',
  's8→s9': 'Kongressaussagen und Medienenthüllungen als zwei Seiten derselben Disclosure-Bewegung',
  's8→s12': 'Grusch behauptet Bergungsprogramm, Kirkpatrick bestreitet — direkter institutioneller Widerspruch',
  's9→s12': 'NYT-Enthüllung 2017 als Katalysator für die AARO-Gründung — kausale Verbindung über Vektornähe erkannt',
  's4→s11': 'Beide Fälle zeigen das gleiche Muster: Offizielle Position wird Jahre später vom selben Zeugen revidiert',
  's4→s14': 'Kontrast: Symington revidiert zur Bestätigung, Marechal revidiert zur Widerlegung — gleiches Muster, gegensätzliche Richtung',
  's11→s14': 'Spätere Aussagen stellen Jahrzehnte akzeptierte Narrative in Frage — bei Rendlesham durch Erweiterung, bei Petit-Rechain durch Widerruf',
  's2→s6': 'Physische Spuren an mutmaßlichen UAP-Orten — Strahlungsmessungen (Rendlesham) und Trümmeranalyse (Roswell)',
  's2→s1': 'Militärische Dokumentation physischer Anomalien — Bodenmessungen (Rendlesham) und FLIR-Aufnahmen (Nimitz)',
  's6→s1': 'Physische Evidenz über Jahrzehnte: Metalltrümmer 1947, Infrarot-Aufnahmen 2004 — verschiedene Beweismethoden für ähnliche Phänomene',
};

function getSemanticReason(storyA: string, storyB: string): string | undefined {
  return semanticReasons[`${storyA}→${storyB}`] || semanticReasons[`${storyB}→${storyA}`];
}

function getSharedPatterns(storyA: string, storyB: string): SemanticPattern[] {
  return semanticPatterns.filter(p => p.storyIds.includes(storyA) && p.storyIds.includes(storyB));
}

// Related stories with similarity scores for Story Detail page
export interface RelatedStory {
  story: Story;
  similarity: number;
  sharedEntities: Entity[];
  reason: string;
  semanticReason?: string;
  sharedPatterns?: SemanticPattern[];
}

export function getRelatedStories(storyId: string): RelatedStory[] {
  const story = stories.find(s => s.id === storyId);
  if (!story) return [];

  const related: RelatedStory[] = [];
  const seen = new Set<string>();

  // Phase 1: Semantic pattern matches (highest priority — this is what makes mulder unique)
  for (const pattern of semanticPatterns) {
    if (!pattern.storyIds.includes(storyId)) continue;
    for (const otherId of pattern.storyIds) {
      if (otherId === storyId || seen.has(otherId)) continue;
      seen.add(otherId);
      const other = stories.find(s => s.id === otherId);
      if (!other) continue;
      const shared = story.entities.filter(e => other.entities.some(oe => oe.id === e.id));
      const semReason = getSemanticReason(storyId, otherId);
      const patterns = getSharedPatterns(storyId, otherId);
      related.push({
        story: other,
        similarity: pattern.vectorSimilarity + (shared.length * 0.02),
        sharedEntities: shared,
        reason: shared.length > 0 ? `${shared.length} gemeinsame Akteure` : 'Keine gemeinsamen Akteure',
        semanticReason: semReason,
        sharedPatterns: patterns,
      });
    }
  }

  // Phase 2: Entity-based matches (traditional — for stories not in same pattern)
  for (const other of stories) {
    if (other.id === storyId || seen.has(other.id)) continue;
    const shared = story.entities.filter(e => other.entities.some(oe => oe.id === e.id));
    if (shared.length > 0) {
      related.push({
        story: other,
        similarity: 0.5 + shared.length * 0.08,
        sharedEntities: shared,
        reason: shared.length >= 3
          ? `${shared.length} gemeinsame Akteure`
          : shared.length === 2
          ? 'Mehrere gemeinsame Akteure'
          : `Beide erwähnen ${shared[0].name}`,
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
  const dates = ['1947-07-08', '1980-12-26', '1989-11-29', '1997-03-13', '2004-11-14', '2007-01-01', '2017-12-16', '2023-07-26'];
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
  e1: [{ name: 'Cmdr. Fravor', similarity: 0.94, mentions: 6 }, { name: 'Commander Fravor', similarity: 0.88, mentions: 3 }],
  e3: [{ name: 'L. Elizondo', similarity: 0.95, mentions: 7 }, { name: 'Lue Elizondo', similarity: 0.91, mentions: 4 }],
  e2: [{ name: 'B. Lazar', similarity: 0.93, mentions: 4 }],
};

// Story full text with entity markup for Story Detail page
export const storyFullTexts: Record<string, string> = {
  s1: `Am 14. November 2004 befand sich die Carrier Strike Group Eleven der <entity-organization>US Navy</entity-organization> auf einem Routinemanöver vor der Küste von <entity-location>San Diego</entity-location>, als Radar-Operator <entity-person>Kevin Day</entity-person> auf der USS Princeton anomale Kontakte erfasste.

Seit mehreren Tagen hatte Day Objekte beobachtet, die aus über 24.000 Metern Höhe auf Meereshöhe absanken — in weniger als einer Sekunde. Die Objekte zeigten keine transpondergestützten Identifikationssignale.

Commander <entity-person>David Fravor</entity-person>, Kommandant der VFA-41 „Black Aces", wurde zusammen mit Lt. Cmdr. <entity-person>Alex Dietrich</entity-person> zur Untersuchung geschickt. Was Fravor in seinem F/A-18F Super Hornet vorfand, beschrieb er als ein weißes, ovales Objekt von etwa 12 Metern Länge — ohne Flügel, ohne Rotoren, ohne sichtbare Antriebssysteme.

„Es beschleunigte wie nichts, was ich je gesehen habe", sagte Fravor. „Und ich fliege seit 18 Jahren." Das Objekt tauchte Sekunden später am geheimen CAP-Punkt der Piloten wieder auf — 100 Kilometer entfernt.

Lt. Cmdr. Chad Underwood, der wenig später mit einer neuen F/A-18 aufstieg, zeichnete das Objekt mit dem Forward Looking Infrared-System auf. Diese Aufnahme wurde als <entity-event>FLIR1-Video</entity-event> bekannt und 2017 von der <entity-organization>New York Times</entity-organization> veröffentlicht.

Eine wissenschaftliche Analyse von Kevin Knuth et al., veröffentlicht 2019 im Fachjournal Entropy, errechnete Beschleunigungen von bis zu 5.370 g und Spitzengeschwindigkeiten von etwa 75.000 km/h. Kein bekanntes Fluggerät ist zu solchen Manövern fähig.

Das <entity-organization>Pentagon</entity-organization> bestätigte 2020 offiziell die Echtheit des Videos. Bis heute hat weder die <entity-organization>US Navy</entity-organization> noch das <entity-organization>AATIP</entity-organization>-Nachfolgeprogramm <entity-organization>AARO</entity-organization> eine konventionelle Erklärung für den <entity-event>USS Nimitz Encounter</entity-event> vorgelegt.`,
};

export const reviewText = `Am 14. November 2004 befand sich die <entity-organization>US Navy</entity-organization> Carrier Strike Group Eleven auf einem Routinemanöver vor der Küste von San Diego, als anomale Radarkontakte erfasst wurden.

Commander <entity-person>David Fravor</entity-person>, Kommandant der VFA-41 „Black Aces", wurde zusammen mit Lt. Cmdr. <entity-person>Alex Dietrich</entity-person> zur Untersuchung geschickt. Das Objekt — weiß, oval, etwa 12 Meter lang — hatte keine Flügel, keine Rotoren, keine sichtbaren Antriebssysteme.

Es beschleunigte innerhalb von Sekunden auf geschätzte 46.000 km/h und tauchte am geheimen CAP-Punkt der Piloten wieder auf, 100 Kilometer entfernt. Radar-Operator <entity-person>Kevin Day</entity-person> auf der USS Princeton hatte die Objekte bereits seit Tagen verfolgt.

Das <entity-organization>Pentagon</entity-organization> bestätigte 2020 offiziell die Echtheit des FLIR1-Videos. Die <entity-organization>AATIP</entity-organization>-Nachfolgeorganisation <entity-organization>AARO</entity-organization> konnte keine konventionelle Erklärung vorlegen.`;

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
  storyAId: string;
  storyBId: string;
  entity: Entity;
  status: ContradictionStatus;
  geminiAnalysis: string;
}

export const contradictions: Contradiction[] = [
  {
    id: 'c1',
    claimA: 'Lt. Col. Halt beschrieb in seinem offiziellen Memo vom 13. Januar 1981 „unerklärliche Lichter" und Eindrücke im Boden — erwähnt keinen physischen Kontakt mit einem Objekt.',
    claimB: 'Jim Penniston behauptete ab 2010, er habe das Objekt berührt, Symbole auf der Hülle abgezeichnet und 16 Seiten Binärcode telepathisch empfangen.',
    sourceA: 'MoD Rendlesham Files 1981, S. 1–18',
    sourceB: 'Der Spiegel 47/2017, S. 106–112',
    storyA: 'Die Nächte von Rendlesham Forest',
    storyB: 'Die Halt-Memo: Warum ein Offizier sein Schweigen brach',
    storyAId: 's2',
    storyBId: 's11',
    entity: entities[4],
    status: 'CONFIRMED',
    geminiAnalysis: 'Der Widerspruch ist gravierend: Pennistons zeitgenössische schriftliche Aussage von 1980 an das AFOSI erwähnt weder eine Berührung des Objekts noch Binärcode. John Burroughs, der wenige Meter entfernt stand, bestätigte, dass Penniston kein Notizbuch führte. Die Binärcode-Behauptung tauchte erst 30 Jahre nach dem Vorfall auf. Colonel Ted Conrad, der damalige Kommandant, erklärte 2010: Penniston habe bei den ursprünglichen Befragungen nie von einer Berührung eines Raumfahrzeugs gesprochen.',
  },
  {
    id: 'c2',
    claimA: 'Bob Lazar behauptet, Masterabschlüsse vom Massachusetts Institute of Technology und vom California Institute of Technology zu besitzen.',
    claimB: 'Investigative Recherchen ergaben: Weder MIT noch Caltech führen Aufzeichnungen über einen Studenten namens Robert Lazar. Kein Professor oder Kommilitone konnte ihn identifizieren.',
    sourceA: 'Magazin 2000 Ausgabe 395, S. 14–28',
    sourceB: 'GEP Journal 02/2020, S. 22–28',
    storyA: 'Bob Lazars Element 115: Genie oder Schwindler?',
    storyB: 'Der Absturz von Roswell: Was wirklich geschah',
    storyAId: 's3',
    storyBId: 's6',
    entity: entities[1],
    status: 'CONFIRMED',
    geminiAnalysis: 'Lazars Bildungsangaben sind zentral für seine Glaubwürdigkeit. Während er nachweislich am Los Alamos National Laboratory arbeitete (Telefonbucheintrag bestätigt), konnten weder Journalisten noch Forscher seine MIT/Caltech-Abschlüsse verifizieren. Lazar selbst behauptet, seine Unterlagen seien von der Regierung gelöscht worden. Die Tatsache, dass Element 115 (Moscovium) 2003 tatsächlich synthetisiert wurde, wird von Unterstützern als Bestätigung gewertet, von Kritikern als Zufall.',
  },
  {
    id: 'c3',
    claimA: 'Governor Fife Symington hielt am 19. Juni 1997 eine Pressekonferenz ab, bei der ein Mitarbeiter im Alien-Kostüm auftrat. Symington bezeichnete die Sichtungsberichte als unbegründet.',
    claimB: 'Im Jahr 2007 gab Symington öffentlich zu, die Lichter selbst gesehen zu haben, und beschrieb das Objekt als „überirdisch" und größer als alles, was er als Pilot je gesehen habe.',
    sourceA: 'MUFON UFO Journal 03/2017, S. 28–38',
    sourceB: 'MUFON UFO Journal 03/2017, S. 28–38',
    storyA: 'Phoenix Lights: Die Nacht, in der Arizona den Atem anhielt',
    storyB: 'Phoenix Lights: Die Nacht, in der Arizona den Atem anhielt',
    storyAId: 's4',
    storyBId: 's4',
    entity: entities[7],
    status: 'CONFIRMED',
    geminiAnalysis: 'Der Widerspruch ist dokumentiert und von Symington selbst bestätigt. Er erklärte 2007, er habe die Sichtungen 1997 heruntergespielt, um eine Massenpanik zu vermeiden. Als Pilot und ehemaliger Air-Force-Offizier sei ihm sofort klar gewesen, dass das Objekt keinem ihm bekannten Fluggerät entsprach. Die zehn Jahre Verzögerung bei seinem Eingeständnis wirft Fragen über politische Motivation auf.',
  },
  {
    id: 'c4',
    claimA: 'Die Roswell Army Air Field gab am 8. Juli 1947 eine Pressemitteilung heraus: Man habe eine „fliegende Untertasse" geborgen.',
    claimB: 'Am selben Nachmittag korrigierte General Roger Ramey bei einer Pressekonferenz in Fort Worth: Es handele sich um einen gewöhnlichen Wetterballon.',
    sourceA: 'GEP Journal 02/2020, S. 4–18',
    sourceB: 'GEP Journal 02/2020, S. 4–18',
    storyA: 'Der Absturz von Roswell: Was wirklich geschah',
    storyB: 'Der Absturz von Roswell: Was wirklich geschah',
    storyAId: 's6',
    storyBId: 's6',
    entity: entities[23],
    status: 'DISMISSED',
    geminiAnalysis: 'Nach Analyse beider Darstellungen ergibt sich kein inhaltlicher Widerspruch im engeren Sinne: Die USAF erklärte 1994 offiziell, der „Wetterballon" sei selbst eine Coverstory gewesen — die tatsächliche Quelle der Trümmer war das klassifizierte Project Mogul, ein Höhenballonprogramm zur Erkennung sowjetischer Atomtests. Die Materialien (Alufolie, Gummireste, Holzstäbe mit bedrucktem Klebeband) entsprechen Mogul-Ausrüstung. Abgewiesen als sukzessive Aufklärung, nicht als Widerspruch.',
  },
  {
    id: 'c5',
    claimA: 'Luis Elizondo leitete das AATIP-Programm und trat 2017 unter Protest gegen übermäßige Geheimhaltung zurück.',
    claimB: 'Ein Pentagon-Sprecher erklärte, Elizondo habe „keine Verantwortlichkeiten in Bezug auf das AATIP-Programm" gehabt. Garry Reid schrieb in einem Memo, Elizondo habe seine Rolle übertrieben.',
    sourceA: 'Die ZEIT 51/2017, S. 12–20',
    sourceB: 'FAZ Wochenendbeilage Jan 2024, S. 2–10',
    storyA: 'Die Enthüllung: Wie die New York Times das Pentagon zwang',
    storyB: 'AARO vs. die Whistleblower',
    storyAId: 's9',
    storyBId: 's12',
    entity: entities[2],
    status: 'POTENTIAL',
    geminiAnalysis: 'Dieser Widerspruch betrifft einen Kernaspekt der AATIP-Geschichte. Senator Harry Reid bestätigte 2021 in einem Brief an NBC Elizondos Leitungsrolle. Pentagon-Sprecherin Dana White hatte seine Rolle 2017 gegenüber Politico zunächst ebenfalls bestätigt, bevor das Pentagon die Aussage revidierte. Die wechselnden Stellungnahmen des Pentagon selbst erschweren eine eindeutige Bewertung. Empfehlung: Abgleich mit Congressional Record-Unterlagen.',
  },
  {
    id: 'c6',
    claimA: 'Das Tic-Tac-Objekt zeigte keine sichtbaren Antriebssysteme und erzeugte keinen Infrarot-Abgasstrahl.',
    claimB: 'Skeptiker Mick West argumentiert, das FLIR1-Video zeige ein weit entferntes, defokussiertes Flugzeug mit Infrarot-Blendung, nicht ein unbekanntes Objekt.',
    sourceA: 'MUFON UFO Journal 03/2017, S. 12–24',
    sourceB: 'Bild der Wissenschaft 02/2018, S. 32–38',
    storyA: 'Das Tic-Tac-Objekt über dem Pazifik',
    storyB: 'Das Petit-Rechain-Foto: Anatomie einer Fälschung',
    storyAId: 's1',
    storyBId: 's14',
    entity: entities[0],
    status: 'POTENTIAL',
    geminiAnalysis: 'Die Debatte dreht sich um die Interpretation technischer Daten. Fravor, Dietrich und Underwood bestehen darauf, das Objekt visuell aus nächster Nähe beobachtet zu haben — eine Kamera-Anomalie kann die visuelle Beobachtung durch erfahrene Navy-Piloten nicht erklären. Allerdings hat das Pentagon die im FLIR1-Video gezeigten Flugeigenschaften weder bestätigt noch dementiert. Eine abschließende Bewertung erfordert Zugang zu den vollständigen Radardaten der USS Princeton.',
  },
  {
    id: 'c7',
    claimA: 'Die SOBEPS dokumentierte 9 Radarerfassungen unbekannter Objekte durch F-16-Kampfjets am 30. März 1990.',
    claimB: 'Die belgische Luftwaffe stellte fest, dass alle drei tatsächlich erzielten Radarerfassungen auf die jeweils andere F-16 gerichtet waren — die Flugzeuge hatten sich gegenseitig erfasst. Andere Radarsignale wurden atmosphärischer Bragg-Streuung zugeschrieben.',
    sourceA: 'SOBEPS Bulletin 04/1990, S. 1–28',
    sourceB: 'Bild der Wissenschaft 02/2018, S. 32–38',
    storyA: 'Belgiens schwarze Dreiecke: Die SOBEPS-Akten',
    storyB: 'Das Petit-Rechain-Foto: Anatomie einer Fälschung',
    storyAId: 's7',
    storyBId: 's14',
    entity: entities[17],
    status: 'CONFIRMED',
    geminiAnalysis: 'Die Nachanalyse der belgischen Luftwaffe ist gut dokumentiert: General Wilfried De Brouwer bestätigte, dass die Radarergebnisse nicht so eindeutig waren, wie die SOBEPS zunächst behauptete. Die Diskrepanz zwischen den 9 von SOBEPS behaupteten Erfassungen und den 3 bestätigten Locks (die auf die F-16 selbst zurückgingen) ist ein wesentlicher Widerspruch. Bodenzeugen berichteten zwar von dramatischen Manövern, doch keiner der F-16-Piloten sah ein unbekanntes Objekt.',
  },
  {
    id: 'c8',
    claimA: 'David Grusch sagt unter Eid aus, dass die US-Regierung über ein jahrzehntelanges Bergungsprogramm für nicht-menschliche Fahrzeuge und biologische Überreste verfüge.',
    claimB: 'AARO-Direktor Sean Kirkpatrick erklärte in Scientific American, die Behauptungen stammten von „einer kleinen Gruppe miteinander verbundener Gläubiger" und seien auf versehentliche Enthüllungen legitimer US-Programme zurückzuführen.',
    sourceA: 'Congressional Record Juli 2023, S. 44–62',
    sourceB: 'FAZ Wochenendbeilage Jan 2024, S. 2–10',
    storyA: 'David Gruschs Aussage: „Nicht-menschliche Intelligenz"',
    storyB: 'AARO vs. die Whistleblower',
    storyAId: 's8',
    storyBId: 's12',
    entity: entities[6],
    status: 'POTENTIAL',
    geminiAnalysis: 'Der zentrale Widerspruch der aktuellen UAP-Debatte. Grusch betonte, seine Aussage basiere auf Interviews mit über 40 Zeugen über vier Jahre — er selbst habe jedoch keine außerirdischen Fahrzeuge oder Überreste persönlich gesehen. Kirkpatricks AARO-Bericht von 2024 fand „keine empirischen Beweise". General Mark Milley erklärte ebenfalls, er sei nie auf unterstützende Beweise gestoßen. Die Tatsache, dass NYT, Washington Post und Politico Gruschs Behauptungen zunächst nicht veröffentlichen wollten, deutet auf Vorbehalte bei der Verifizierung hin.',
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
    claim: 'Das Tic-Tac-Objekt zeigte keine sichtbaren Antriebssysteme und führte Manöver aus, die bekannte Physik überschreiten.',
    entity: entities[22],
    independentSourceCount: 4,
    corroborationScore: 0.94,
    sourceReliability: 0.92,
    evidenceChainStrength: 0.89,
    sources: [
      { name: 'MUFON UFO Journal', reliability: 0.90, storyTitle: 'Das Tic-Tac-Objekt über dem Pazifik' },
      { name: 'Die ZEIT', reliability: 0.93, storyTitle: 'Die Enthüllung: Wie die New York Times das Pentagon zwang' },
      { name: 'Pentagon (offiziell)', reliability: 0.98, storyTitle: 'Videobestätigung April 2020' },
      { name: 'Entropy (peer-reviewed)', reliability: 0.95, storyTitle: 'Knuth et al., Flugcharakteristik-Analyse 2019' },
    ],
  },
  {
    id: 'cor2',
    claim: 'Das AATIP-Programm existierte und untersuchte UAP-Phänomene mit Pentagon-Budget.',
    entity: entities[14],
    independentSourceCount: 4,
    corroborationScore: 0.96,
    sourceReliability: 0.95,
    evidenceChainStrength: 0.93,
    sources: [
      { name: 'New York Times', reliability: 0.96, storyTitle: 'NYT-Enthüllung Dezember 2017' },
      { name: 'Die ZEIT', reliability: 0.93, storyTitle: '22 Millionen Dollar für die Wahrheit' },
      { name: 'Senator Harry Reid', reliability: 0.90, storyTitle: 'Offizielle Bestätigung 2021' },
      { name: 'Pentagon', reliability: 0.95, storyTitle: 'Pentagon-Bestätigung gegenüber Politico 2017' },
    ],
  },
  {
    id: 'cor3',
    claim: 'Die Phoenix Lights erstreckten sich über eine V-Formation von geschätzt 1,6 km Breite und wurden von Tausenden unabhängigen Zeugen beobachtet.',
    entity: entities[21],
    independentSourceCount: 3,
    corroborationScore: 0.91,
    sourceReliability: 0.88,
    evidenceChainStrength: 0.85,
    sources: [
      { name: 'MUFON UFO Journal', reliability: 0.90, storyTitle: 'Phoenix Lights: Die Nacht, in der Arizona den Atem anhielt' },
      { name: 'USA Today', reliability: 0.88, storyTitle: 'Augenzeugenberichte Juni 1997' },
      { name: 'Governor Symington', reliability: 0.85, storyTitle: 'Persönliches Eingeständnis 2007' },
    ],
  },
  {
    id: 'cor4',
    claim: 'Am mutmaßlichen Landeplatz im Rendlesham Forest wurden erhöhte Strahlungswerte gemessen.',
    entity: entities[20],
    independentSourceCount: 2,
    corroborationScore: 0.79,
    sourceReliability: 0.87,
    evidenceChainStrength: 0.74,
    sources: [
      { name: 'MoD Rendlesham Files', reliability: 0.92, storyTitle: 'Die Nächte von Rendlesham Forest' },
      { name: 'Der Spiegel', reliability: 0.85, storyTitle: 'Die Halt-Memo: Warum ein Offizier sein Schweigen brach' },
    ],
  },
  {
    id: 'cor5',
    claim: 'Bob Lazar arbeitete nachweislich am Los Alamos National Laboratory.',
    entity: entities[1],
    independentSourceCount: 2,
    corroborationScore: 0.82,
    sourceReliability: 0.84,
    evidenceChainStrength: 0.78,
    sources: [
      { name: 'Telefonbuch Los Alamos', reliability: 0.95, storyTitle: 'Eintrag im Mitarbeiterverzeichnis' },
      { name: 'Reporter George Knapp', reliability: 0.75, storyTitle: 'Investigative Verifizierung KLAS-TV' },
    ],
  },
  {
    id: 'cor6',
    claim: 'USS Roosevelt-Piloten berichteten nahezu tägliche UAP-Sichtungen über mehrere Monate hinweg.',
    entity: entities[5],
    independentSourceCount: 3,
    corroborationScore: 0.88,
    sourceReliability: 0.91,
    evidenceChainStrength: 0.84,
    sources: [
      { name: 'MUFON UFO Journal', reliability: 0.90, storyTitle: 'USS Roosevelt: Tägliche Begegnungen über dem Atlantik' },
      { name: 'Lt. Ryan Graves', reliability: 0.92, storyTitle: 'Aussage vor dem Kongress 2023' },
      { name: 'US Navy HAZREP', reliability: 0.95, storyTitle: 'Offizielle Gefahrenmeldung 2014' },
    ],
  },
  {
    id: 'cor7',
    claim: 'Die Roswell-Pressemitteilung vom 8. Juli 1947 sprach explizit von einer „fliegenden Untertasse".',
    entity: entities[23],
    independentSourceCount: 3,
    corroborationScore: 0.95,
    sourceReliability: 0.93,
    evidenceChainStrength: 0.91,
    sources: [
      { name: 'GEP Journal', reliability: 0.90, storyTitle: 'Der Absturz von Roswell: Was wirklich geschah' },
      { name: 'Roswell Daily Record', reliability: 0.98, storyTitle: 'Originalausgabe 8. Juli 1947' },
      { name: 'Lt. Walter Haut', reliability: 0.88, storyTitle: 'Verfasser der Pressemitteilung' },
    ],
  },
  {
    id: 'cor8',
    claim: 'David Grusch reichte eine offizielle Whistleblower-Beschwerde beim Intelligence Community Inspector General ein.',
    entity: entities[6],
    independentSourceCount: 2,
    corroborationScore: 0.85,
    sourceReliability: 0.90,
    evidenceChainStrength: 0.82,
    sources: [
      { name: 'Congressional Record', reliability: 0.95, storyTitle: 'David Gruschs Aussage: „Nicht-menschliche Intelligenz"' },
      { name: 'IC Inspector General', reliability: 0.92, storyTitle: 'Bestätigung der Beschwerdeannahme 2022' },
    ],
  },
  {
    id: 'cor9',
    claim: 'Das Petit-Rechain-Foto der belgischen UFO-Welle war eine Fälschung.',
    entity: entities[24],
    independentSourceCount: 1,
    corroborationScore: 0.98,
    sourceReliability: 0.99,
    evidenceChainStrength: 0.97,
    sources: [
      { name: 'RTL-TVI', reliability: 0.99, storyTitle: 'Patrick Marechals Geständnis, 26. Juli 2011' },
    ],
  },
  {
    id: 'cor10',
    claim: 'Senator Harry Reid initiierte das AATIP-Programm mit Unterstützung der Senatoren Ted Stevens und Daniel Inouye.',
    entity: entities[9],
    independentSourceCount: 2,
    corroborationScore: 0.90,
    sourceReliability: 0.92,
    evidenceChainStrength: 0.87,
    sources: [
      { name: 'Die ZEIT', reliability: 0.93, storyTitle: '22 Millionen Dollar für die Wahrheit' },
      { name: 'New York Times', reliability: 0.96, storyTitle: 'Glowing Auras and Black Money, Dez 2017' },
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
    title: 'Roswell-Absturz',
    timestamp: '1947-07-08',
    location: 'Roswell, New Mexico',
    lat: 33.39,
    lng: -104.52,
    entities: [entities[8], entities[23], entities[30]],
    entityType: 'event',
    description: 'Rancher Mac Brazel entdeckt Trümmer. RAAF gibt Pressemitteilung über „fliegende Untertasse" heraus, korrigiert am selben Tag auf „Wetterballon".',
    clusterId: 'tc1',
  },
  {
    id: 'ste2',
    title: 'Rendlesham Forest — Nacht 1',
    timestamp: '1980-12-26',
    location: 'Rendlesham Forest, Suffolk',
    lat: 52.08,
    lng: 1.43,
    entities: [entities[4], entities[20], entities[28]],
    entityType: 'event',
    description: 'US-Sicherheitspatrouille beobachtet Lichter im Wald nahe RAF Woodbridge. SSgt. Penniston und A1C Burroughs nähern sich dem Objekt.',
    clusterId: 'tc2',
  },
  {
    id: 'ste3',
    title: 'Rendlesham Forest — Nacht 2',
    timestamp: '1980-12-28',
    location: 'Rendlesham Forest, Suffolk',
    lat: 52.08,
    lng: 1.43,
    entities: [entities[3], entities[20], entities[28]],
    entityType: 'event',
    description: 'Lt. Col. Halt führt Untersuchungsteam in den Wald. Erstellt Audioaufnahme und misst erhöhte Strahlungswerte.',
    clusterId: 'tc2',
  },
  {
    id: 'ste4',
    title: 'Bob Lazar geht an die Öffentlichkeit',
    timestamp: '1989-05-01',
    location: 'Area 51, Nevada',
    lat: 37.24,
    lng: -115.81,
    entities: [entities[1], entities[27]],
    entityType: 'person',
    description: 'Bob Lazar behauptet in einem Interview mit Reporter George Knapp, am S-4-Komplex bei Area 51 an außerirdischer Technologie gearbeitet zu haben.',
    clusterId: 'tc2',
  },
  {
    id: 'ste5',
    title: 'Belgische UFO-Welle beginnt',
    timestamp: '1989-11-29',
    location: 'Eupen, Belgien',
    lat: 50.63,
    lng: 6.04,
    entities: [entities[17], entities[24], entities[31]],
    entityType: 'event',
    description: 'Zwei Gendarmen beobachten ein großes dreieckiges Objekt bei Eupen. Beginn einer Welle von über 2.600 Sichtungsberichten.',
    clusterId: 'tc2',
  },
  {
    id: 'ste6',
    title: 'F-16-Verfolgung über Belgien',
    timestamp: '1990-03-30',
    location: 'Beauvechain, Belgien',
    lat: 50.76,
    lng: 4.77,
    entities: [entities[17], entities[24]],
    entityType: 'event',
    description: 'Zwei F-16 der belgischen Luftwaffe starten zur Verfolgung. Neun Abfangversuche über eine Stunde. Radarerfassungen später als gegenseitige Locks identifiziert.',
    clusterId: 'tc2',
  },
  {
    id: 'ste7',
    title: 'Phoenix Lights Sichtung',
    timestamp: '1997-03-13',
    location: 'Phoenix, Arizona',
    lat: 33.45,
    lng: -112.07,
    entities: [entities[7], entities[21], entities[29]],
    entityType: 'event',
    description: 'Tausende Einwohner Arizonas beobachten eine massive V-Formation über Phoenix. Militär erklärt Leuchtkugeln auf dem Goldwater-Übungsgelände.',
    clusterId: 'tc3',
  },
  {
    id: 'ste8',
    title: 'USS Nimitz Encounter',
    timestamp: '2004-11-14',
    location: 'Pazifik vor San Diego',
    lat: 31.33,
    lng: -117.17,
    entities: [entities[0], entities[10], entities[11], entities[16], entities[22]],
    entityType: 'event',
    description: 'Commander Fravor beobachtet das Tic-Tac-Objekt über aufgewühltem Wasser. Lt. Cmdr. Underwood zeichnet FLIR1-Video auf.',
    clusterId: 'tc3',
  },
  {
    id: 'ste9',
    title: 'AATIP-Programm gegründet',
    timestamp: '2007-01-01',
    location: 'Washington D.C.',
    lat: 38.87,
    lng: -77.06,
    entities: [entities[9], entities[14], entities[13], entities[32]],
    entityType: 'organization',
    description: 'Senator Harry Reid initiiert das AATIP mit $22 Mio. Budget. Robert Bigelows BAASS erhält den Hauptauftrag.',
    clusterId: 'tc3',
  },
  {
    id: 'ste10',
    title: 'USS Roosevelt — Gimbal-Video',
    timestamp: '2015-01-20',
    location: 'Atlantik vor Jacksonville',
    lat: 30.50,
    lng: -79.50,
    entities: [entities[5], entities[16]],
    entityType: 'event',
    description: 'Gimbal-Video zeigt ein rotierendes Objekt. Aufgezeichnet durch VFA-11 „Red Rippers" während COMPTUEX-Übung.',
    clusterId: 'tc3',
  },
  {
    id: 'ste11',
    title: 'NYT enthüllt AATIP-Programm',
    timestamp: '2017-12-16',
    location: 'New York',
    lat: 40.71,
    lng: -74.01,
    entities: [entities[2], entities[14], entities[26]],
    entityType: 'event',
    description: 'Die New York Times veröffentlicht „Glowing Auras and Black Money" und enthüllt das geheime Pentagon-UAP-Programm.',
    clusterId: 'tc4',
  },
  {
    id: 'ste12',
    title: 'Pentagon bestätigt UAP-Videos',
    timestamp: '2020-04-27',
    location: 'Washington D.C.',
    lat: 38.87,
    lng: -77.06,
    entities: [entities[13], entities[16]],
    entityType: 'organization',
    description: 'Das Pentagon veröffentlicht offiziell die Videos FLIR1, Gimbal und GoFast und bestätigt deren Echtheit.',
    clusterId: 'tc4',
  },
  {
    id: 'ste13',
    title: 'Senate UAP Hearing',
    timestamp: '2023-07-26',
    location: 'Washington D.C.',
    lat: 38.87,
    lng: -77.06,
    entities: [entities[6], entities[0], entities[5], entities[25], entities[32]],
    entityType: 'event',
    description: 'David Grusch, David Fravor und Ryan Graves sagen vor dem House Oversight Committee aus.',
    clusterId: 'tc4',
  },
  {
    id: 'ste14',
    title: 'AARO-Bericht widerspricht Whistleblowern',
    timestamp: '2024-03-01',
    location: 'Washington D.C.',
    lat: 38.87,
    lng: -77.06,
    entities: [entities[12], entities[15], entities[13]],
    entityType: 'organization',
    description: 'AAROs historischer Bericht findet „keine empirischen Beweise" für außerirdische Technologie. Kirkpatrick schreibt Op-Ed in Scientific American.',
    clusterId: 'tc4',
  },
  {
    id: 'ste15',
    title: 'Petit-Rechain-Geständnis',
    timestamp: '2011-07-26',
    location: 'Brüssel, Belgien',
    lat: 50.85,
    lng: 4.35,
    entities: [entities[17], entities[24]],
    entityType: 'event',
    description: 'Patrick Marechal gesteht auf RTL-TVI, das berühmte Dreiecksfoto aus Styropor und Glühbirnen gefälscht zu haben.',
    clusterId: 'tc3',
  },
];

export const temporalClusters: TemporalCluster[] = [
  {
    id: 'tc1',
    label: 'Nachkriegs-Ära',
    startDate: '1947-01-01',
    endDate: '1952-12-31',
    eventCount: 1,
    description: 'Roswell-Absturz und die ersten Blue-Book-Fälle markieren den Beginn der modernen UFO-Ära.',
  },
  {
    id: 'tc2',
    label: 'Cold-War-Sichtungen',
    startDate: '1980-01-01',
    endDate: '1991-12-31',
    eventCount: 5,
    description: 'Rendlesham Forest, Bob Lazar und die belgische UFO-Welle — die prägenden Fälle des Kalten Krieges.',
  },
  {
    id: 'tc3',
    label: 'Moderne Militär-Sichtungen',
    startDate: '1997-01-01',
    endDate: '2015-12-31',
    eventCount: 5,
    description: 'Phoenix Lights, USS Nimitz, USS Roosevelt — Militärpiloten werden zu den glaubwürdigsten Zeugen.',
  },
  {
    id: 'tc4',
    label: 'Disclosure-Bewegung',
    startDate: '2017-01-01',
    endDate: '2024-12-31',
    eventCount: 4,
    description: 'NYT-Enthüllung, Pentagon-Bestätigung und Congressional Hearings bringen UAPs in den politischen Mainstream.',
  },
];
