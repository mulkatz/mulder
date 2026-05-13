import type pg from 'pg';
import { DATABASE_ERROR_CODES, DatabaseError } from '../../shared/errors.js';
import type { CreateIntakeEnrichmentSuggestionInput, IntakeEnrichmentSuggestion } from './intake-enrichment.types.js';

type Queryable = pg.Pool | pg.PoolClient;

interface IntakeEnrichmentSuggestionRow {
	id: string;
	source_id: string;
	storage_path: string;
	filename: string;
	file_hash: string | null;
	model: string;
	prompt_version: string;
	suggested_payload: Record<string, unknown>;
	field_confidence: Record<string, unknown>;
	warnings: unknown;
	requested_by: Record<string, unknown>;
	created_at: Date;
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function mapIntakeEnrichmentSuggestion(row: IntakeEnrichmentSuggestionRow): IntakeEnrichmentSuggestion {
	return {
		id: row.id,
		sourceId: row.source_id,
		storagePath: row.storage_path,
		filename: row.filename,
		fileHash: row.file_hash,
		model: row.model,
		promptVersion: row.prompt_version,
		suggestedPayload: row.suggested_payload ?? {},
		fieldConfidence: row.field_confidence ?? {},
		warnings: stringArray(row.warnings),
		requestedBy: row.requested_by ?? {},
		createdAt: row.created_at,
	};
}

export async function createIntakeEnrichmentSuggestion(
	pool: Queryable,
	input: CreateIntakeEnrichmentSuggestionInput,
): Promise<IntakeEnrichmentSuggestion> {
	try {
		const result = await pool.query<IntakeEnrichmentSuggestionRow>(
			`
				INSERT INTO intake_enrichment_suggestions (
					source_id,
					storage_path,
					filename,
					file_hash,
					model,
					prompt_version,
					suggested_payload,
					field_confidence,
					warnings,
					requested_by
				)
				VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb)
				RETURNING *
			`,
			[
				input.sourceId,
				input.storagePath,
				input.filename,
				input.fileHash ?? null,
				input.model,
				input.promptVersion,
				JSON.stringify(input.suggestedPayload),
				JSON.stringify(input.fieldConfidence ?? {}),
				JSON.stringify(input.warnings ?? []),
				JSON.stringify(input.requestedBy ?? {}),
			],
		);
		return mapIntakeEnrichmentSuggestion(result.rows[0]);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to create intake enrichment suggestion', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { sourceId: input.sourceId, storagePath: input.storagePath },
		});
	}
}

export async function findIntakeEnrichmentSuggestionById(
	pool: Queryable,
	id: string,
): Promise<IntakeEnrichmentSuggestion | null> {
	try {
		const result = await pool.query<IntakeEnrichmentSuggestionRow>(
			'SELECT * FROM intake_enrichment_suggestions WHERE id = $1',
			[id],
		);
		const row = result.rows[0];
		return row ? mapIntakeEnrichmentSuggestion(row) : null;
	} catch (error: unknown) {
		throw new DatabaseError('Failed to find intake enrichment suggestion', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { id },
		});
	}
}
