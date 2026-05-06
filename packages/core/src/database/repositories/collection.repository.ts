import type pg from 'pg';
import { CONFIG_DEFAULTS } from '../../config/defaults.js';
import { DATABASE_ERROR_CODES, DatabaseError } from '../../shared/errors.js';
import type { SensitivityLevel } from '../../shared/sensitivity.js';
import type {
	Collection,
	CollectionConfig,
	CollectionInput,
	CollectionListOptions,
	CollectionSummary,
	CollectionUpdateInput,
	ResolveCollectionForIngestInput,
} from './collection.types.js';

type Queryable = pg.Pool | pg.PoolClient;

interface CollectionRow {
	collection_id: string;
	name: string;
	description: string;
	type: Collection['type'];
	archive_id: string | null;
	created_by: string;
	visibility: Collection['visibility'];
	tags: string[] | string;
	default_sensitivity_level: SensitivityLevel;
	default_language: string;
	default_credibility_profile_id: string | null;
	created_at: Date | string;
	updated_at: Date | string;
}

interface CollectionSummaryRow extends CollectionRow {
	document_count: string | number;
	total_size_bytes: string | number;
	languages: string[] | string | null;
	date_range_earliest: Date | string | null;
	date_range_latest: Date | string | null;
}

function toDate(value: Date | string): Date {
	return value instanceof Date ? value : new Date(value);
}

function nullableDate(value: Date | string | null): Date | null {
	return value === null ? null : toDate(value);
}

function parseStringArray(value: string[] | string | null): string[] {
	if (!value) {
		return [];
	}
	if (Array.isArray(value)) {
		return value;
	}
	return value
		.replace(/^{|}$/g, '')
		.split(',')
		.map((entry) => entry.trim().replace(/^"|"$/g, ''))
		.filter((entry) => entry.length > 0);
}

function parseInteger(value: string | number): number {
	return typeof value === 'number' ? value : Number.parseInt(value, 10);
}

export function normalizeCollectionTags(tags: readonly string[] | undefined): string[] {
	return [...new Set((tags ?? []).map((tag) => tag.trim()).filter((tag) => tag.length > 0))].sort((a, b) =>
		a.localeCompare(b),
	);
}

function mapCollectionRow(row: CollectionRow): Collection {
	return {
		collectionId: row.collection_id,
		name: row.name,
		description: row.description,
		type: row.type,
		archiveId: row.archive_id,
		createdBy: row.created_by,
		visibility: row.visibility,
		tags: normalizeCollectionTags(parseStringArray(row.tags)),
		defaults: {
			sensitivityLevel: row.default_sensitivity_level,
			defaultLanguage: row.default_language,
			credibilityProfileId: row.default_credibility_profile_id,
		},
		createdAt: toDate(row.created_at),
		updatedAt: toDate(row.updated_at),
	};
}

function mapCollectionSummaryRow(row: CollectionSummaryRow): CollectionSummary {
	return {
		...mapCollectionRow(row),
		documentCount: parseInteger(row.document_count),
		totalSizeBytes: parseInteger(row.total_size_bytes),
		languages: normalizeCollectionTags(parseStringArray(row.languages)),
		dateRange: {
			earliest: nullableDate(row.date_range_earliest),
			latest: nullableDate(row.date_range_latest),
		},
	};
}

function collectionValues(input: CollectionInput): unknown[] {
	return [
		input.collectionId,
		input.name,
		input.description ?? '',
		input.type ?? 'other',
		input.archiveId ?? null,
		input.createdBy ?? 'system',
		input.visibility ?? 'private',
		normalizeCollectionTags(input.tags),
		input.defaults?.sensitivityLevel ?? 'internal',
		input.defaults?.defaultLanguage ?? 'und',
		input.defaults?.credibilityProfileId ?? null,
	];
}

export async function createCollection(pool: Queryable, input: CollectionInput): Promise<Collection> {
	const sql = `
		INSERT INTO collections (
			collection_id,
			name,
			description,
			type,
			archive_id,
			created_by,
			visibility,
			tags,
			default_sensitivity_level,
			default_language,
			default_credibility_profile_id
		)
		VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
		RETURNING *
	`;
	try {
		const result = await pool.query<CollectionRow>(sql, collectionValues(input));
		return mapCollectionRow(result.rows[0]);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to create collection', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { collectionId: input.collectionId, name: input.name },
		});
	}
}

export async function upsertArchiveMirrorCollection(pool: Queryable, input: CollectionInput): Promise<Collection> {
	if (!input.archiveId) {
		throw new DatabaseError('Archive mirror collection requires archiveId', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			context: { name: input.name },
		});
	}

	const sql = `
		INSERT INTO collections (
			collection_id,
			name,
			description,
			type,
			archive_id,
			created_by,
			visibility,
			tags,
			default_sensitivity_level,
			default_language,
			default_credibility_profile_id
		)
		VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
		ON CONFLICT (archive_id) WHERE type = 'archive_mirror' AND archive_id IS NOT NULL DO UPDATE SET
			name = EXCLUDED.name,
			description = EXCLUDED.description,
			visibility = EXCLUDED.visibility,
			tags = (
				SELECT COALESCE(array_agg(tag ORDER BY tag), '{}'::text[])
				FROM (
					SELECT DISTINCT tag
					FROM unnest(collections.tags || EXCLUDED.tags) AS merged(tag)
					WHERE tag <> ''
				) deduplicated
			),
			default_sensitivity_level = EXCLUDED.default_sensitivity_level,
			default_language = EXCLUDED.default_language,
			default_credibility_profile_id = EXCLUDED.default_credibility_profile_id,
			updated_at = now()
		RETURNING *
	`;
	try {
		const result = await pool.query<CollectionRow>(sql, collectionValues({ ...input, type: 'archive_mirror' }));
		return mapCollectionRow(result.rows[0]);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to upsert archive mirror collection', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { archiveId: input.archiveId, name: input.name },
		});
	}
}

export async function findCollectionById(pool: Queryable, collectionId: string): Promise<Collection | null> {
	const result = await pool.query<CollectionRow>('SELECT * FROM collections WHERE collection_id = $1', [collectionId]);
	return result.rows[0] ? mapCollectionRow(result.rows[0]) : null;
}

export async function findCollectionByName(pool: Queryable, name: string): Promise<Collection | null> {
	const result = await pool.query<CollectionRow>('SELECT * FROM collections WHERE name = $1', [name]);
	return result.rows[0] ? mapCollectionRow(result.rows[0]) : null;
}

export async function listCollections(pool: Queryable, options?: CollectionListOptions): Promise<Collection[]> {
	const params: unknown[] = [];
	const conditions: string[] = [];
	if (options?.type) {
		params.push(options.type);
		conditions.push(`type = $${params.length}`);
	}
	if (options?.visibility) {
		params.push(options.visibility);
		conditions.push(`visibility = $${params.length}`);
	}
	if (options?.archiveId) {
		params.push(options.archiveId);
		conditions.push(`archive_id = $${params.length}`);
	}
	if (options?.tag) {
		params.push(options.tag.trim());
		conditions.push(`$${params.length} = ANY(tags)`);
	}
	const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
	params.push(options?.limit ?? 100, options?.offset ?? 0);
	const result = await pool.query<CollectionRow>(
		`
			SELECT *
			FROM collections
			${whereClause}
			ORDER BY created_at DESC, name ASC, collection_id ASC
			LIMIT $${params.length - 1} OFFSET $${params.length}
		`,
		params,
	);
	return result.rows.map(mapCollectionRow);
}

export async function updateCollection(
	pool: Queryable,
	collectionId: string,
	patch: CollectionUpdateInput,
): Promise<Collection> {
	const current = await findCollectionById(pool, collectionId);
	if (!current) {
		throw new DatabaseError('Collection not found', DATABASE_ERROR_CODES.DB_NOT_FOUND, {
			context: { collectionId },
		});
	}

	const input: CollectionInput = {
		collectionId,
		name: patch.name ?? current.name,
		description: patch.description ?? current.description,
		type: patch.type ?? current.type,
		archiveId: patch.archiveId === undefined ? current.archiveId : patch.archiveId,
		createdBy: current.createdBy,
		visibility: patch.visibility ?? current.visibility,
		tags: current.tags,
		defaults: {
			sensitivityLevel: patch.defaults?.sensitivityLevel ?? current.defaults.sensitivityLevel,
			defaultLanguage: patch.defaults?.defaultLanguage ?? current.defaults.defaultLanguage,
			credibilityProfileId:
				patch.defaults?.credibilityProfileId === undefined
					? current.defaults.credibilityProfileId
					: patch.defaults.credibilityProfileId,
		},
	};

	const result = await pool.query<CollectionRow>(
		`
			UPDATE collections
			SET name = $2,
				description = $3,
				type = $4,
				archive_id = $5,
				visibility = $6,
				default_sensitivity_level = $7,
				default_language = $8,
				default_credibility_profile_id = $9,
				updated_at = now()
			WHERE collection_id = $1
			RETURNING *
		`,
		[
			input.collectionId,
			input.name,
			input.description,
			input.type,
			input.archiveId,
			input.visibility,
			input.defaults?.sensitivityLevel,
			input.defaults?.defaultLanguage,
			input.defaults?.credibilityProfileId ?? null,
		],
	);
	return mapCollectionRow(result.rows[0]);
}

export async function setCollectionTags(
	pool: Queryable,
	collectionId: string,
	tags: readonly string[],
): Promise<Collection> {
	const result = await pool.query<CollectionRow>(
		`
			UPDATE collections
			SET tags = $2,
				updated_at = now()
			WHERE collection_id = $1
			RETURNING *
		`,
		[collectionId, normalizeCollectionTags(tags)],
	);
	if (!result.rows[0]) {
		throw new DatabaseError('Collection not found', DATABASE_ERROR_CODES.DB_NOT_FOUND, {
			context: { collectionId },
		});
	}
	return mapCollectionRow(result.rows[0]);
}

export async function addCollectionTags(
	pool: Queryable,
	collectionId: string,
	tags: readonly string[],
): Promise<Collection> {
	const current = await findCollectionById(pool, collectionId);
	if (!current) {
		throw new DatabaseError('Collection not found', DATABASE_ERROR_CODES.DB_NOT_FOUND, {
			context: { collectionId },
		});
	}
	return setCollectionTags(pool, collectionId, [...current.tags, ...tags]);
}

export async function removeCollectionTags(
	pool: Queryable,
	collectionId: string,
	tags: readonly string[],
): Promise<Collection> {
	const current = await findCollectionById(pool, collectionId);
	if (!current) {
		throw new DatabaseError('Collection not found', DATABASE_ERROR_CODES.DB_NOT_FOUND, {
			context: { collectionId },
		});
	}
	const remove = new Set(normalizeCollectionTags(tags));
	return setCollectionTags(
		pool,
		collectionId,
		current.tags.filter((tag) => !remove.has(tag)),
	);
}

export async function summarizeCollection(pool: Queryable, collectionId: string): Promise<CollectionSummary | null> {
	const result = await pool.query<CollectionSummaryRow>(
		`
			SELECT
				c.*,
				(
					SELECT COUNT(DISTINCT ac.blob_content_hash)
					FROM acquisition_contexts ac
					WHERE ac.collection_id = c.collection_id
						AND ac.status IN ('active', 'restored')
				) AS document_count,
				(
					SELECT COALESCE(SUM(db.file_size_bytes), 0)
					FROM (
						SELECT DISTINCT ac.blob_content_hash
						FROM acquisition_contexts ac
						WHERE ac.collection_id = c.collection_id
							AND ac.status IN ('active', 'restored')
					) active_blobs
					JOIN document_blobs db ON db.content_hash = active_blobs.blob_content_hash
				) AS total_size_bytes,
				(
					SELECT COALESCE(array_agg(DISTINCT os.source_language) FILTER (WHERE os.source_language IS NOT NULL), '{}'::text[])
					FROM acquisition_contexts ac
					LEFT JOIN original_sources os ON os.context_id = ac.context_id
					WHERE ac.collection_id = c.collection_id
						AND ac.status IN ('active', 'restored')
				) AS languages,
				(
					SELECT LEAST(MIN(ac.submitted_at), MIN(al.recorded_at), MIN(al.valid_from))
					FROM acquisition_contexts ac
					LEFT JOIN archive_locations al ON al.blob_content_hash = ac.blob_content_hash
					WHERE ac.collection_id = c.collection_id
						AND ac.status IN ('active', 'restored')
				) AS date_range_earliest,
				(
					SELECT GREATEST(MAX(ac.submitted_at), MAX(al.recorded_at), MAX(al.valid_until))
					FROM acquisition_contexts ac
					LEFT JOIN archive_locations al ON al.blob_content_hash = ac.blob_content_hash
					WHERE ac.collection_id = c.collection_id
						AND ac.status IN ('active', 'restored')
				) AS date_range_latest
			FROM collections c
			WHERE c.collection_id = $1
		`,
		[collectionId],
	);
	return result.rows[0] ? mapCollectionSummaryRow(result.rows[0]) : null;
}

function defaultCollectionConfig(): CollectionConfig {
	return CONFIG_DEFAULTS.ingest_provenance.collections;
}

function resolveConfig(config: CollectionConfig | undefined): CollectionConfig {
	return config ?? defaultCollectionConfig();
}

function pathSegmentTags(input: ResolveCollectionForIngestInput): string[] {
	return normalizeCollectionTags(
		input.archiveLocation?.pathSegments?.map((segment) => {
			const slug = segment.name
				.trim()
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, '-')
				.replace(/^-|-$/g, '');
			return slug.length > 0 ? `${segment.segmentType}:${slug}` : '';
		}),
	);
}

export async function resolveCollectionForIngest(
	pool: Queryable,
	input: ResolveCollectionForIngestInput,
	config?: CollectionConfig,
): Promise<Collection | null> {
	const collectionConfig = resolveConfig(config);
	if (input.explicitCollectionId) {
		const collection = await findCollectionById(pool, input.explicitCollectionId);
		if (!collection) {
			throw new DatabaseError('Collection not found for ingest provenance', DATABASE_ERROR_CODES.DB_NOT_FOUND, {
				context: { collectionId: input.explicitCollectionId },
			});
		}
		return collectionConfig.auto_tag_from_path_segments
			? addCollectionTags(pool, collection.collectionId, pathSegmentTags(input))
			: collection;
	}

	const archiveId = input.archive && 'archiveId' in input.archive ? input.archive.archiveId : null;
	if (archiveId && collectionConfig.auto_create_from_archive) {
		const archiveName = input.archive && 'name' in input.archive ? input.archive.name : 'Archive';
		const collection = await upsertArchiveMirrorCollection(pool, {
			name: archiveName,
			description: `Mirror of archive ${archiveName}`,
			archiveId,
			createdBy: collectionConfig.default_collection?.created_by ?? input.submittedBy?.userId ?? 'system',
			visibility: collectionConfig.default_collection?.visibility ?? 'private',
			tags: collectionConfig.auto_tag_from_path_segments ? pathSegmentTags(input) : [],
			defaults: {
				sensitivityLevel: collectionConfig.default_sensitivity_level,
				defaultLanguage: collectionConfig.default_language,
				credibilityProfileId: collectionConfig.default_credibility_profile_id ?? null,
			},
		});
		return collectionConfig.auto_tag_from_path_segments
			? addCollectionTags(pool, collection.collectionId, pathSegmentTags(input))
			: collection;
	}

	const defaultPolicy = collectionConfig.default_collection;
	if (!defaultPolicy?.name) {
		return null;
	}
	const existing = await findCollectionByName(pool, defaultPolicy.name);
	const collection =
		existing ??
		(await createCollection(pool, {
			name: defaultPolicy.name,
			description: defaultPolicy.description ?? '',
			type: defaultPolicy.type ?? 'import_batch',
			createdBy: defaultPolicy.created_by ?? input.submittedBy?.userId ?? 'system',
			visibility: defaultPolicy.visibility ?? 'private',
			tags: defaultPolicy.tags ?? [],
			defaults: {
				sensitivityLevel: collectionConfig.default_sensitivity_level,
				defaultLanguage: collectionConfig.default_language,
				credibilityProfileId: collectionConfig.default_credibility_profile_id ?? null,
			},
		}));
	return collectionConfig.auto_tag_from_path_segments
		? addCollectionTags(pool, collection.collectionId, pathSegmentTags(input))
		: collection;
}
