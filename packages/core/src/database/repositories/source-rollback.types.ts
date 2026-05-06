export type SourceDeletionStatus = 'soft_deleted' | 'purging' | 'purged' | 'restored';
export type SourceDeletionState = 'active' | SourceDeletionStatus;
export type SourceRollbackOrphanHandling = 'mark' | 'delete';

export interface SourceDeletion {
	id: string;
	sourceId: string;
	deletedBy: string;
	deletedAt: Date;
	reason: string;
	status: SourceDeletionStatus;
	undoDeadline: Date;
	restoredAt: Date | null;
	purgedAt: Date | null;
	createdAt: Date;
	updatedAt: Date;
}

export interface AuditLogEvent {
	id: string;
	eventType: string;
	artifactType: string;
	artifactId: string | null;
	sourceId: string | null;
	actor: string;
	reason: string | null;
	metadata: Record<string, unknown>;
	createdAt: Date;
}

export interface SoftDeleteSourceInput {
	sourceId: string;
	actor: string;
	reason: string;
	undoWindowHours?: number;
	deletedAt?: Date;
}

export interface RestoreSourceInput {
	sourceId: string;
	actor: string;
	reason?: string | null;
	restoredAt?: Date;
}

export interface PurgeSourceInput {
	sourceId: string;
	actor: string;
	reason: string;
	confirmed?: boolean;
	orphanHandling?: SourceRollbackOrphanHandling;
	purgedAt?: Date;
}

export interface SourcePurgeSubsystemCount {
	subsystem: string;
	exclusive: number;
	shared: number;
	total: number;
}

export interface SourcePurgePlan {
	sourceId: string;
	deletion: SourceDeletion | null;
	counts: SourcePurgeSubsystemCount[];
	totalExclusive: number;
	totalShared: number;
	canPurge: boolean;
}

export interface SourcePurgeEffects {
	sourceStepsDeleted: number;
	pipelineRunLinksDeleted: number;
	documentQualityAssessmentsDeleted: number;
	urlLifecycleRowsDeleted: number;
	storiesDeleted: number;
	chunksDeleted: number;
	chunksUpdated: number;
	storyEntitiesDeleted: number;
	storyEntitiesUpdated: number;
	entityEdgesDeleted: number;
	entityEdgesUpdated: number;
	knowledgeAssertionsSoftDeleted: number;
	knowledgeAssertionsUpdated: number;
	entitiesDeleted: number;
	entitiesUpdated: number;
	entityAliasesDeleted: number;
	entityAliasesUpdated: number;
	documentBlobsMovedToColdStorage: number;
	orphanedEntitiesDeleted: number;
}

export interface SourcePurgeReport {
	sourceId: string;
	deletionId: string;
	status: 'purged';
	plan: SourcePurgePlan;
	effects: SourcePurgeEffects;
	purgedAt: Date;
}
