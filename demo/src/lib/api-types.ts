export type UserRole = 'owner' | 'admin' | 'member';

export interface UserSummary {
  id: string;
  email: string;
  role: UserRole;
}

export interface SessionPayload {
  user: UserSummary;
  expires_at: string;
}

export interface SessionResponse {
  data: SessionPayload;
}

export interface DocumentRecord {
  id: string;
  filename: string;
  status: 'ingested' | 'extracted' | 'segmented' | 'enriched' | 'embedded' | 'graphed' | 'analyzed';
  page_count: number | null;
  has_native_text: boolean;
  layout_available: boolean;
  page_image_count: number;
  created_at: string;
  updated_at: string;
  links: { pdf: string; layout: string; pages: string };
}

export interface DocumentListResponse {
  data: DocumentRecord[];
  meta: { count: number; limit: number; offset: number };
}

export interface DocumentPagesResponse {
  data: {
    source_id: string;
    pages: {
      page_number: number;
      image_url: string;
    }[];
  };
  meta: { count: number };
}

export interface DocumentObservabilityResponse {
  data: {
    source: {
      id: string;
      filename: string;
      status: DocumentRecord['status'];
      page_count: number | null;
    };
    stories: {
      id: string;
      title: string;
      status: string;
      page_start: number | null;
      page_end: number | null;
      projection: {
        status: string | null;
        enriched_at: string | null;
        embedded_at: string | null;
        graphed_at: string | null;
        entities_extracted: number | null;
        chunks_created: number | null;
      } | null;
    }[];
  };
}

export interface EntityRecord {
  id: string;
  canonical_id: string | null;
  name: string;
  type: string;
  taxonomy_status: 'auto' | 'curated' | 'merged';
  taxonomy_id: string | null;
  corroboration_score: number | null;
  corroboration_status: 'scored' | 'not_scored' | 'insufficient_data';
  source_count: number;
  attributes: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface EntityAlias {
  id: string;
  entity_id: string;
  alias: string;
  source: string | null;
}

export interface EntityDetailResponse {
  data: {
    entity: EntityRecord;
    aliases: EntityAlias[];
    stories: {
      id: string;
      source_id: string;
      title: string;
      status: string;
      confidence: number | null;
      mention_count: number;
    }[];
    merged_entities: EntityRecord[];
  };
}

export interface EntityListResponse {
  data: EntityRecord[];
  meta: { count: number; limit: number; offset: number };
}

export interface EntityEdge {
  id: string;
  source_entity_id: string;
  target_entity_id: string;
  relationship: string;
  edge_type: 'RELATIONSHIP' | 'DUPLICATE_OF' | 'POTENTIAL_CONTRADICTION' | 'CONFIRMED_CONTRADICTION' | 'DISMISSED_CONTRADICTION';
  confidence: number | null;
  story_id: string | null;
  attributes: Record<string, unknown>;
}

export interface EntityEdgesResponse {
  data: EntityEdge[];
}

export interface EvidenceSummary {
  data: {
    entities: {
      total: number;
      scored: number;
      avg_corroboration: number | null;
      corroboration_status: 'scored' | 'not_scored' | 'insufficient_data';
    };
    contradictions: { potential: number; confirmed: number; dismissed: number };
    duplicates: { count: number };
    sources: { total: number; scored: number; data_reliability: 'insufficient' | 'low' | 'moderate' | 'high' };
    evidence_chains: { thesis_count: number; record_count: number };
    clusters: { count: number };
  };
}

export interface ContradictionRecord {
  id: string;
  source_entity_id: string;
  target_entity_id: string;
  relationship: string;
  edge_type: 'POTENTIAL_CONTRADICTION' | 'CONFIRMED_CONTRADICTION' | 'DISMISSED_CONTRADICTION';
  story_id: string | null;
  confidence: number | null;
  attributes: { attribute: string; valueA: string; valueB: string };
  analysis: {
    verdict: 'confirmed' | 'dismissed';
    winning_claim: 'A' | 'B' | 'neither';
    confidence: number;
    explanation: string;
  } | null;
}

export interface ContradictionsResponse {
  data: ContradictionRecord[];
}

export interface StoryRecord {
  id: string;
  title: string;
  subtitle: string | null;
  language: string | null;
  category: string | null;
  confidence: number | null;
  pageStart: number | null;
  pageEnd: number | null;
  markdown: string;
  excerpt: string;
  entities: EntityRecord[];
  status: string | null;
}
