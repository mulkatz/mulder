import type { IngestProvenanceConfig } from '../../config/types.js';
import type { Collection } from './collection.types.js';

export type AcquisitionChannel =
	| 'archive_import'
	| 'manual_upload'
	| 'email_submission'
	| 'web_research'
	| 'api_import'
	| 'bulk_import'
	| 're_scan'
	| 'partner_exchange';

export type SubmittedByType = 'human' | 'system';
export type AuthenticityStatus = 'unverified' | 'verified' | 'disputed';
export type AcquisitionContextStatus = 'active' | 'deleted' | 'restored';

export type OriginalSourceType =
	| 'witness_report'
	| 'government_document'
	| 'academic_paper'
	| 'news_article'
	| 'correspondence'
	| 'field_notes'
	| 'measurement_data'
	| 'photograph'
	| 'audio_recording'
	| 'video_recording'
	| 'other';

export type CustodyHolderType = 'person' | 'institution' | 'archive' | 'unknown';
export type CustodyAction =
	| 'received'
	| 'copied'
	| 'digitized'
	| 'annotated'
	| 'translated'
	| 'redacted'
	| 'restored'
	| 'transferred'
	| 'archived';

export type ArchiveType = 'personal' | 'institutional' | 'digital' | 'governmental' | 'partner' | 'other';
export type ArchiveStatus = 'active' | 'closed' | 'destroyed' | 'transferred' | 'unknown';
export type ArchiveCompleteness = 'unknown' | 'partial' | 'complete';
export type ArchiveSourceStatus =
	| 'current'
	| 'moved'
	| 'deleted_from_source'
	| 'archive_destroyed'
	| 'digitized_only'
	| 'unknown';
export type PathSegmentType =
	| 'collection'
	| 'topic'
	| 'region'
	| 'time_period'
	| 'person'
	| 'case'
	| 'administrative'
	| 'unknown';

export interface SubmittedBy {
	userId: string;
	type: SubmittedByType;
	role?: string | null;
}

export interface PathSegment {
	depth: number;
	name: string;
	segmentType: PathSegmentType;
}

export interface PhysicalLocation {
	building?: string | null;
	room?: string | null;
	shelf?: string | null;
	container?: string | null;
	position?: string | null;
	notes?: string | null;
}

export interface Archive {
	archiveId: string;
	name: string;
	description: string;
	type: ArchiveType;
	institution: string | null;
	custodian: string | null;
	physicalAddress: string | null;
	status: ArchiveStatus;
	structureDescription: string | null;
	estimatedDocumentCount: number | null;
	languages: string[];
	dateRange: {
		earliest: Date | null;
		latest: Date | null;
	};
	ingestStatus: {
		totalDocumentsKnown: number | null;
		totalDocumentsIngested: number;
		lastIngestDate: Date | null;
		completeness: ArchiveCompleteness;
		notes: string | null;
	};
	accessRestrictions: string | null;
	registeredAt: Date;
	lastVerifiedAt: Date | null;
	createdAt: Date;
	updatedAt: Date;
}

export interface AcquisitionContext {
	contextId: string;
	blobContentHash: string;
	sourceId: string | null;
	channel: AcquisitionChannel;
	submittedBy: SubmittedBy;
	submittedAt: Date;
	collectionId: string | null;
	submissionNotes: string | null;
	submissionMetadata: Record<string, unknown>;
	authenticityStatus: AuthenticityStatus;
	authenticityNotes: string | null;
	status: AcquisitionContextStatus;
	deletedAt: Date | null;
	restoredAt: Date | null;
	createdAt: Date;
	updatedAt: Date;
}

export interface OriginalSource {
	originalSourceId: string;
	contextId: string;
	sourceType: OriginalSourceType;
	sourceDescription: string;
	sourceDate: Date | null;
	sourceAuthor: string | null;
	sourceLanguage: string;
	sourceInstitution: string | null;
	foiaReference: string | null;
	createdAt: Date;
	updatedAt: Date;
}

export interface CustodyStep {
	custodyStepId: string;
	contextId: string;
	stepOrder: number;
	holder: string;
	holderType: CustodyHolderType;
	receivedFrom: string | null;
	heldFrom: Date | null;
	heldUntil: Date | null;
	actions: CustodyAction[];
	location: string | null;
	notes: string | null;
	createdAt: Date;
	updatedAt: Date;
}

export interface ArchiveLocation {
	locationId: string;
	blobContentHash: string;
	archiveId: string;
	originalPath: string;
	originalFilename: string;
	pathSegments: PathSegment[];
	physicalLocation: PhysicalLocation | null;
	sourceStatus: ArchiveSourceStatus;
	sourceStatusUpdatedAt: Date;
	recordedAt: Date;
	validFrom: Date | null;
	validUntil: Date | null;
	createdAt: Date;
	updatedAt: Date;
}

export interface ArchiveInput {
	archiveId?: string;
	name: string;
	description?: string;
	type?: ArchiveType;
	institution?: string | null;
	custodian?: string | null;
	physicalAddress?: string | null;
	status?: ArchiveStatus;
	structureDescription?: string | null;
	estimatedDocumentCount?: number | null;
	languages?: string[];
	dateRange?: {
		earliest?: Date | string | null;
		latest?: Date | string | null;
	};
	ingestStatus?: {
		totalDocumentsKnown?: number | null;
		totalDocumentsIngested?: number;
		lastIngestDate?: Date | string | null;
		completeness?: ArchiveCompleteness;
		notes?: string | null;
	};
	accessRestrictions?: string | null;
	registeredAt?: Date | string;
	lastVerifiedAt?: Date | string | null;
}

export interface AcquisitionContextInput {
	blobContentHash: string;
	sourceId?: string | null;
	channel: AcquisitionChannel;
	submittedBy: SubmittedBy;
	submittedAt?: Date | string;
	collectionId?: string | null;
	submissionNotes?: string | null;
	submissionMetadata?: Record<string, unknown>;
	authenticityStatus?: AuthenticityStatus;
	authenticityNotes?: string | null;
}

export interface OriginalSourceInput {
	contextId?: string;
	sourceType: OriginalSourceType;
	sourceDescription: string;
	sourceDate?: Date | string | null;
	sourceAuthor?: string | null;
	sourceLanguage?: string;
	sourceInstitution?: string | null;
	foiaReference?: string | null;
}

export interface CustodyStepInput {
	contextId?: string;
	stepOrder: number;
	holder: string;
	holderType?: CustodyHolderType;
	receivedFrom?: string | null;
	heldFrom?: Date | string | null;
	heldUntil?: Date | string | null;
	actions?: CustodyAction[];
	location?: string | null;
	notes?: string | null;
}

export interface ArchiveLocationInput {
	blobContentHash: string;
	archiveId: string;
	originalPath: string;
	originalFilename: string;
	pathSegments?: PathSegment[];
	physicalLocation?: PhysicalLocation | null;
	sourceStatus?: ArchiveSourceStatus;
	sourceStatusUpdatedAt?: Date | string;
	recordedAt?: Date | string;
	validFrom?: Date | string | null;
	validUntil?: Date | string | null;
}

export interface RecordIngestProvenanceInput {
	blobContentHash: string;
	sourceId?: string | null;
	context: Omit<AcquisitionContextInput, 'blobContentHash' | 'sourceId'>;
	originalSource?: OriginalSourceInput | null;
	custodyChain?: CustodyStepInput[];
	archive?: ArchiveInput | null;
	archiveLocation?: Omit<ArchiveLocationInput, 'blobContentHash' | 'archiveId'> & { archiveId?: string };
	config?: Pick<IngestProvenanceConfig, 'collections'>;
}

export interface IngestProvenanceBundle {
	context: AcquisitionContext;
	archive: Archive | null;
	archiveLocation: ArchiveLocation | null;
	collection: Collection | null;
	originalSource: OriginalSource | null;
	custodyChain: CustodyStep[];
}
