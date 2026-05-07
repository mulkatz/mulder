import type { SensitivityLevel, SensitivityMetadata } from '../../shared/sensitivity.js';
import type { ArtifactProvenance, ArtifactProvenanceInput } from './artifact-provenance.js';
import type { ReviewStatus } from './review-workflow.types.js';

export type SimilarityCoreDimension = 'semantic' | 'structural' | 'geospatial' | 'temporal';
export type SimilarityScoreStatus = 'scored' | 'insufficient_data';
export type SimilarityDomainDimensionSource = 'taxonomy_mapping' | 'attribute_comparison' | 'custom_scorer';

export interface SimilarityDimensionScore {
	status: SimilarityScoreStatus;
	score: number | null;
	reason: string | null;
}

export interface CoreSimilarityDimensions {
	semantic: SimilarityDimensionScore;
	structural: SimilarityDimensionScore;
	geospatial: SimilarityDimensionScore;
	temporal: SimilarityDimensionScore;
}

export interface DomainSimilarityDimension {
	id: string;
	label: string;
	source: SimilarityDomainDimensionSource;
	configRef: string;
	score: number | null;
	status: SimilarityScoreStatus;
	reason: string | null;
	metadata: Record<string, unknown>;
}

export interface SimilarityResult {
	entityId: string;
	entityTitle: string;
	overallRank: number;
	core: CoreSimilarityDimensions;
	domain: DomainSimilarityDimension[];
	explanation: string;
	sharedEntityIds: string[];
	keyDifferences: string[];
	provenance: ArtifactProvenance;
	sensitivityLevel: SensitivityLevel;
	sensitivityMetadata: SensitivityMetadata;
	reviewStatus: ReviewStatus;
	autoDiscovered: boolean;
}

export interface SimilarityCacheRecord {
	id: string;
	entityIdA: string;
	entityIdB: string;
	core: CoreSimilarityDimensions;
	domain: DomainSimilarityDimension[];
	explanation: string;
	sharedEntityIds: string[];
	keyDifferences: string[];
	rankPosition: number | null;
	reviewStatus: ReviewStatus;
	autoDiscovered: boolean;
	autoDiscoveryMetadata: Record<string, unknown>;
	provenance: ArtifactProvenance;
	sensitivityLevel: SensitivityLevel;
	sensitivityMetadata: SensitivityMetadata;
	createdAt: Date;
	updatedAt: Date;
	deletedAt: Date | null;
}

export interface UpsertSimilarityResultInput {
	sourceEntityId: string;
	targetEntityId: string;
	core: CoreSimilarityDimensions;
	domain?: DomainSimilarityDimension[];
	explanation?: string;
	sharedEntityIds?: string[];
	keyDifferences?: string[];
	rankPosition?: number | null;
	reviewStatus?: ReviewStatus;
	autoDiscovered?: boolean;
	autoDiscoveryMetadata?: Record<string, unknown>;
	provenance?: ArtifactProvenanceInput;
	sensitivityLevel?: SensitivityLevel;
	sensitivityMetadata?: unknown;
}

export interface SimilarityPairOptions {
	includeDeleted?: boolean;
	maxSensitivityLevel?: SensitivityLevel;
}

export interface ListSimilarEntitiesOptions extends SimilarityPairOptions {
	entityId: string;
	limit?: number;
	offset?: number;
}

export interface DeleteSimilarityResultsForEntityOptions {
	entityId: string;
}

export interface AutoDiscoveryResult {
	cacheRecord: SimilarityCacheRecord;
	edgeId: string | null;
	reviewArtifactId: string | null;
}
