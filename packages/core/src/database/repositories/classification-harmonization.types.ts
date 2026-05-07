import type { SensitivityLevel, SensitivityMetadata } from '../../shared/sensitivity.js';
import type { ArtifactProvenance, ArtifactProvenanceInput } from './artifact-provenance.js';

export type ClassificationTaxonomyStatus = 'active' | 'inactive' | 'draft' | 'deprecated';
export type ClassificationCategoryStatus = ClassificationTaxonomyStatus;
export type TaxonomyMappingType = 'equivalent' | 'broader' | 'narrower' | 'overlapping' | 'related';
export type TaxonomyMappingAuthor = 'llm_auto' | 'human' | 'hybrid';
export type TaxonomyMappingReviewStatus = 'draft' | 'reviewed' | 'contested';
export type TaxonomyMappingDirection = 'forward' | 'reverse';

export interface ClassificationTaxonomy {
	id: string;
	name: string;
	version: string | null;
	language: string | null;
	description: string | null;
	status: ClassificationTaxonomyStatus;
	sourceRef: string | null;
	provenance: ArtifactProvenance;
	sensitivityLevel: SensitivityLevel;
	sensitivityMetadata: SensitivityMetadata;
	createdAt: Date;
	updatedAt: Date;
	deletedAt: Date | null;
}

export interface ClassificationCategory {
	id: string;
	taxonomyId: string;
	code: string;
	label: string;
	translations: Record<string, string>;
	definition: string | null;
	parentId: string | null;
	attributes: unknown[] | Record<string, unknown>;
	status: ClassificationCategoryStatus;
	provenance: ArtifactProvenance;
	sensitivityLevel: SensitivityLevel;
	sensitivityMetadata: SensitivityMetadata;
	createdAt: Date;
	updatedAt: Date;
	deletedAt: Date | null;
}

export interface ClassificationCategoryRef {
	taxonomyId?: string;
	categoryId: string;
}

export interface TaxonomyMapping {
	id: string;
	sourceTaxonomyId: string;
	sourceCategoryId: string;
	targetTaxonomyId: string;
	targetCategoryId: string;
	mappingType: TaxonomyMappingType;
	confidence: number;
	conditions: string | null;
	rationale: string;
	mappingAuthor: TaxonomyMappingAuthor;
	reviewStatus: TaxonomyMappingReviewStatus;
	provenance: ArtifactProvenance;
	sensitivityLevel: SensitivityLevel;
	sensitivityMetadata: SensitivityMetadata;
	createdAt: Date;
	updatedAt: Date;
	deletedAt: Date | null;
}

export interface TaxonomyMappingView extends TaxonomyMapping {
	direction: TaxonomyMappingDirection;
	originalMappingType: TaxonomyMappingType;
	originalSourceTaxonomyId: string;
	originalSourceCategoryId: string;
	originalTargetTaxonomyId: string;
	originalTargetCategoryId: string;
}

export interface UpsertClassificationTaxonomyInput {
	id: string;
	name: string;
	version?: string | null;
	language?: string | null;
	description?: string | null;
	status?: ClassificationTaxonomyStatus;
	sourceRef?: string | null;
	provenance?: ArtifactProvenanceInput;
	sensitivityLevel?: SensitivityLevel;
	sensitivityMetadata?: unknown;
}

export interface ClassificationTaxonomyListOptions {
	status?: ClassificationTaxonomyStatus;
	sourceRef?: string;
	includeDeleted?: boolean;
	maxSensitivityLevel?: SensitivityLevel;
	limit?: number;
	offset?: number;
}

export interface UpsertClassificationCategoryInput {
	id: string;
	taxonomyId: string;
	code: string;
	label: string;
	translations?: Record<string, string>;
	definition?: string | null;
	parentId?: string | null;
	attributes?: unknown[] | Record<string, unknown>;
	status?: ClassificationCategoryStatus;
	provenance?: ArtifactProvenanceInput;
	sensitivityLevel?: SensitivityLevel;
	sensitivityMetadata?: unknown;
}

export interface ClassificationCategoryListOptions {
	taxonomyId?: string;
	parentId?: string | null;
	status?: ClassificationCategoryStatus;
	includeDeleted?: boolean;
	maxSensitivityLevel?: SensitivityLevel;
	limit?: number;
	offset?: number;
}

export interface UpsertTaxonomyMappingInput {
	id?: string;
	source: ClassificationCategoryRef;
	target: ClassificationCategoryRef;
	mappingType: TaxonomyMappingType;
	confidence: number;
	conditions?: string | null;
	rationale: string;
	mappingAuthor?: TaxonomyMappingAuthor;
	reviewStatus?: TaxonomyMappingReviewStatus;
	provenance?: ArtifactProvenanceInput;
	sensitivityLevel?: SensitivityLevel;
	sensitivityMetadata?: unknown;
}

export interface TaxonomyMappingListOptions {
	taxonomyId?: string;
	categoryId?: string;
	sourceTaxonomyId?: string;
	sourceCategoryId?: string;
	targetTaxonomyId?: string;
	targetCategoryId?: string;
	mappingType?: TaxonomyMappingType | readonly TaxonomyMappingType[];
	reviewStatus?: TaxonomyMappingReviewStatus | readonly TaxonomyMappingReviewStatus[];
	minConfidence?: number;
	includeDeleted?: boolean;
	maxSensitivityLevel?: SensitivityLevel;
	limit?: number;
	offset?: number;
}

export interface ResolveTaxonomyMappingsOptions
	extends Omit<TaxonomyMappingListOptions, 'categoryId' | 'taxonomyId' | 'targetCategoryId' | 'targetTaxonomyId'> {
	categoryId: string;
	taxonomyId?: string;
	targetCategoryId?: string;
	targetTaxonomyId?: string;
}

export interface TaxonomyMappingSimilarityEvidence {
	mappingId: string;
	mappingType: TaxonomyMappingType;
	originalMappingType: TaxonomyMappingType;
	direction: TaxonomyMappingDirection;
	confidence: number;
	reviewStatus: TaxonomyMappingReviewStatus;
	source: ClassificationCategoryRef;
	target: ClassificationCategoryRef;
	conditions: string | null;
	rationale: string;
}

export interface TaxonomyMappingSimilarityScore {
	status: 'scored' | 'insufficient_data';
	score: number | null;
	reason: string | null;
	evidence: TaxonomyMappingSimilarityEvidence[];
}
