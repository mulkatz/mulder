export type CredibilitySourceType =
	| 'government'
	| 'academic'
	| 'journalist'
	| 'witness'
	| 'organization'
	| 'anonymous'
	| 'other';

export type CredibilityProfileAuthor = 'llm_auto' | 'human' | 'hybrid';

export type CredibilityReviewStatus = 'draft' | 'reviewed' | 'contested';

export interface CredibilityDimension {
	id: string;
	profileId: string;
	dimensionId: string;
	label: string;
	score: number;
	rationale: string;
	evidenceRefs: string[];
	knownFactors: string[];
	createdAt: Date;
	updatedAt: Date;
}

export interface SourceCredibilityProfile {
	profileId: string;
	sourceId: string;
	sourceName: string;
	sourceType: CredibilitySourceType;
	profileAuthor: CredibilityProfileAuthor;
	lastReviewed: Date | null;
	reviewStatus: CredibilityReviewStatus;
	dimensions: CredibilityDimension[];
	createdAt: Date;
	updatedAt: Date;
}

export interface UpsertCredibilityDimensionInput {
	dimensionId: string;
	label: string;
	score: number;
	rationale: string;
	evidenceRefs?: readonly string[];
	knownFactors?: readonly string[];
}

export interface UpsertSourceCredibilityProfileInput {
	sourceId: string;
	sourceName: string;
	sourceType: CredibilitySourceType;
	profileAuthor?: CredibilityProfileAuthor;
	lastReviewed?: Date | string | null;
	reviewStatus?: CredibilityReviewStatus;
	dimensions: readonly UpsertCredibilityDimensionInput[];
}

export interface SourceCredibilityProfileListOptions {
	sourceType?: CredibilitySourceType;
	reviewStatus?: CredibilityReviewStatus;
	limit?: number;
	offset?: number;
}
