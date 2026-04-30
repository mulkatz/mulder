export type RunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'watching';
export type Severity = 'low' | 'medium' | 'high' | 'critical';
export type ClaimStatus = 'corroborated' | 'contradicted' | 'unverified' | 'watching';

export interface Metric {
  label: string;
  value: string;
  delta: string;
  tone: 'neutral' | 'good' | 'warning' | 'danger';
}

export interface TimelineEvent {
  time: string;
  label: string;
  detail: string;
  status: RunStatus;
}

export interface Artifact {
  name: string;
  type: string;
  size: string;
}

export interface AnalysisRun {
  id: string;
  title: string;
  mode: string;
  status: RunStatus;
  owner: string;
  corpus: string;
  startedAt: string;
  duration: string;
  credits: number;
  progress: number;
  confidence: number;
  findings: number;
  query: string;
  params: Record<string, string | number | boolean>;
  artifacts: Artifact[];
  timeline: TimelineEvent[];
  error?: string;
}

export interface Finding {
  id: string;
  title: string;
  summary: string;
  severity: Severity;
  entity: string;
  createdAt: string;
}

export interface SourceRef {
  id: string;
  title: string;
  type: string;
  reliability: number;
  date: string;
  locator: string;
}

export interface EvidenceClaim {
  id: string;
  claim: string;
  entity: string;
  status: ClaimStatus;
  confidence: number;
  lastSeen: string;
  sourceCount: number;
  citations: SourceRef[];
  signals: string[];
}

export interface ActivityEvent {
  id: string;
  label: string;
  detail: string;
  time: string;
  status: RunStatus;
}
