import type pg from 'pg';
import { DATABASE_ERROR_CODES, DatabaseError } from '../../shared/errors.js';
import { normalizeSensitivityMetadata, stringifySensitivityMetadata } from '../../shared/sensitivity.js';
import {
	mapArtifactProvenanceFromDb,
	mergeArtifactProvenanceSql,
	stringifyArtifactProvenance,
} from './artifact-provenance.js';
import type {
	AssertionType,
	ClassificationProvenance,
	ConfidenceMetadata,
	KnowledgeAssertion,
	ListKnowledgeAssertionsInput,
	UpsertKnowledgeAssertionInput,
} from './knowledge-assertion.types.js';

type Queryable = pg.Pool | pg.PoolClient;

const ASSERTION_TYPES: readonly AssertionType[] = ['observation', 'interpretation', 'hypothesis'] as const;
const CLASSIFICATION_PROVENANCE_VALUES: readonly ClassificationProvenance[] = [
	'llm_auto',
	'human_reviewed',
	'author_explicit',
] as const;

interface KnowledgeAssertionRow {
	id: string;
	source_id: string;
	story_id: string;
	assertion_type: AssertionType;
	content: string;
	confidence_metadata: unknown;
	classification_provenance: ClassificationProvenance;
	extracted_entity_ids: string[];
	provenance: unknown;
	quality_metadata: unknown;
	sensitivity_level: KnowledgeAssertion['sensitivityLevel'];
	sensitivity_metadata: unknown;
	created_at: Date;
	updated_at: Date;
	deleted_at: Date | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readBoolean(value: unknown): boolean {
	return typeof value === 'boolean' ? value : false;
}

function readNullableNumber(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
	if (typeof value !== 'string') {
		return fallback;
	}
	for (const item of allowed) {
		if (item === value) {
			return item;
		}
	}
	return fallback;
}

function assertKnownEnum<T extends string>(value: T, allowed: readonly T[], field: string): void {
	if (!allowed.includes(value)) {
		throw new DatabaseError(`Invalid knowledge assertion ${field}: ${value}`, DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			context: { field, value },
		});
	}
}

function normalizeUuidArray(value: readonly unknown[] | undefined): string[] {
	if (!value) {
		return [];
	}

	const unique = new Set<string>();
	for (const item of value) {
		if (typeof item === 'string' && item.trim().length > 0) {
			unique.add(item.trim());
		}
	}
	return [...unique].sort();
}

export function normalizeConfidenceMetadata(value: unknown): ConfidenceMetadata {
	const root = isRecord(value) ? value : {};
	return {
		witnessCount: readNullableNumber(root.witnessCount ?? root.witness_count),
		measurementBased: readBoolean(root.measurementBased ?? root.measurement_based),
		contemporaneous: readBoolean(root.contemporaneous),
		corroborated: readBoolean(root.corroborated),
		peerReviewed: readBoolean(root.peerReviewed ?? root.peer_reviewed),
		authorIsInterpreter: readBoolean(root.authorIsInterpreter ?? root.author_is_interpreter),
	};
}

function mapConfidenceMetadataToDb(value: ConfidenceMetadata): Record<string, unknown> {
	return {
		witness_count: value.witnessCount,
		measurement_based: value.measurementBased,
		contemporaneous: value.contemporaneous,
		corroborated: value.corroborated,
		peer_reviewed: value.peerReviewed,
		author_is_interpreter: value.authorIsInterpreter,
	};
}

function normalizeQualityMetadata(value: unknown): Record<string, unknown> | null {
	if (!isRecord(value)) {
		return null;
	}
	return { ...value };
}

function mapKnowledgeAssertionRow(row: KnowledgeAssertionRow): KnowledgeAssertion {
	return {
		id: row.id,
		sourceId: row.source_id,
		storyId: row.story_id,
		assertionType: enumValue(row.assertion_type, ASSERTION_TYPES, 'interpretation'),
		content: row.content,
		confidenceMetadata: normalizeConfidenceMetadata(row.confidence_metadata),
		classificationProvenance: enumValue(row.classification_provenance, CLASSIFICATION_PROVENANCE_VALUES, 'llm_auto'),
		extractedEntityIds: normalizeUuidArray(row.extracted_entity_ids),
		provenance: mapArtifactProvenanceFromDb(row.provenance),
		qualityMetadata: normalizeQualityMetadata(row.quality_metadata),
		sensitivityLevel: row.sensitivity_level ?? 'internal',
		sensitivityMetadata: normalizeSensitivityMetadata(row.sensitivity_metadata, row.sensitivity_level ?? 'internal'),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		deletedAt: row.deleted_at,
	};
}

function listSuffix(
	options: ListKnowledgeAssertionsInput | undefined,
	startIndex: number,
): { sql: string; params: unknown[] } {
	const params: unknown[] = [];
	let sql = '';

	if (options?.limit !== undefined) {
		params.push(options.limit);
		sql += ` LIMIT $${startIndex + params.length - 1}`;
	}

	if (options?.offset !== undefined) {
		params.push(options.offset);
		sql += ` OFFSET $${startIndex + params.length - 1}`;
	}

	return { sql, params };
}

export async function upsertKnowledgeAssertion(
	pool: Queryable,
	input: UpsertKnowledgeAssertionInput,
): Promise<KnowledgeAssertion> {
	assertKnownEnum(input.assertionType, ASSERTION_TYPES, 'assertionType');
	const classificationProvenance = input.classificationProvenance ?? 'llm_auto';
	assertKnownEnum(classificationProvenance, CLASSIFICATION_PROVENANCE_VALUES, 'classificationProvenance');
	const sensitivityLevel = input.sensitivityLevel ?? 'internal';

	const sql = `
		INSERT INTO knowledge_assertions (
			source_id,
			story_id,
			assertion_type,
			content,
			confidence_metadata,
			classification_provenance,
			extracted_entity_ids,
			provenance,
			quality_metadata,
			sensitivity_level,
			sensitivity_metadata
		)
		VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::uuid[], $8::jsonb, $9::jsonb, $10, $11::jsonb)
		ON CONFLICT (source_id, story_id, content, assertion_type)
		WHERE deleted_at IS NULL
		DO UPDATE SET
			confidence_metadata = EXCLUDED.confidence_metadata,
			classification_provenance = CASE
				WHEN EXCLUDED.classification_provenance IN ('human_reviewed', 'author_explicit')
					THEN EXCLUDED.classification_provenance
				WHEN knowledge_assertions.classification_provenance IN ('human_reviewed', 'author_explicit')
					THEN knowledge_assertions.classification_provenance
				ELSE EXCLUDED.classification_provenance
			END,
			extracted_entity_ids = EXCLUDED.extracted_entity_ids,
			provenance = ${mergeArtifactProvenanceSql('knowledge_assertions.provenance', 'EXCLUDED.provenance')},
			quality_metadata = COALESCE(EXCLUDED.quality_metadata, knowledge_assertions.quality_metadata),
			sensitivity_level = EXCLUDED.sensitivity_level,
			sensitivity_metadata = EXCLUDED.sensitivity_metadata,
			updated_at = now()
		RETURNING *
	`;

	try {
		const result = await pool.query<KnowledgeAssertionRow>(sql, [
			input.sourceId,
			input.storyId,
			input.assertionType,
			input.content,
			JSON.stringify(mapConfidenceMetadataToDb(input.confidenceMetadata)),
			classificationProvenance,
			normalizeUuidArray(input.extractedEntityIds),
			stringifyArtifactProvenance(input.provenance),
			input.qualityMetadata ? JSON.stringify(input.qualityMetadata) : null,
			sensitivityLevel,
			stringifySensitivityMetadata(input.sensitivityMetadata, sensitivityLevel),
		]);
		return mapKnowledgeAssertionRow(result.rows[0]);
	} catch (error: unknown) {
		if (error instanceof DatabaseError) {
			throw error;
		}
		throw new DatabaseError('Failed to upsert knowledge assertion', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: {
				sourceId: input.sourceId,
				storyId: input.storyId,
				assertionType: input.assertionType,
			},
		});
	}
}

export async function listKnowledgeAssertionsForStory(
	pool: Queryable,
	storyId: string,
	options?: ListKnowledgeAssertionsInput,
): Promise<KnowledgeAssertion[]> {
	const suffix = listSuffix(options, 2);
	const sql = `
		SELECT *
		FROM knowledge_assertions
		WHERE story_id = $1
			${options?.includeDeleted ? '' : 'AND deleted_at IS NULL'}
		ORDER BY created_at, id
		${suffix.sql}
	`;

	try {
		const result = await pool.query<KnowledgeAssertionRow>(sql, [storyId, ...suffix.params]);
		return result.rows.map(mapKnowledgeAssertionRow);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to list knowledge assertions for story', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { storyId },
		});
	}
}

export async function listKnowledgeAssertionsForSource(
	pool: Queryable,
	sourceId: string,
	options?: ListKnowledgeAssertionsInput,
): Promise<KnowledgeAssertion[]> {
	const suffix = listSuffix(options, 2);
	const sql = `
		SELECT *
		FROM knowledge_assertions
		WHERE source_id = $1
			${options?.includeDeleted ? '' : 'AND deleted_at IS NULL'}
		ORDER BY created_at, id
		${suffix.sql}
	`;

	try {
		const result = await pool.query<KnowledgeAssertionRow>(sql, [sourceId, ...suffix.params]);
		return result.rows.map(mapKnowledgeAssertionRow);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to list knowledge assertions for source', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { sourceId },
		});
	}
}

export async function deleteKnowledgeAssertionsForStory(pool: Queryable, storyId: string): Promise<number> {
	try {
		const result = await pool.query('DELETE FROM knowledge_assertions WHERE story_id = $1', [storyId]);
		return result.rowCount ?? 0;
	} catch (error: unknown) {
		throw new DatabaseError('Failed to delete knowledge assertions for story', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { storyId },
		});
	}
}
