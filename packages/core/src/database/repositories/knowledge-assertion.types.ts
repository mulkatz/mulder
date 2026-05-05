import type { ArtifactProvenance, ArtifactProvenanceInput } from './artifact-provenance.js';

export type AssertionType = 'observation' | 'interpretation' | 'hypothesis';

export type ClassificationProvenance = 'llm_auto' | 'human_reviewed' | 'author_explicit';

export interface ConfidenceMetadata {
	witnessCount: number | null;
	measurementBased: boolean;
	contemporaneous: boolean;
	corroborated: boolean;
	peerReviewed: boolean;
	authorIsInterpreter: boolean;
}

export interface KnowledgeAssertion {
	id: string;
	sourceId: string;
	storyId: string;
	assertionType: AssertionType;
	content: string;
	confidenceMetadata: ConfidenceMetadata;
	classificationProvenance: ClassificationProvenance;
	extractedEntityIds: string[];
	provenance: ArtifactProvenance;
	qualityMetadata: Record<string, unknown> | null;
	createdAt: Date;
	updatedAt: Date;
	deletedAt: Date | null;
}

export interface UpsertKnowledgeAssertionInput {
	sourceId: string;
	storyId: string;
	assertionType: AssertionType;
	content: string;
	confidenceMetadata: ConfidenceMetadata;
	classificationProvenance?: ClassificationProvenance;
	extractedEntityIds?: string[];
	provenance?: ArtifactProvenanceInput;
	qualityMetadata?: Record<string, unknown> | null;
}

export interface ListKnowledgeAssertionsInput {
	includeDeleted?: boolean;
	limit?: number;
	offset?: number;
}
