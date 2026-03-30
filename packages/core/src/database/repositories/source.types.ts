/**
 * Type definitions for the source repository.
 *
 * Covers the `sources` and `source_steps` tables with strict
 * TypeScript types for all CRUD operations.
 *
 * @see docs/specs/14_source_repository.spec.md §4.1
 * @see docs/functional-spec.md §4.3
 */

// ────────────────────────────────────────────────────────────
// Status enums
// ────────────────────────────────────────────────────────────

/** Source status lifecycle. */
export type SourceStatus = 'ingested' | 'extracted' | 'segmented' | 'enriched' | 'embedded' | 'graphed' | 'analyzed';

/** Source step execution status. */
export type SourceStepStatus = 'pending' | 'completed' | 'failed' | 'partial';

// ────────────────────────────────────────────────────────────
// Source types
// ────────────────────────────────────────────────────────────

/** A source record from the database. */
export interface Source {
	id: string;
	filename: string;
	storagePath: string;
	fileHash: string;
	pageCount: number | null;
	hasNativeText: boolean;
	nativeTextRatio: number;
	status: SourceStatus;
	reliabilityScore: number | null;
	tags: string[];
	metadata: Record<string, unknown>;
	createdAt: Date;
	updatedAt: Date;
}

/** Input for creating a new source. */
export interface CreateSourceInput {
	filename: string;
	storagePath: string;
	fileHash: string;
	pageCount?: number;
	hasNativeText?: boolean;
	nativeTextRatio?: number;
	tags?: string[];
	metadata?: Record<string, unknown>;
}

/** Input for updating a source. Partial -- only provided fields are updated. */
export interface UpdateSourceInput {
	filename?: string;
	storagePath?: string;
	pageCount?: number;
	hasNativeText?: boolean;
	nativeTextRatio?: number;
	status?: SourceStatus;
	reliabilityScore?: number;
	tags?: string[];
	metadata?: Record<string, unknown>;
}

/** Filters for querying sources. */
export interface SourceFilter {
	status?: SourceStatus;
	tags?: string[];
	limit?: number;
	offset?: number;
}

// ────────────────────────────────────────────────────────────
// Source step types
// ────────────────────────────────────────────────────────────

/** A source_steps record from the database. */
export interface SourceStep {
	sourceId: string;
	stepName: string;
	status: SourceStepStatus;
	configHash: string | null;
	completedAt: Date | null;
	errorMessage: string | null;
}

/** Input for upserting a source step. */
export interface UpsertSourceStepInput {
	sourceId: string;
	stepName: string;
	status: SourceStepStatus;
	configHash?: string;
	errorMessage?: string;
}
