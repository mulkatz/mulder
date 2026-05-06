import type pg from 'pg';
import { DATABASE_ERROR_CODES, DatabaseError } from '../../shared/errors.js';
import type {
	AcquisitionContext,
	AcquisitionContextInput,
	Archive,
	ArchiveInput,
	ArchiveLocation,
	ArchiveLocationInput,
	CustodyAction,
	CustodyStep,
	CustodyStepInput,
	IngestProvenanceBundle,
	OriginalSource,
	OriginalSourceInput,
	PathSegment,
	PhysicalLocation,
	RecordIngestProvenanceInput,
} from './ingest-provenance.types.js';

type Queryable = pg.Pool | pg.PoolClient;

interface ArchiveRow {
	archive_id: string;
	name: string;
	description: string;
	type: Archive['type'];
	institution: string | null;
	custodian: string | null;
	physical_address: string | null;
	status: Archive['status'];
	structure_description: string | null;
	estimated_document_count: number | null;
	languages: string[] | string;
	date_range_earliest: Date | string | null;
	date_range_latest: Date | string | null;
	total_documents_known: number | null;
	total_documents_ingested: number;
	last_ingest_date: Date | string | null;
	completeness: Archive['ingestStatus']['completeness'];
	ingest_notes: string | null;
	access_restrictions: string | null;
	registered_at: Date | string;
	last_verified_at: Date | string | null;
	created_at: Date | string;
	updated_at: Date | string;
}

interface AcquisitionContextRow {
	context_id: string;
	blob_content_hash: string;
	source_id: string | null;
	channel: AcquisitionContext['channel'];
	submitted_by_user_id: string;
	submitted_by_type: AcquisitionContext['submittedBy']['type'];
	submitted_by_role: string | null;
	submitted_at: Date | string;
	collection_id: string | null;
	submission_notes: string | null;
	submission_metadata: unknown;
	authenticity_status: AcquisitionContext['authenticityStatus'];
	authenticity_notes: string | null;
	status: AcquisitionContext['status'];
	deleted_at: Date | string | null;
	restored_at: Date | string | null;
	created_at: Date | string;
	updated_at: Date | string;
}

interface OriginalSourceRow {
	original_source_id: string;
	context_id: string;
	source_type: OriginalSource['sourceType'];
	source_description: string;
	source_date: Date | string | null;
	source_author: string | null;
	source_language: string;
	source_institution: string | null;
	foia_reference: string | null;
	created_at: Date | string;
	updated_at: Date | string;
}

interface CustodyStepRow {
	custody_step_id: string;
	context_id: string;
	step_order: number;
	holder: string;
	holder_type: CustodyStep['holderType'];
	received_from: string | null;
	held_from: Date | string | null;
	held_until: Date | string | null;
	actions: CustodyAction[] | string;
	location: string | null;
	notes: string | null;
	created_at: Date | string;
	updated_at: Date | string;
}

interface ArchiveLocationRow {
	location_id: string;
	blob_content_hash: string;
	archive_id: string;
	original_path: string;
	original_filename: string;
	path_segments: unknown;
	physical_location: unknown;
	source_status: ArchiveLocation['sourceStatus'];
	source_status_updated_at: Date | string;
	recorded_at: Date | string;
	valid_from: Date | string | null;
	valid_until: Date | string | null;
	created_at: Date | string;
	updated_at: Date | string;
}

function toDate(value: Date | string): Date {
	return value instanceof Date ? value : new Date(value);
}

function nullableDate(value: Date | string | null): Date | null {
	return value === null ? null : toDate(value);
}

function normalizeStringArray(value: string[] | string): string[] {
	if (Array.isArray(value)) {
		return value;
	}
	return value
		.replace(/^{|}$/g, '')
		.split(',')
		.map((entry) => entry.trim().replace(/^"|"$/g, ''))
		.filter((entry) => entry.length > 0);
}

function normalizeRecord(value: unknown): Record<string, unknown> {
	if (value && typeof value === 'object' && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	return {};
}

function normalizePathSegments(value: unknown): PathSegment[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value
		.map((segment) => normalizeRecord(segment))
		.filter((segment) => typeof segment.depth === 'number' && typeof segment.name === 'string')
		.map((segment) => ({
			depth: segment.depth as number,
			name: segment.name as string,
			segmentType:
				typeof segment.segmentType === 'string' ? (segment.segmentType as PathSegment['segmentType']) : 'unknown',
		}));
}

function normalizePhysicalLocation(value: unknown): PhysicalLocation | null {
	if (value === null || value === undefined) {
		return null;
	}
	return normalizeRecord(value);
}

function mapArchiveRow(row: ArchiveRow): Archive {
	return {
		archiveId: row.archive_id,
		name: row.name,
		description: row.description,
		type: row.type,
		institution: row.institution,
		custodian: row.custodian,
		physicalAddress: row.physical_address,
		status: row.status,
		structureDescription: row.structure_description,
		estimatedDocumentCount: row.estimated_document_count,
		languages: normalizeStringArray(row.languages),
		dateRange: {
			earliest: nullableDate(row.date_range_earliest),
			latest: nullableDate(row.date_range_latest),
		},
		ingestStatus: {
			totalDocumentsKnown: row.total_documents_known,
			totalDocumentsIngested: row.total_documents_ingested,
			lastIngestDate: nullableDate(row.last_ingest_date),
			completeness: row.completeness,
			notes: row.ingest_notes,
		},
		accessRestrictions: row.access_restrictions,
		registeredAt: toDate(row.registered_at),
		lastVerifiedAt: nullableDate(row.last_verified_at),
		createdAt: toDate(row.created_at),
		updatedAt: toDate(row.updated_at),
	};
}

function mapAcquisitionContextRow(row: AcquisitionContextRow): AcquisitionContext {
	return {
		contextId: row.context_id,
		blobContentHash: row.blob_content_hash,
		sourceId: row.source_id,
		channel: row.channel,
		submittedBy: {
			userId: row.submitted_by_user_id,
			type: row.submitted_by_type,
			role: row.submitted_by_role,
		},
		submittedAt: toDate(row.submitted_at),
		collectionId: row.collection_id,
		submissionNotes: row.submission_notes,
		submissionMetadata: normalizeRecord(row.submission_metadata),
		authenticityStatus: row.authenticity_status,
		authenticityNotes: row.authenticity_notes,
		status: row.status,
		deletedAt: nullableDate(row.deleted_at),
		restoredAt: nullableDate(row.restored_at),
		createdAt: toDate(row.created_at),
		updatedAt: toDate(row.updated_at),
	};
}

function mapOriginalSourceRow(row: OriginalSourceRow): OriginalSource {
	return {
		originalSourceId: row.original_source_id,
		contextId: row.context_id,
		sourceType: row.source_type,
		sourceDescription: row.source_description,
		sourceDate: nullableDate(row.source_date),
		sourceAuthor: row.source_author,
		sourceLanguage: row.source_language,
		sourceInstitution: row.source_institution,
		foiaReference: row.foia_reference,
		createdAt: toDate(row.created_at),
		updatedAt: toDate(row.updated_at),
	};
}

function mapCustodyStepRow(row: CustodyStepRow): CustodyStep {
	return {
		custodyStepId: row.custody_step_id,
		contextId: row.context_id,
		stepOrder: row.step_order,
		holder: row.holder,
		holderType: row.holder_type,
		receivedFrom: row.received_from,
		heldFrom: nullableDate(row.held_from),
		heldUntil: nullableDate(row.held_until),
		actions: normalizeStringArray(row.actions) as CustodyAction[],
		location: row.location,
		notes: row.notes,
		createdAt: toDate(row.created_at),
		updatedAt: toDate(row.updated_at),
	};
}

function mapArchiveLocationRow(row: ArchiveLocationRow): ArchiveLocation {
	return {
		locationId: row.location_id,
		blobContentHash: row.blob_content_hash,
		archiveId: row.archive_id,
		originalPath: row.original_path,
		originalFilename: row.original_filename,
		pathSegments: normalizePathSegments(row.path_segments),
		physicalLocation: normalizePhysicalLocation(row.physical_location),
		sourceStatus: row.source_status,
		sourceStatusUpdatedAt: toDate(row.source_status_updated_at),
		recordedAt: toDate(row.recorded_at),
		validFrom: nullableDate(row.valid_from),
		validUntil: nullableDate(row.valid_until),
		createdAt: toDate(row.created_at),
		updatedAt: toDate(row.updated_at),
	};
}

function archiveValues(input: ArchiveInput): unknown[] {
	return [
		input.archiveId,
		input.name,
		input.description ?? '',
		input.type ?? 'other',
		input.institution ?? null,
		input.custodian ?? null,
		input.physicalAddress ?? null,
		input.status ?? 'active',
		input.structureDescription ?? null,
		input.estimatedDocumentCount ?? null,
		input.languages ?? [],
		input.dateRange?.earliest ?? null,
		input.dateRange?.latest ?? null,
		input.ingestStatus?.totalDocumentsKnown ?? null,
		input.ingestStatus?.totalDocumentsIngested ?? 0,
		input.ingestStatus?.lastIngestDate ?? null,
		input.ingestStatus?.completeness ?? 'unknown',
		input.ingestStatus?.notes ?? null,
		input.accessRestrictions ?? null,
		input.registeredAt ?? new Date(),
		input.lastVerifiedAt ?? null,
	];
}

export async function createArchive(pool: Queryable, input: ArchiveInput): Promise<Archive> {
	const sql = `
		INSERT INTO archives (
			archive_id,
			name,
			description,
			type,
			institution,
			custodian,
			physical_address,
			status,
			structure_description,
			estimated_document_count,
			languages,
			date_range_earliest,
			date_range_latest,
			total_documents_known,
			total_documents_ingested,
			last_ingest_date,
			completeness,
			ingest_notes,
			access_restrictions,
			registered_at,
			last_verified_at
		)
		VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
		RETURNING *
	`;

	try {
		const result = await pool.query<ArchiveRow>(sql, archiveValues(input));
		return mapArchiveRow(result.rows[0]);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to create archive', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { archiveId: input.archiveId, name: input.name },
		});
	}
}

export async function upsertArchive(pool: Queryable, input: ArchiveInput): Promise<Archive> {
	const conflictTarget = input.archiveId ? 'archive_id' : 'name';
	const sql = `
		INSERT INTO archives (
			archive_id,
			name,
			description,
			type,
			institution,
			custodian,
			physical_address,
			status,
			structure_description,
			estimated_document_count,
			languages,
			date_range_earliest,
			date_range_latest,
			total_documents_known,
			total_documents_ingested,
			last_ingest_date,
			completeness,
			ingest_notes,
			access_restrictions,
			registered_at,
			last_verified_at
		)
		VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
		ON CONFLICT (${conflictTarget}) DO UPDATE SET
			name = EXCLUDED.name,
			description = EXCLUDED.description,
			type = EXCLUDED.type,
			institution = EXCLUDED.institution,
			custodian = EXCLUDED.custodian,
			physical_address = EXCLUDED.physical_address,
			status = EXCLUDED.status,
			structure_description = EXCLUDED.structure_description,
			estimated_document_count = EXCLUDED.estimated_document_count,
			languages = EXCLUDED.languages,
			date_range_earliest = EXCLUDED.date_range_earliest,
			date_range_latest = EXCLUDED.date_range_latest,
			total_documents_known = EXCLUDED.total_documents_known,
			total_documents_ingested = EXCLUDED.total_documents_ingested,
			last_ingest_date = EXCLUDED.last_ingest_date,
			completeness = EXCLUDED.completeness,
			ingest_notes = EXCLUDED.ingest_notes,
			access_restrictions = EXCLUDED.access_restrictions,
			last_verified_at = EXCLUDED.last_verified_at,
			updated_at = now()
		RETURNING *
	`;

	try {
		const result = await pool.query<ArchiveRow>(sql, archiveValues(input));
		return mapArchiveRow(result.rows[0]);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to upsert archive', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { archiveId: input.archiveId, name: input.name },
		});
	}
}

export async function findArchiveById(pool: Queryable, archiveId: string): Promise<Archive | null> {
	const result = await pool.query<ArchiveRow>('SELECT * FROM archives WHERE archive_id = $1', [archiveId]);
	return result.rows[0] ? mapArchiveRow(result.rows[0]) : null;
}

export async function listArchives(
	pool: Queryable,
	options?: { status?: Archive['status']; limit?: number; offset?: number },
): Promise<Archive[]> {
	const params: unknown[] = [];
	const conditions: string[] = [];
	if (options?.status) {
		params.push(options.status);
		conditions.push(`status = $${params.length}`);
	}
	const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
	params.push(options?.limit ?? 100, options?.offset ?? 0);
	const result = await pool.query<ArchiveRow>(
		`
			SELECT *
			FROM archives
			${whereClause}
			ORDER BY name ASC, archive_id ASC
			LIMIT $${params.length - 1} OFFSET $${params.length}
		`,
		params,
	);
	return result.rows.map(mapArchiveRow);
}

export async function recordAcquisitionContext(
	pool: Queryable,
	input: AcquisitionContextInput,
): Promise<AcquisitionContext> {
	const sql = `
		INSERT INTO acquisition_contexts (
			blob_content_hash,
			source_id,
			channel,
			submitted_by_user_id,
			submitted_by_type,
			submitted_by_role,
			submitted_at,
			collection_id,
			submission_notes,
			submission_metadata,
			authenticity_status,
			authenticity_notes
		)
		VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::timestamptz, now()), $8, $9, $10::jsonb, $11, $12)
		RETURNING *
	`;
	try {
		const result = await pool.query<AcquisitionContextRow>(sql, [
			input.blobContentHash,
			input.sourceId ?? null,
			input.channel,
			input.submittedBy.userId,
			input.submittedBy.type,
			input.submittedBy.role ?? null,
			input.submittedAt ?? null,
			input.collectionId ?? null,
			input.submissionNotes ?? null,
			JSON.stringify(input.submissionMetadata ?? {}),
			input.authenticityStatus ?? 'unverified',
			input.authenticityNotes ?? null,
		]);
		return mapAcquisitionContextRow(result.rows[0]);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to record acquisition context', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { blobContentHash: input.blobContentHash, sourceId: input.sourceId },
		});
	}
}

export async function findAcquisitionContextById(
	pool: Queryable,
	contextId: string,
): Promise<AcquisitionContext | null> {
	const result = await pool.query<AcquisitionContextRow>('SELECT * FROM acquisition_contexts WHERE context_id = $1', [
		contextId,
	]);
	return result.rows[0] ? mapAcquisitionContextRow(result.rows[0]) : null;
}

export async function listAcquisitionContextsForBlob(
	pool: Queryable,
	blobContentHash: string,
): Promise<AcquisitionContext[]> {
	const result = await pool.query<AcquisitionContextRow>(
		`
			SELECT *
			FROM acquisition_contexts
			WHERE blob_content_hash = $1
			ORDER BY submitted_at ASC, context_id ASC
		`,
		[blobContentHash],
	);
	return result.rows.map(mapAcquisitionContextRow);
}

export async function listAcquisitionContextsForSource(
	pool: Queryable,
	sourceId: string,
): Promise<AcquisitionContext[]> {
	const result = await pool.query<AcquisitionContextRow>(
		`
			SELECT *
			FROM acquisition_contexts
			WHERE source_id = $1
			ORDER BY submitted_at ASC, context_id ASC
		`,
		[sourceId],
	);
	return result.rows.map(mapAcquisitionContextRow);
}

export async function recordOriginalSource(pool: Queryable, input: OriginalSourceInput): Promise<OriginalSource> {
	if (!input.contextId) {
		throw new DatabaseError('Original source contextId is required', DATABASE_ERROR_CODES.DB_QUERY_FAILED);
	}
	const sql = `
		INSERT INTO original_sources (
			context_id,
			source_type,
			source_description,
			source_date,
			source_author,
			source_language,
			source_institution,
			foia_reference
		)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		ON CONFLICT (context_id) DO UPDATE SET
			source_type = EXCLUDED.source_type,
			source_description = EXCLUDED.source_description,
			source_date = EXCLUDED.source_date,
			source_author = EXCLUDED.source_author,
			source_language = EXCLUDED.source_language,
			source_institution = EXCLUDED.source_institution,
			foia_reference = EXCLUDED.foia_reference,
			updated_at = now()
		RETURNING *
	`;
	const result = await pool.query<OriginalSourceRow>(sql, [
		input.contextId,
		input.sourceType,
		input.sourceDescription,
		input.sourceDate ?? null,
		input.sourceAuthor ?? null,
		input.sourceLanguage ?? 'und',
		input.sourceInstitution ?? null,
		input.foiaReference ?? null,
	]);
	return mapOriginalSourceRow(result.rows[0]);
}

export async function findOriginalSourceForContext(pool: Queryable, contextId: string): Promise<OriginalSource | null> {
	const result = await pool.query<OriginalSourceRow>('SELECT * FROM original_sources WHERE context_id = $1', [
		contextId,
	]);
	return result.rows[0] ? mapOriginalSourceRow(result.rows[0]) : null;
}

export async function recordCustodyStep(pool: Queryable, input: CustodyStepInput): Promise<CustodyStep> {
	if (!input.contextId) {
		throw new DatabaseError('Custody step contextId is required', DATABASE_ERROR_CODES.DB_QUERY_FAILED);
	}
	const sql = `
		INSERT INTO custody_steps (
			context_id,
			step_order,
			holder,
			holder_type,
			received_from,
			held_from,
			held_until,
			actions,
			location,
			notes
		)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
		ON CONFLICT (context_id, step_order) DO UPDATE SET
			holder = EXCLUDED.holder,
			holder_type = EXCLUDED.holder_type,
			received_from = EXCLUDED.received_from,
			held_from = EXCLUDED.held_from,
			held_until = EXCLUDED.held_until,
			actions = EXCLUDED.actions,
			location = EXCLUDED.location,
			notes = EXCLUDED.notes,
			updated_at = now()
		RETURNING *
	`;
	const result = await pool.query<CustodyStepRow>(sql, [
		input.contextId,
		input.stepOrder,
		input.holder,
		input.holderType ?? 'unknown',
		input.receivedFrom ?? null,
		input.heldFrom ?? null,
		input.heldUntil ?? null,
		input.actions ?? [],
		input.location ?? null,
		input.notes ?? null,
	]);
	return mapCustodyStepRow(result.rows[0]);
}

export async function replaceCustodyChain(
	pool: Queryable,
	contextId: string,
	inputs: CustodyStepInput[],
): Promise<CustodyStep[]> {
	await pool.query('DELETE FROM custody_steps WHERE context_id = $1', [contextId]);
	const steps: CustodyStep[] = [];
	for (const input of inputs) {
		steps.push(await recordCustodyStep(pool, { ...input, contextId }));
	}
	return steps;
}

export async function listCustodyChainForContext(pool: Queryable, contextId: string): Promise<CustodyStep[]> {
	const result = await pool.query<CustodyStepRow>(
		`
			SELECT *
			FROM custody_steps
			WHERE context_id = $1
			ORDER BY step_order ASC
		`,
		[contextId],
	);
	return result.rows.map(mapCustodyStepRow);
}

export async function recordArchiveLocation(pool: Queryable, input: ArchiveLocationInput): Promise<ArchiveLocation> {
	const sql = `
		INSERT INTO archive_locations (
			blob_content_hash,
			archive_id,
			original_path,
			original_filename,
			path_segments,
			physical_location,
			source_status,
			source_status_updated_at,
			recorded_at,
			valid_from,
			valid_until
		)
		VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, COALESCE($8::timestamptz, now()), COALESCE($9::timestamptz, now()), $10, $11)
		ON CONFLICT (blob_content_hash, archive_id, original_path, original_filename) DO UPDATE SET
			path_segments = EXCLUDED.path_segments,
			physical_location = EXCLUDED.physical_location,
			source_status = EXCLUDED.source_status,
			source_status_updated_at = EXCLUDED.source_status_updated_at,
			valid_from = EXCLUDED.valid_from,
			valid_until = EXCLUDED.valid_until,
			updated_at = now()
		RETURNING *
	`;
	const result = await pool.query<ArchiveLocationRow>(sql, [
		input.blobContentHash,
		input.archiveId,
		input.originalPath,
		input.originalFilename,
		JSON.stringify(input.pathSegments ?? []),
		input.physicalLocation ? JSON.stringify(input.physicalLocation) : null,
		input.sourceStatus ?? 'current',
		input.sourceStatusUpdatedAt ?? null,
		input.recordedAt ?? null,
		input.validFrom ?? null,
		input.validUntil ?? null,
	]);
	return mapArchiveLocationRow(result.rows[0]);
}

export async function listArchiveLocationsForBlob(
	pool: Queryable,
	blobContentHash: string,
): Promise<ArchiveLocation[]> {
	const result = await pool.query<ArchiveLocationRow>(
		`
			SELECT *
			FROM archive_locations
			WHERE blob_content_hash = $1
			ORDER BY recorded_at ASC, location_id ASC
		`,
		[blobContentHash],
	);
	return result.rows.map(mapArchiveLocationRow);
}

export async function recordIngestProvenance(
	pool: pg.Pool,
	input: RecordIngestProvenanceInput,
): Promise<IngestProvenanceBundle> {
	const client = await pool.connect();
	try {
		await client.query('BEGIN');
		const context = await recordAcquisitionContext(client, {
			blobContentHash: input.blobContentHash,
			sourceId: input.sourceId ?? null,
			...input.context,
		});
		const originalSource = input.originalSource
			? await recordOriginalSource(client, { ...input.originalSource, contextId: context.contextId })
			: null;
		const custodyChain = await replaceCustodyChain(
			client,
			context.contextId,
			input.custodyChain?.map((step) => ({ ...step, contextId: context.contextId })) ?? [],
		);
		const archive = input.archive ? await upsertArchive(client, input.archive) : null;
		const archiveId = archive?.archiveId ?? input.archiveLocation?.archiveId;
		const archiveLocation =
			input.archiveLocation && archiveId
				? await recordArchiveLocation(client, {
						...input.archiveLocation,
						blobContentHash: input.blobContentHash,
						archiveId,
					})
				: null;
		if (input.archiveLocation && !archiveId) {
			throw new DatabaseError(
				'Archive location requires an archive or archiveId',
				DATABASE_ERROR_CODES.DB_QUERY_FAILED,
			);
		}
		await client.query('COMMIT');
		return { context, archive, archiveLocation, originalSource, custodyChain };
	} catch (error: unknown) {
		await client.query('ROLLBACK').catch(() => {});
		if (error instanceof DatabaseError) {
			throw error;
		}
		throw new DatabaseError('Failed to record ingest provenance bundle', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { blobContentHash: input.blobContentHash, sourceId: input.sourceId },
		});
	} finally {
		client.release();
	}
}

export async function markAcquisitionContextsForSourceDeleted(
	pool: Queryable,
	sourceId: string,
	deletedAt: Date,
): Promise<number> {
	const result = await pool.query(
		`
			UPDATE acquisition_contexts
			SET status = 'deleted',
				deleted_at = $2,
				updated_at = now()
			WHERE source_id = $1
				AND status IN ('active', 'restored')
		`,
		[sourceId, deletedAt],
	);
	return result.rowCount ?? 0;
}

export async function restoreAcquisitionContextsForSource(
	pool: Queryable,
	sourceId: string,
	restoredAt: Date,
): Promise<number> {
	const result = await pool.query(
		`
			UPDATE acquisition_contexts
			SET status = 'restored',
				restored_at = $2,
				updated_at = now()
			WHERE source_id = $1
				AND status = 'deleted'
		`,
		[sourceId, restoredAt],
	);
	return result.rowCount ?? 0;
}
