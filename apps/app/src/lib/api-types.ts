export type UserRole = 'owner' | 'admin' | 'member';

export interface UserSummary {
	id: string;
	email: string;
	role: UserRole;
}

export interface SessionResponse {
	data: {
		user: UserSummary;
		expires_at: string;
	};
}

export type JobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'dead_letter';

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

export interface JobProgress {
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
}

export interface JobDetailRecord extends JobSummary {
	error_log: string | null;
	payload: Record<string, unknown>;
}

export interface JobDetailResponse {
	data: {
		job: JobDetailRecord;
		progress: JobProgress | null;
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

export interface EvidenceSummaryResponse {
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
	attributes: { attribute?: string; valueA?: string; valueB?: string };
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
