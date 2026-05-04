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

export type SourceStatus = DocumentRecord['status'];

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

export interface DocumentPageRecord {
	page_number: number;
	image_url: string;
}

export interface DocumentPagesResponse {
	data: {
		source_id: string;
		pages: DocumentPageRecord[];
	};
	meta: { count: number };
}

export interface DocumentObservabilityResponse {
	data: {
		source: {
			id: string;
			filename: string;
			status: SourceStatus;
			page_count: number | null;
			steps: {
				step: string;
				status: 'pending' | 'completed' | 'failed' | 'partial';
				completed_at: string | null;
				error_message: string | null;
			}[];
			projection: {
				status: string | null;
				extracted_at: string | null;
				segmented_at: string | null;
				page_count: number | null;
				story_count: number | null;
				vision_fallback_count: number | null;
				vision_fallback_capped: boolean | null;
			} | null;
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
		job: {
			job_id: string;
			status: JobStatus;
			attempts: number;
			max_attempts: number;
			error_log: string | null;
			created_at: string;
			started_at: string | null;
			finished_at: string | null;
		} | null;
		progress: {
			run_id: string;
			run_status: 'running' | 'completed' | 'partial' | 'failed';
			current_step: string;
			source_status: 'pending' | 'processing' | 'completed' | 'failed';
			updated_at: string;
			error_message: string | null;
		} | null;
		timeline: {
			scope: 'job' | 'source' | 'story';
			event: string;
			status: string;
			occurred_at: string;
			step: string | null;
			story_id: string | null;
			details: Record<string, unknown>;
		}[];
	};
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
