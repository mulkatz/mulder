import type { IngestProvenanceConfig } from '../../config/types.js';
import type { SensitivityLevel } from '../../shared/sensitivity.js';
import type { Archive, ArchiveInput, PathSegment } from './ingest-provenance.types.js';

export type CollectionType = 'archive_mirror' | 'thematic' | 'import_batch' | 'curated' | 'other';
export type CollectionVisibility = 'private' | 'team' | 'public';

export interface CollectionDefaults {
	sensitivityLevel: SensitivityLevel;
	defaultLanguage: string;
	credibilityProfileId: string | null;
}

export interface Collection {
	collectionId: string;
	name: string;
	description: string;
	type: CollectionType;
	archiveId: string | null;
	createdBy: string;
	visibility: CollectionVisibility;
	tags: string[];
	defaults: CollectionDefaults;
	createdAt: Date;
	updatedAt: Date;
}

export interface CollectionInput {
	collectionId?: string;
	name: string;
	description?: string;
	type?: CollectionType;
	archiveId?: string | null;
	createdBy?: string;
	visibility?: CollectionVisibility;
	tags?: string[];
	defaults?: Partial<CollectionDefaults>;
}

export interface CollectionUpdateInput {
	name?: string;
	description?: string;
	type?: CollectionType;
	archiveId?: string | null;
	visibility?: CollectionVisibility;
	defaults?: Partial<CollectionDefaults>;
}

export interface CollectionSummary extends Collection {
	documentCount: number;
	totalSizeBytes: number;
	languages: string[];
	dateRange: {
		earliest: Date | null;
		latest: Date | null;
	};
}

export interface CollectionListOptions {
	type?: CollectionType;
	visibility?: CollectionVisibility;
	archiveId?: string;
	tag?: string;
	limit?: number;
	offset?: number;
}

export interface ResolveCollectionForIngestInput {
	explicitCollectionId?: string | null;
	archive?: Archive | ArchiveInput | null;
	archiveLocation?: {
		archiveId?: string | null;
		pathSegments?: PathSegment[];
	} | null;
	submittedBy?: {
		userId?: string;
	} | null;
}

export type CollectionConfig = IngestProvenanceConfig['collections'];
