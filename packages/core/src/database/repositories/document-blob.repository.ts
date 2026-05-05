import type pg from 'pg';
import { DATABASE_ERROR_CODES, DatabaseError } from '../../shared/errors.js';
import { createChildLogger, createLogger } from '../../shared/logger.js';

const logger = createLogger();
const repoLogger = createChildLogger(logger, { module: 'document-blob-repository' });

type Queryable = pg.Pool | pg.PoolClient;

export type DocumentBlobStorageClass = 'standard' | 'nearline' | 'coldline' | 'archive';
export type DocumentBlobStorageStatus = 'active' | 'cold_storage' | 'pending_deletion' | 'deleted';
export type DocumentBlobIntegrityStatus = 'verified' | 'unverified' | 'corrupted';

export interface DocumentBlob {
	contentHash: string;
	mulderBlobId: string;
	storagePath: string;
	storageUri: string;
	mimeType: string | null;
	fileSizeBytes: number;
	storageClass: DocumentBlobStorageClass;
	storageStatus: DocumentBlobStorageStatus;
	originalFilenames: string[];
	firstIngestedAt: Date;
	lastAccessedAt: Date;
	integrityVerifiedAt: Date | null;
	integrityStatus: DocumentBlobIntegrityStatus;
	createdAt: Date;
	updatedAt: Date;
}

export interface UpsertDocumentBlobInput {
	contentHash: string;
	storagePath: string;
	storageUri: string;
	mimeType?: string | null;
	fileSizeBytes: number;
	storageClass?: DocumentBlobStorageClass;
	storageStatus?: DocumentBlobStorageStatus;
	originalFilenames?: string[];
	integrityVerifiedAt?: Date | null;
	integrityStatus?: DocumentBlobIntegrityStatus;
}

interface DocumentBlobRow {
	content_hash: string;
	mulder_blob_id: string;
	storage_path: string;
	storage_uri: string;
	mime_type: string | null;
	file_size_bytes: string | number;
	storage_class: DocumentBlobStorageClass;
	storage_status: DocumentBlobStorageStatus;
	original_filenames: string[] | string;
	first_ingested_at: Date;
	last_accessed_at: Date;
	integrity_verified_at: Date | null;
	integrity_status: DocumentBlobIntegrityStatus;
	created_at: Date;
	updated_at: Date;
}

function parseStringArray(value: string[] | string): string[] {
	if (Array.isArray(value)) {
		return value;
	}

	return value
		.replace(/^{|}$/g, '')
		.split(',')
		.map((entry) => entry.trim().replace(/^"|"$/g, ''))
		.filter((entry) => entry.length > 0);
}

function mapDocumentBlobRow(row: DocumentBlobRow): DocumentBlob {
	return {
		contentHash: row.content_hash,
		mulderBlobId: row.mulder_blob_id,
		storagePath: row.storage_path,
		storageUri: row.storage_uri,
		mimeType: row.mime_type,
		fileSizeBytes:
			typeof row.file_size_bytes === 'number' ? row.file_size_bytes : Number.parseInt(row.file_size_bytes, 10),
		storageClass: row.storage_class,
		storageStatus: row.storage_status,
		originalFilenames: parseStringArray(row.original_filenames),
		firstIngestedAt: row.first_ingested_at,
		lastAccessedAt: row.last_accessed_at,
		integrityVerifiedAt: row.integrity_verified_at,
		integrityStatus: row.integrity_status,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function normalizeOriginalFilenames(filenames: string[] | undefined): string[] {
	const normalized: string[] = [];
	for (const filename of filenames ?? []) {
		const trimmed = filename.trim();
		if (trimmed.length > 0 && !normalized.includes(trimmed)) {
			normalized.push(trimmed);
		}
	}
	return normalized;
}

export async function upsertDocumentBlob(pool: Queryable, input: UpsertDocumentBlobInput): Promise<DocumentBlob> {
	const originalFilenames = normalizeOriginalFilenames(input.originalFilenames);
	const sql = `
    INSERT INTO document_blobs (
      content_hash,
      storage_path,
      storage_uri,
      mime_type,
      file_size_bytes,
      storage_class,
      storage_status,
      original_filenames,
      integrity_verified_at,
      integrity_status
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    ON CONFLICT (content_hash) DO UPDATE SET
      original_filenames = (
        SELECT COALESCE(array_agg(filename ORDER BY first_seen), '{}'::text[])
        FROM (
          SELECT filename, min(position) AS first_seen
          FROM unnest(document_blobs.original_filenames || EXCLUDED.original_filenames)
            WITH ORDINALITY AS merged(filename, position)
          WHERE filename <> ''
          GROUP BY filename
        ) deduplicated
      ),
      last_accessed_at = now(),
      updated_at = now()
    RETURNING *
  `;
	const values = [
		input.contentHash,
		input.storagePath,
		input.storageUri,
		input.mimeType ?? null,
		input.fileSizeBytes,
		input.storageClass ?? 'standard',
		input.storageStatus ?? 'active',
		originalFilenames,
		input.integrityVerifiedAt ?? null,
		input.integrityStatus ?? 'unverified',
	];

	try {
		const result = await pool.query<DocumentBlobRow>(sql, values);
		const row = result.rows[0];
		repoLogger.debug({ contentHash: input.contentHash, storagePath: row.storage_path }, 'Document blob upserted');
		return mapDocumentBlobRow(row);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to upsert document blob', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { contentHash: input.contentHash, storagePath: input.storagePath },
		});
	}
}

export async function findDocumentBlobByHash(pool: Queryable, contentHash: string): Promise<DocumentBlob | null> {
	const sql = 'SELECT * FROM document_blobs WHERE content_hash = $1';

	try {
		const result = await pool.query<DocumentBlobRow>(sql, [contentHash]);
		if (result.rows.length === 0) {
			return null;
		}
		return mapDocumentBlobRow(result.rows[0]);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to find document blob by hash', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { contentHash },
		});
	}
}
