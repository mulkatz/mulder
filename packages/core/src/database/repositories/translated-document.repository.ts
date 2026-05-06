import type pg from 'pg';
import { DATABASE_ERROR_CODES, DatabaseError } from '../../shared/errors.js';
import { createChildLogger, createLogger } from '../../shared/logger.js';
import { normalizeSensitivityMetadata, stringifySensitivityMetadata } from '../../shared/sensitivity.js';
import type {
	CreateCurrentTranslatedDocumentInput,
	ListTranslatedDocumentsOptions,
	TranslatedDocument,
	TranslationOutputFormat,
	TranslationPipelinePath,
	TranslationStatus,
} from './translated-document.types.js';

const logger = createLogger();
const repoLogger = createChildLogger(logger, { module: 'translated-document-repository' });

type Queryable = pg.Pool | pg.PoolClient;

interface TranslatedDocumentRow {
	id: string;
	source_document_id: string;
	source_language: string;
	target_language: string;
	translation_engine: string;
	translation_date: Date;
	content: string;
	content_hash: string;
	status: TranslationStatus;
	pipeline_path: TranslationPipelinePath;
	output_format: TranslationOutputFormat;
	sensitivity_level: TranslatedDocument['sensitivityLevel'];
	sensitivity_metadata: unknown;
	created_at: Date;
	updated_at: Date;
}

function hasConnect(queryable: Queryable): queryable is pg.Pool {
	return typeof Reflect.get(queryable, 'connect') === 'function';
}

function mapTranslatedDocumentRow(row: TranslatedDocumentRow): TranslatedDocument {
	return {
		id: row.id,
		sourceDocumentId: row.source_document_id,
		sourceLanguage: row.source_language,
		targetLanguage: row.target_language,
		translationEngine: row.translation_engine,
		translationDate: row.translation_date,
		content: row.content,
		contentHash: row.content_hash,
		status: row.status,
		pipelinePath: row.pipeline_path,
		outputFormat: row.output_format,
		sensitivityLevel: row.sensitivity_level ?? 'internal',
		sensitivityMetadata: normalizeSensitivityMetadata(row.sensitivity_metadata, row.sensitivity_level ?? 'internal'),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

async function insertCurrentTranslatedDocument(
	client: Queryable,
	input: CreateCurrentTranslatedDocumentInput,
): Promise<TranslatedDocument> {
	const sensitivityLevel = input.sensitivityLevel ?? 'internal';
	await client.query(
		`
			UPDATE translated_documents
			SET status = 'stale', updated_at = now()
			WHERE source_document_id = $1
				AND target_language = $2
				AND status = 'current'
		`,
		[input.sourceDocumentId, input.targetLanguage],
	);

	const result = await client.query<TranslatedDocumentRow>(
		`
			INSERT INTO translated_documents (
				source_document_id,
				source_language,
				target_language,
				translation_engine,
				translation_date,
				content,
				content_hash,
				status,
				pipeline_path,
				output_format,
				sensitivity_level,
				sensitivity_metadata
			)
			VALUES ($1, $2, $3, $4, COALESCE($5, now()), $6, $7, 'current', $8, $9, $10, $11::jsonb)
			RETURNING *
		`,
		[
			input.sourceDocumentId,
			input.sourceLanguage,
			input.targetLanguage,
			input.translationEngine,
			input.translationDate ?? null,
			input.content,
			input.contentHash,
			input.pipelinePath,
			input.outputFormat,
			sensitivityLevel,
			stringifySensitivityMetadata(input.sensitivityMetadata, sensitivityLevel),
		],
	);
	return mapTranslatedDocumentRow(result.rows[0]);
}

export async function createCurrentTranslatedDocument(
	pool: Queryable,
	input: CreateCurrentTranslatedDocumentInput,
): Promise<TranslatedDocument> {
	try {
		if (!hasConnect(pool)) {
			const row = await insertCurrentTranslatedDocument(pool, input);
			repoLogger.debug(
				{ sourceId: input.sourceDocumentId, targetLanguage: input.targetLanguage },
				'Translation inserted',
			);
			return row;
		}

		const client = await pool.connect();
		try {
			await client.query('BEGIN');
			const row = await insertCurrentTranslatedDocument(client, input);
			await client.query('COMMIT');
			repoLogger.debug(
				{ sourceId: input.sourceDocumentId, targetLanguage: input.targetLanguage },
				'Translation inserted',
			);
			return row;
		} catch (error: unknown) {
			await client.query('ROLLBACK').catch(() => {});
			throw error;
		} finally {
			client.release();
		}
	} catch (error: unknown) {
		throw new DatabaseError('Failed to create translated document', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { sourceDocumentId: input.sourceDocumentId, targetLanguage: input.targetLanguage },
		});
	}
}

export async function findCurrentTranslatedDocument(
	pool: Queryable,
	sourceDocumentId: string,
	targetLanguage: string,
	options?: { includeDeletedSources?: boolean },
): Promise<TranslatedDocument | null> {
	const sql = `
		SELECT translated_documents.*
		FROM translated_documents
		JOIN sources ON sources.id = translated_documents.source_document_id
		WHERE translated_documents.source_document_id = $1
			AND translated_documents.target_language = $2
			AND translated_documents.status = 'current'
			${options?.includeDeletedSources ? '' : "AND sources.deletion_status NOT IN ('soft_deleted', 'purging', 'purged')"}
	`;

	try {
		const result = await pool.query<TranslatedDocumentRow>(sql, [sourceDocumentId, targetLanguage]);
		const row = result.rows[0];
		return row ? mapTranslatedDocumentRow(row) : null;
	} catch (error: unknown) {
		throw new DatabaseError('Failed to find current translated document', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { sourceDocumentId, targetLanguage },
		});
	}
}

export async function listTranslatedDocumentsForSource(
	pool: Queryable,
	sourceDocumentId: string,
	options?: ListTranslatedDocumentsOptions,
): Promise<TranslatedDocument[]> {
	const conditions = ['translated_documents.source_document_id = $1'];
	const params: unknown[] = [sourceDocumentId];
	let paramIndex = 2;

	if (!options?.includeDeletedSources) {
		conditions.push("sources.deletion_status NOT IN ('soft_deleted', 'purging', 'purged')");
	}
	if (options?.targetLanguage) {
		conditions.push(`translated_documents.target_language = $${paramIndex}`);
		params.push(options.targetLanguage);
		paramIndex++;
	}
	if (options?.status) {
		conditions.push(`translated_documents.status = $${paramIndex}`);
		params.push(options.status);
		paramIndex++;
	}

	const limit = options?.limit ?? 100;
	const offset = options?.offset ?? 0;
	params.push(limit, offset);

	const sql = `
		SELECT translated_documents.*
		FROM translated_documents
		JOIN sources ON sources.id = translated_documents.source_document_id
		WHERE ${conditions.join(' AND ')}
		ORDER BY translation_date DESC, id DESC
		LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
	`;

	try {
		const result = await pool.query<TranslatedDocumentRow>(sql, params);
		return result.rows.map(mapTranslatedDocumentRow);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to list translated documents', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { sourceDocumentId, options },
		});
	}
}

export async function markTranslatedDocumentsStaleForSource(
	pool: Queryable,
	sourceDocumentId: string,
): Promise<number> {
	try {
		const result = await pool.query(
			`
				UPDATE translated_documents
				SET status = 'stale', updated_at = now()
				WHERE source_document_id = $1
					AND status = 'current'
			`,
			[sourceDocumentId],
		);
		return result.rowCount ?? 0;
	} catch (error: unknown) {
		throw new DatabaseError('Failed to mark translated documents stale', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { sourceDocumentId },
		});
	}
}

export async function deleteTranslatedDocumentsForSource(pool: Queryable, sourceDocumentId: string): Promise<number> {
	try {
		const result = await pool.query('DELETE FROM translated_documents WHERE source_document_id = $1', [
			sourceDocumentId,
		]);
		return result.rowCount ?? 0;
	} catch (error: unknown) {
		throw new DatabaseError('Failed to delete translated documents', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { sourceDocumentId },
		});
	}
}
