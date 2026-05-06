export type ReviewArtifactType =
	| 'assertion_classification'
	| 'credibility_profile'
	| 'taxonomy_mapping'
	| 'similar_case_link'
	| 'agent_finding'
	| 'conflict_node'
	| 'conflict_resolution';

export type ReviewStatus = 'pending' | 'approved' | 'auto_approved' | 'corrected' | 'contested' | 'rejected';

export type ReviewAction = 'approve' | 'correct' | 'reject' | 'comment' | 'escalate';

export type ReviewConfidence = 'certain' | 'likely' | 'uncertain';

export type ReviewCreatedBy = 'llm_auto' | 'human' | 'agent';

export type PipelineReviewResetStep = 'extract' | 'segment' | 'enrich' | 'embed' | 'graph';

export type ReviewJsonObject = Record<string, unknown>;

export interface ReviewableArtifact {
	artifactId: string;
	artifactType: ReviewArtifactType;
	subjectId: string;
	subjectTable: string;
	createdBy: ReviewCreatedBy;
	reviewStatus: ReviewStatus;
	currentValue: ReviewJsonObject;
	context: ReviewJsonObject;
	sourceId: string | null;
	priority: number;
	dueAt: Date | null;
	createdAt: Date;
	updatedAt: Date;
	deletedAt: Date | null;
}

export interface ReviewEvent {
	eventId: string;
	artifactId: string;
	reviewerId: string;
	action: ReviewAction;
	previousValue: unknown | null;
	newValue: unknown | null;
	confidence: ReviewConfidence;
	rationale: string | null;
	tags: string[];
	createdAt: Date;
}

export interface ReviewQueue {
	queueKey: string;
	name: string;
	artifactTypes: ReviewArtifactType[];
	assignees: string[];
	priorityRules: ReviewJsonObject;
	active: boolean;
	pendingCount: number;
	oldestPending: Date | null;
	createdAt: Date;
	updatedAt: Date;
}

export interface UpsertReviewableArtifactInput {
	artifactType: ReviewArtifactType;
	subjectId: string;
	subjectTable: string;
	createdBy?: ReviewCreatedBy;
	reviewStatus?: ReviewStatus;
	currentValue: ReviewJsonObject;
	context?: ReviewJsonObject;
	sourceId?: string | null;
	priority?: number;
	dueAt?: Date | string | null;
}

export interface ReviewableArtifactListOptions {
	artifactType?: ReviewArtifactType;
	reviewStatus?: ReviewStatus;
	sourceId?: string;
	includeDeleted?: boolean;
	limit?: number;
	offset?: number;
}

export interface RecordReviewEventInput {
	artifactId: string;
	reviewerId: string;
	action: ReviewAction;
	newValue?: unknown | null;
	confidence?: ReviewConfidence;
	rationale?: string | null;
	tags?: readonly string[];
	createdAt?: Date | string;
}

export interface ReviewEventListOptions {
	action?: ReviewAction;
	reviewerId?: string;
	limit?: number;
	offset?: number;
}

export interface UpsertReviewQueueInput {
	queueKey: string;
	name: string;
	artifactTypes: readonly ReviewArtifactType[];
	assignees?: readonly string[];
	priorityRules?: ReviewJsonObject;
	active?: boolean;
}

export interface ReviewQueueListOptions {
	activeOnly?: boolean;
}

export interface ReviewQueueArtifactListOptions {
	reviewStatus?: ReviewStatus;
	limit?: number;
	offset?: number;
}

export interface AutoApproveDueReviewArtifactsOptions {
	artifactTypes?: readonly ReviewArtifactType[];
	now?: Date | string;
	limit?: number;
}

export interface AutoApproveDueReviewArtifactsResult {
	updatedCount: number;
	artifacts: ReviewableArtifact[];
}
