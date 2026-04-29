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

export interface InvitationResponse {
  data: {
    id: string;
    email: string;
    role: UserRole;
    expires_at: string;
  };
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
  meta?: { count: number; limit: number; offset: number; status: 'potential' | 'confirmed' | 'dismissed' | 'all' };
}

export interface DocumentStoryRecord {
  id: string;
  source_id: string;
  title: string;
  subtitle: string | null;
  language: string | null;
  category: string | null;
  page_start: number | null;
  page_end: number | null;
  extraction_confidence: number | null;
  status: string;
  markdown: string;
  excerpt: string;
  entities: EntityRecord[];
}

export interface DocumentStoriesResponse {
  data: {
    source_id: string;
    stories: DocumentStoryRecord[];
  };
  meta: { count: number };
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

export interface StatusResponse {
  data: {
    budget: {
      month: string;
      limit_usd: number;
      reserved_usd: number;
      committed_usd: number;
      released_usd: number;
      remaining_usd: number;
    };
    jobs: {
      pending: number;
      running: number;
      completed: number;
      failed: number;
      dead_letter: number;
    };
  };
}

export type JobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'dead_letter';

export interface JobSummary {
  id: string;
  type: string;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  worker_id: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  links: { self: string };
}

export interface JobListResponse {
  data: JobSummary[];
  meta: { count: number; limit: number };
}

export interface JobDetailResponse {
  data: {
    job: JobSummary & {
      error_log: string | null;
      payload: Record<string, unknown>;
    };
    progress: {
      run_id: string;
      run_status: 'running' | 'completed' | 'partial' | 'failed';
      source_counts: { pending: number; processing: number; completed: number; failed: number };
      sources: {
        source_id: string;
        current_step: string;
        status: 'pending' | 'processing' | 'completed' | 'failed';
        error_message: string | null;
        updated_at: string;
      }[];
    } | null;
  };
}

export interface InitiateUploadResponse {
  data: {
    source_id: string;
    storage_path: string;
    upload: {
      url: string;
      method: 'PUT';
      headers: Record<string, string>;
      transport: string;
      expires_at: string;
    };
    limits: { max_bytes: number };
  };
}

export interface CompleteUploadResponse {
  data: {
    job_id: string;
    status: 'pending';
    source_id: string;
  };
  links: { status: string };
}

export interface SearchResponse {
  data: {
    query: string;
    strategy: 'vector' | 'fulltext' | 'graph' | 'hybrid';
    top_k: number;
    results: SearchResult[];
    confidence: {
      corpus_size: number;
      taxonomy_status: 'not_started' | 'bootstrapping' | 'active' | 'mature';
      corroboration_reliability: 'insufficient' | 'low' | 'moderate' | 'high';
      graph_density: number;
      degraded: boolean;
      message: string | null;
    };
    explain: {
      counts: Record<string, number>;
      skipped: string[];
      failures: Record<string, string>;
      seed_entity_ids: string[];
      contributions: {
        chunk_id: string;
        rerank_score: number;
        rrf_score: number;
        strategies: { strategy: 'vector' | 'fulltext' | 'graph'; rank: number; score: number }[];
      }[];
    };
  };
}

export interface SearchResult {
  chunk_id: string;
  story_id: string;
  content: string;
  score: number;
  rerank_score: number;
  rank: number;
  contributions: { strategy: 'vector' | 'fulltext' | 'graph'; rank: number; score: number }[];
  metadata: {
    source_id?: string;
    source_filename?: string;
    story_title?: string;
    page_start?: number;
    page_end?: number;
    [key: string]: unknown;
  };
}

export interface EvidenceReliabilitySourcesResponse {
  data: {
    id: string;
    filename: string;
    status: string;
    reliability_score: number | null;
    created_at: string;
    updated_at: string;
  }[];
  meta: { count: number; limit: number; offset: number; scored_only: boolean };
}

export interface EvidenceChainsResponse {
  data: {
    thesis: string;
    chains: {
      id: string;
      path: string[];
      strength: number;
      supports: boolean;
      computed_at: string;
    }[];
  }[];
  meta: { thesis_count: number; record_count: number };
}

export interface EvidenceClustersResponse {
  data: {
    id: string;
    cluster_type: 'temporal' | 'spatial' | 'spatio-temporal';
    center_lat: number | null;
    center_lng: number | null;
    time_start: string | null;
    time_end: string | null;
    event_count: number;
    event_ids: string[];
    computed_at: string;
  }[];
  meta: { count: number; cluster_type?: 'temporal' | 'spatial' | 'spatio-temporal' };
}
