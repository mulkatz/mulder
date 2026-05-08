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

export type SensitivityLevel = 'public' | 'internal' | 'restricted' | 'confidential';

export interface DocumentDetailRecord extends DocumentRecord {
	reader_link: string;
	provenance: {
		context_id: string;
		channel: string;
		submitted_at: string;
		submitted_by_type: string;
		collection_id: string | null;
		authenticity_status: string;
		authenticity_notes: string | null;
		submission_notes: string | null;
	} | null;
	original_source: {
		source_type: string;
		description: string;
		source_date: string | null;
		author: string | null;
		language: string;
		institution: string | null;
		foia_reference: string | null;
	} | null;
	source_language: string | null;
	sensitivity: {
		level: SensitivityLevel;
		metadata: Record<string, unknown>;
	};
	quality: {
		id: string;
		assessed_at: string;
		assessment_method: string;
		overall_quality: string;
		processable: boolean;
		recommended_path: string;
		text_readability_score: number | null;
		language: string | null;
		language_confidence: number | null;
	} | null;
	collection: {
		id: string;
		name: string;
		description: string;
		type: string;
		visibility: string;
		tags: string[];
		document_count: number;
		total_size_bytes: number;
		languages: string[];
		date_range: { earliest: string | null; latest: string | null };
	} | null;
	credibility: {
		profile_id: string;
		source_type: string;
		profile_author: string;
		review_status: string;
		last_reviewed: string | null;
		dimension_count: number;
		average_score: number | null;
		sensitivity_level: SensitivityLevel;
	} | null;
}

export interface DocumentDetailResponse {
	data: DocumentDetailRecord;
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

export type TranslationStatus = 'current' | 'stale';
export type TranslationPipelinePath = 'full' | 'translation_only';
export type TranslationOutputFormat = 'markdown' | 'html';

export interface TranslationRecord {
	id: string;
	source_document_id: string;
	source_language: string;
	target_language: string;
	translation_engine: string;
	translation_date: string;
	content: string;
	content_hash: string;
	status: TranslationStatus;
	pipeline_path: TranslationPipelinePath;
	output_format: TranslationOutputFormat;
	sensitivity_level: SensitivityLevel;
	created_at: string;
	updated_at: string;
}

export interface TranslationListResponse {
	data: TranslationRecord[];
	meta: { count: number; limit: number; offset: number };
}

export interface TranslationDetailResponse {
	data: TranslationRecord;
}

export interface TranslationAcceptedResponse {
	data: {
		job_id: string;
		status: 'pending';
	};
	links: { status: string };
}

export interface CreateTranslationRequest {
	target_language: string;
	source_language?: string;
	pipeline_path?: TranslationPipelinePath;
	output_format?: TranslationOutputFormat;
	refresh?: boolean;
}

export type AssertionType = 'observation' | 'interpretation' | 'hypothesis';
export type ClassificationProvenance = 'llm_auto' | 'human_reviewed' | 'author_explicit';

export interface ClaimRecord {
	id: string;
	source_id: string;
	story_id: string;
	assertion_type: AssertionType;
	content: string;
	confidence_metadata: {
		witness_count: number | null;
		measurement_based: boolean;
		contemporaneous: boolean;
		corroborated: boolean;
		peer_reviewed: boolean;
		author_is_interpreter: boolean;
	};
	classification_provenance: ClassificationProvenance;
	extracted_entity_ids: string[];
	provenance: Record<string, unknown>;
	quality_metadata: Record<string, unknown> | null;
	sensitivity_level: SensitivityLevel;
	sensitivity_metadata: Record<string, unknown>;
	created_at: string;
	updated_at: string;
}

export interface ClaimListResponse {
	data: ClaimRecord[];
	meta: { count: number; limit: number; offset: number };
}

export interface ClaimDetailResponse {
	data: ClaimRecord;
}

export type ReviewStatus = 'pending' | 'approved' | 'auto_approved' | 'corrected' | 'contested' | 'rejected';
export type ReviewAction = 'approve' | 'correct' | 'reject' | 'comment' | 'escalate';
export type ReviewConfidence = 'certain' | 'likely' | 'uncertain';
export type ReviewArtifactType =
	| 'assertion_classification'
	| 'credibility_profile'
	| 'taxonomy_mapping'
	| 'similar_case_link'
	| 'agent_finding'
	| 'conflict_node'
	| 'conflict_resolution';

export interface ReviewQueueRecord {
	queue_key: string;
	name: string;
	artifact_types: ReviewArtifactType[];
	assignees: string[];
	priority_rules: Record<string, unknown>;
	active: boolean;
	pending_count: number;
	oldest_pending: string | null;
	created_at: string;
	updated_at: string;
}

export interface ReviewArtifactRecord {
	artifact_id: string;
	artifact_type: ReviewArtifactType;
	subject_id: string;
	subject_table: string;
	created_by: 'llm_auto' | 'human' | 'agent';
	review_status: ReviewStatus;
	current_value: Record<string, unknown>;
	context: Record<string, unknown>;
	source_id: string | null;
	priority: number;
	due_at: string | null;
	created_at: string;
	updated_at: string;
}

export interface ReviewEventRecord {
	event_id: string;
	artifact_id: string;
	reviewer_id: string;
	action: ReviewAction;
	previous_value: unknown | null;
	new_value: unknown | null;
	confidence: ReviewConfidence;
	rationale: string | null;
	tags: string[];
	created_at: string;
}

export interface ReviewQueueListResponse {
	data: ReviewQueueRecord[];
}

export interface ReviewArtifactListResponse {
	data: ReviewArtifactRecord[];
	meta: { count: number; limit: number; offset: number };
}

export interface ReviewArtifactDetailResponse {
	data: ReviewArtifactRecord;
}

export interface ReviewEventListResponse {
	data: ReviewEventRecord[];
	meta: { count: number; limit: number; offset: number };
}

export interface ReviewActionRequest {
	action: ReviewAction;
	new_value?: unknown;
	confidence?: ReviewConfidence;
	rationale?: string;
	tags?: string[];
}

export interface ReviewActionResponse {
	data: {
		artifact: ReviewArtifactRecord;
		event: ReviewEventRecord;
	};
}

export interface DocumentQualityAssessmentRecord {
	id: string;
	source_id: string;
	assessed_at: string;
	assessment_method: 'automated' | 'human';
	overall_quality: 'high' | 'medium' | 'low' | 'unusable';
	processable: boolean;
	recommended_path:
		| 'standard'
		| 'enhanced_ocr'
		| 'visual_extraction'
		| 'handwriting_recognition'
		| 'manual_transcription_required'
		| 'skip';
	dimensions: Record<string, unknown>;
	signals: Record<string, unknown>;
	created_at: string;
}

export interface DocumentQualityResponse {
	data: {
		latest: DocumentQualityAssessmentRecord | null;
		assessments: DocumentQualityAssessmentRecord[];
	};
}

export interface CredibilityProfileRecord {
	profile_id: string;
	source_id: string;
	source_name: string;
	source_type: 'government' | 'academic' | 'journalist' | 'witness' | 'organization' | 'anonymous' | 'other';
	profile_author: 'llm_auto' | 'human' | 'hybrid';
	last_reviewed: string | null;
	review_status: 'draft' | 'reviewed' | 'contested';
	provenance: Record<string, unknown>;
	sensitivity_level: SensitivityLevel;
	sensitivity_metadata: Record<string, unknown>;
	dimensions: {
		id: string;
		profile_id: string;
		dimension_id: string;
		label: string;
		score: number;
		rationale: string;
		evidence_refs: string[];
		known_factors: string[];
		created_at: string;
		updated_at: string;
	}[];
	created_at: string;
	updated_at: string;
}

export interface DocumentCredibilityResponse {
	data: CredibilityProfileRecord | null;
}

export interface SourceCredibilityListResponse {
	data: CredibilityProfileRecord[];
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
