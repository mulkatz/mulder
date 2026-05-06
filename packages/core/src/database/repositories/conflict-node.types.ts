import type { SensitivityLevel, SensitivityMetadata } from '../../shared/sensitivity.js';
import type { ArtifactProvenance, ArtifactProvenanceInput } from './artifact-provenance.js';
import type { AssertionType } from './knowledge-assertion.types.js';

export type ConflictType = 'factual' | 'interpretive' | 'taxonomic' | 'temporal' | 'spatial' | 'attributive';

export type ConflictSeverity = 'minor' | 'significant' | 'fundamental';

export type ConflictResolutionStatus = 'open' | 'explained' | 'confirmed_contradictory' | 'false_positive';

export type ConflictDetectionMethod = 'llm_auto' | 'statistical' | 'human_reported';

export type ConflictParticipantRole = 'claim_a' | 'claim_b' | 'context';

export type ResolutionType =
	| 'different_vantage_point'
	| 'different_time'
	| 'measurement_error'
	| 'source_unreliable'
	| 'scope_difference'
	| 'genuinely_contradictory'
	| 'duplicate_misidentification'
	| 'other';

export interface ConflictAssertion {
	conflictId: string;
	assertionId: string;
	sourceDocumentId: string;
	assertionType: AssertionType;
	claim: string;
	credibilityProfileId: string | null;
	participantRole: ConflictParticipantRole;
	createdAt: Date;
}

export interface ConflictResolution {
	id: string;
	conflictId: string;
	resolutionType: ResolutionType;
	explanation: string;
	resolvedBy: string;
	resolvedAt: Date;
	evidenceRefs: string[];
	reviewStatus: string;
	legacyEdgeId: string | null;
	createdAt: Date;
	updatedAt: Date;
}

export interface ConflictNode {
	id: string;
	conflictType: ConflictType;
	detectionMethod: ConflictDetectionMethod;
	detectedAt: Date;
	detectedBy: string;
	resolutionStatus: ConflictResolutionStatus;
	severity: ConflictSeverity;
	severityRationale: string;
	reviewStatus: string;
	legacyEdgeId: string | null;
	canonicalAssertionPair: [string, string];
	confidence: number;
	provenance: ArtifactProvenance;
	sensitivityLevel: SensitivityLevel;
	sensitivityMetadata: SensitivityMetadata;
	createdAt: Date;
	updatedAt: Date;
	deletedAt: Date | null;
	assertions: ConflictAssertion[];
	latestResolution: ConflictResolution | null;
}

export interface CreateConflictAssertionInput {
	assertionId: string;
	participantRole?: ConflictParticipantRole;
	claim?: string;
}

export interface CreateConflictNodeInput {
	conflictType: ConflictType;
	detectionMethod: ConflictDetectionMethod;
	detectedBy: string;
	severity: ConflictSeverity;
	severityRationale: string;
	confidence: number;
	assertions: readonly CreateConflictAssertionInput[];
	reviewStatus?: string;
	legacyEdgeId?: string | null;
	provenance?: ArtifactProvenanceInput;
	sensitivityLevel?: SensitivityLevel;
	sensitivityMetadata?: unknown;
}

export interface ConflictNodeListOptions {
	conflictType?: ConflictType;
	severity?: ConflictSeverity;
	resolutionStatus?: ConflictResolutionStatus;
	sourceDocumentId?: string;
	includeDeleted?: boolean;
	limit?: number;
	offset?: number;
}

export interface ResolveConflictNodeInput {
	conflictId: string;
	resolutionType: ResolutionType;
	explanation: string;
	resolvedBy: string;
	resolutionStatus?: ConflictResolutionStatus;
	resolvedAt?: Date | string;
	evidenceRefs?: readonly string[];
	reviewStatus?: string;
	legacyEdgeId?: string | null;
}

export interface ConflictInvolvementBySource {
	sourceDocumentId: string;
	totalCount: number;
	openCount: number;
	resolvedCount: number;
}
