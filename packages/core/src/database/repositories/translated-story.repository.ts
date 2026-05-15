import type pg from 'pg';
import { allowedSensitivityLevelsForMax } from '../../shared/access-control.js';
import { DATABASE_ERROR_CODES, DatabaseError } from '../../shared/errors.js';
import { normalizeSensitivityMetadata, stringifySensitivityMetadata } from '../../shared/sensitivity.js';
import { type EntityRow, mapEntityRow } from './entity.repository.js';
import type {
	CreateTranslatedStoryBundleInput,
	CreateTranslatedStoryMentionInput,
	TranslatedMentionMethod,
	TranslatedStory,
	TranslatedStoryEntityMention,
} from './translated-story.types.js';

type Queryable = pg.Pool | pg.PoolClient;

interface TranslatedStoryRow {
	id: string;
	translation_id: string;
	story_id: string;
	source_document_id: string;
	source_language: string;
	target_language: string;
	title: string;
	subtitle: string | null;
	markdown: string;
	content_hash: string;
	sensitivity_level: TranslatedStory['sensitivityLevel'];
	sensitivity_metadata: unknown;
	created_at: Date;
	updated_at: Date;
}

interface MentionRow {
	id: string;
	translated_story_id: string;
	entity_id: string;
	surface_text: string;
	start_offset: number;
	end_offset: number;
	confidence: number | null;
	method: TranslatedMentionMethod;
	created_at: Date;
}

interface MentionWithEntityRow extends MentionRow {
	entity_id_value: string;
	entity_canonical_id: string | null;
	entity_name: string;
	entity_type: string;
	entity_geom: EntityRow['geom'];
	entity_attributes: EntityRow['attributes'];
	entity_corroboration_score: number | null;
	entity_source_count: number;
	entity_taxonomy_status: EntityRow['taxonomy_status'];
	entity_taxonomy_id: string | null;
	entity_provenance: EntityRow['provenance'];
	entity_sensitivity_level: EntityRow['sensitivity_level'];
	entity_sensitivity_metadata: EntityRow['sensitivity_metadata'];
	entity_created_at: Date;
	entity_updated_at: Date;
}

function mapMention(row: MentionRow): TranslatedStoryEntityMention {
	return {
		id: row.id,
		translatedStoryId: row.translated_story_id,
		entityId: row.entity_id,
		surfaceText: row.surface_text,
		startOffset: row.start_offset,
		endOffset: row.end_offset,
		confidence: row.confidence,
		method: row.method,
		createdAt: row.created_at,
	};
}

function mapTranslatedStory(row: TranslatedStoryRow, mentions: TranslatedStoryEntityMention[] = []): TranslatedStory {
	return {
		id: row.id,
		translationId: row.translation_id,
		storyId: row.story_id,
		sourceDocumentId: row.source_document_id,
		sourceLanguage: row.source_language,
		targetLanguage: row.target_language,
		title: row.title,
		subtitle: row.subtitle,
		markdown: row.markdown,
		contentHash: row.content_hash,
		sensitivityLevel: row.sensitivity_level ?? 'internal',
		sensitivityMetadata: normalizeSensitivityMetadata(row.sensitivity_metadata, row.sensitivity_level ?? 'internal'),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		mentions,
	};
}

async function createTranslatedStoryMention(
	pool: Queryable,
	input: CreateTranslatedStoryMentionInput,
): Promise<TranslatedStoryEntityMention> {
	const result = await pool.query<MentionRow>(
		`
			INSERT INTO translated_story_entity_mentions (
				translated_story_id,
				entity_id,
				surface_text,
				start_offset,
				end_offset,
				confidence,
				method
			)
			VALUES ($1, $2, $3, $4, $5, $6, $7)
			RETURNING *
		`,
		[
			input.translatedStoryId,
			input.entityId,
			input.surfaceText,
			input.startOffset,
			input.endOffset,
			input.confidence ?? null,
			input.method,
		],
	);
	return mapMention(result.rows[0]);
}

export async function createTranslatedStoryBundle(
	pool: Queryable,
	input: CreateTranslatedStoryBundleInput,
): Promise<TranslatedStory> {
	const sensitivityLevel = input.sensitivityLevel ?? 'internal';
	try {
		const result = await pool.query<TranslatedStoryRow>(
			`
				INSERT INTO translated_stories (
					translation_id,
					story_id,
					source_document_id,
					source_language,
					target_language,
					title,
					subtitle,
					markdown,
					content_hash,
					sensitivity_level,
					sensitivity_metadata
				)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
				ON CONFLICT (translation_id, story_id) DO UPDATE SET
					title = EXCLUDED.title,
					subtitle = EXCLUDED.subtitle,
					markdown = EXCLUDED.markdown,
					content_hash = EXCLUDED.content_hash,
					sensitivity_level = EXCLUDED.sensitivity_level,
					sensitivity_metadata = EXCLUDED.sensitivity_metadata,
					updated_at = now()
				RETURNING *
			`,
			[
				input.translationId,
				input.storyId,
				input.sourceDocumentId,
				input.sourceLanguage,
				input.targetLanguage,
				input.title,
				input.subtitle ?? null,
				input.markdown,
				input.contentHash,
				sensitivityLevel,
				stringifySensitivityMetadata(input.sensitivityMetadata, sensitivityLevel),
			],
		);
		const story = result.rows[0];
		await pool.query('DELETE FROM translated_story_entity_mentions WHERE translated_story_id = $1', [story.id]);
		const mentions: TranslatedStoryEntityMention[] = [];
		for (const mention of input.mentions ?? []) {
			mentions.push(
				await createTranslatedStoryMention(pool, {
					...mention,
					translatedStoryId: story.id,
				}),
			);
		}
		return mapTranslatedStory(story, mentions);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to create translated story', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { translationId: input.translationId, storyId: input.storyId },
		});
	}
}

export async function countTranslatedStoriesForTranslation(
	pool: Queryable,
	translationId: string,
	options?: { maxSensitivityLevel?: TranslatedStory['sensitivityLevel'] },
): Promise<number> {
	const params: unknown[] = [translationId];
	const sensitivityClause = options?.maxSensitivityLevel ? 'AND sensitivity_level = ANY($2)' : '';
	if (options?.maxSensitivityLevel) {
		params.push(allowedSensitivityLevelsForMax(options.maxSensitivityLevel));
	}
	const result = await pool.query<{ count: string }>(
		`
			SELECT COUNT(*) AS count
			FROM translated_stories
			WHERE translation_id = $1
				${sensitivityClause}
		`,
		params,
	);
	return Number.parseInt(result.rows[0]?.count ?? '0', 10) || 0;
}

export async function listTranslatedStoriesForTranslation(
	pool: Queryable,
	translationId: string,
	options?: { maxSensitivityLevel?: TranslatedStory['sensitivityLevel'] },
): Promise<TranslatedStory[]> {
	const params: unknown[] = [translationId];
	const sensitivityClause = options?.maxSensitivityLevel ? 'AND ts.sensitivity_level = ANY($2)' : '';
	if (options?.maxSensitivityLevel) {
		params.push(allowedSensitivityLevelsForMax(options.maxSensitivityLevel));
	}
	try {
		const storyResult = await pool.query<TranslatedStoryRow>(
			`
				SELECT ts.*
				FROM translated_stories ts
				JOIN stories s ON s.id = ts.story_id
				JOIN sources src ON src.id = ts.source_document_id
				JOIN translated_documents td ON td.id = ts.translation_id
				WHERE ts.translation_id = $1
					AND td.status = 'current'
					AND src.deletion_status NOT IN ('soft_deleted', 'purging', 'purged')
					${sensitivityClause}
				ORDER BY s.page_start ASC NULLS LAST, s.created_at ASC
			`,
			params,
		);
		if (storyResult.rows.length === 0) {
			return [];
		}
		const translatedStoryIds = storyResult.rows.map((row) => row.id);
		const mentionParams: unknown[] = [translatedStoryIds];
		const mentionSensitivityClause = options?.maxSensitivityLevel ? 'AND e.sensitivity_level = ANY($2)' : '';
		if (options?.maxSensitivityLevel) {
			mentionParams.push(allowedSensitivityLevelsForMax(options.maxSensitivityLevel));
		}
		const mentionResult = await pool.query<MentionWithEntityRow>(
			`
				SELECT
					m.*,
					e.id AS entity_id_value,
					e.canonical_id AS entity_canonical_id,
					e.name AS entity_name,
					e.type AS entity_type,
					e.geom AS entity_geom,
					e.attributes AS entity_attributes,
					e.corroboration_score AS entity_corroboration_score,
					e.source_count AS entity_source_count,
					e.taxonomy_status AS entity_taxonomy_status,
					e.taxonomy_id AS entity_taxonomy_id,
					e.provenance AS entity_provenance,
					e.sensitivity_level AS entity_sensitivity_level,
					e.sensitivity_metadata AS entity_sensitivity_metadata,
					e.created_at AS entity_created_at,
					e.updated_at AS entity_updated_at
				FROM translated_story_entity_mentions m
				JOIN entities e ON e.id = m.entity_id
				WHERE m.translated_story_id = ANY($1::uuid[])
					${mentionSensitivityClause}
				ORDER BY m.start_offset ASC, m.end_offset ASC
			`,
			mentionParams,
		);
		const mentionsByStory = new Map<string, TranslatedStoryEntityMention[]>();
		for (const row of mentionResult.rows) {
			const mention = {
				...mapMention(row),
				entity: mapEntityRow({
					id: row.entity_id_value,
					canonical_id: row.entity_canonical_id,
					name: row.entity_name,
					type: row.entity_type,
					geom: row.entity_geom,
					attributes: row.entity_attributes,
					corroboration_score: row.entity_corroboration_score,
					source_count: row.entity_source_count,
					taxonomy_status: row.entity_taxonomy_status,
					taxonomy_id: row.entity_taxonomy_id,
					provenance: row.entity_provenance,
					sensitivity_level: row.entity_sensitivity_level,
					sensitivity_metadata: row.entity_sensitivity_metadata,
					created_at: row.entity_created_at,
					updated_at: row.entity_updated_at,
				}),
			};
			const current = mentionsByStory.get(row.translated_story_id) ?? [];
			current.push(mention);
			mentionsByStory.set(row.translated_story_id, current);
		}
		return storyResult.rows.map((row) => mapTranslatedStory(row, mentionsByStory.get(row.id) ?? []));
	} catch (error: unknown) {
		throw new DatabaseError('Failed to list translated stories', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { translationId },
		});
	}
}
