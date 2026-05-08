import type pg from 'pg';
import { allowedSensitivityLevelsForMax } from '../../shared/access-control.js';
import { DATABASE_ERROR_CODES, DatabaseError } from '../../shared/errors.js';
import { normalizeSensitivityMetadata, stringifySensitivityMetadata } from '../../shared/sensitivity.js';
import {
	mapArtifactProvenanceFromDb,
	normalizeArtifactProvenance,
	stringifyArtifactProvenance,
} from './artifact-provenance.js';
import { upsertReviewableArtifact } from './review-workflow.repository.js';
import type {
	CredibilityProfileAuthor,
	CredibilityReviewStatus,
	CredibilitySourceType,
	SourceCredibilityProfile,
	SourceCredibilityProfileListOptions,
	UpsertSourceCredibilityProfileInput,
} from './source-credibility.types.js';

type Queryable = pg.Pool | pg.PoolClient;

const SOURCE_TYPES: readonly CredibilitySourceType[] = [
	'government',
	'academic',
	'journalist',
	'witness',
	'organization',
	'anonymous',
	'other',
] as const;
const AUTHORS: readonly CredibilityProfileAuthor[] = ['llm_auto', 'human', 'hybrid'] as const;
const STATUSES: readonly CredibilityReviewStatus[] = ['draft', 'reviewed', 'contested'] as const;

interface JoinedRow {
	profile_id: string;
	source_id: string;
	source_name: string;
	source_type: CredibilitySourceType;
	profile_author: CredibilityProfileAuthor;
	last_reviewed: Date | null;
	review_status: CredibilityReviewStatus;
	provenance: unknown;
	sensitivity_level: SourceCredibilityProfile['sensitivityLevel'];
	sensitivity_metadata: unknown;
	profile_created_at: Date;
	profile_updated_at: Date;
	dim_row_id: string | null;
	dimension_id: string | null;
	label: string | null;
	score: string | number | null;
	rationale: string | null;
	evidence_refs: string[] | null;
	known_factors: string[] | null;
	dim_created_at: Date | null;
	dim_updated_at: Date | null;
}

interface SourceTrustRow {
	id: string;
	sensitivity_level: SourceCredibilityProfile['sensitivityLevel'];
	sensitivity_metadata: unknown;
	created_at: Date;
}

function isPool(value: Queryable): value is pg.Pool {
	return 'connect' in value;
}

function fail(message: string, context: Record<string, unknown>): never {
	throw new DatabaseError(message, DATABASE_ERROR_CODES.DB_QUERY_FAILED, { context });
}

function assertEnum<T extends string>(value: T, allowed: readonly T[], field: string): void {
	if (!allowed.includes(value)) fail(`Invalid source credibility ${field}: ${value}`, { field, value });
}

function required(value: string, field: string): string {
	const trimmed = value.trim();
	if (!trimmed) fail(`Invalid source credibility ${field}: value is required`, { field });
	return trimmed;
}

function normalizeTextArray(value: readonly string[] | undefined): string[] {
	return [...new Set((value ?? []).map((item) => item.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function parseJsonValue(value: string): unknown {
	return JSON.parse(value);
}

function profileProvenanceForSource(
	sourceId: string,
	input: UpsertSourceCredibilityProfileInput['provenance'],
	sourceCreatedAt: Date,
) {
	const provenance = normalizeArtifactProvenance(
		input ?? { sourceDocumentIds: [sourceId], createdAt: sourceCreatedAt },
	);
	return {
		...provenance,
		sourceDocumentIds: [...new Set([...provenance.sourceDocumentIds, sourceId])].sort((left, right) =>
			left.localeCompare(right),
		),
	};
}

function validate(input: UpsertSourceCredibilityProfileInput): void {
	required(input.sourceId, 'sourceId');
	required(input.sourceName, 'sourceName');
	assertEnum(input.sourceType, SOURCE_TYPES, 'sourceType');
	assertEnum(input.profileAuthor ?? 'llm_auto', AUTHORS, 'profileAuthor');
	assertEnum(input.reviewStatus ?? 'draft', STATUSES, 'reviewStatus');
	if (input.dimensions.length === 0)
		fail('Source credibility profile requires dimensions', { sourceId: input.sourceId });
	for (const dimension of input.dimensions) {
		required(dimension.dimensionId, 'dimensionId');
		required(dimension.label, 'label');
		required(dimension.rationale, 'rationale');
		if (!Number.isFinite(dimension.score) || dimension.score < 0 || dimension.score > 1) {
			fail('Invalid source credibility dimension score', {
				dimensionId: dimension.dimensionId,
				score: dimension.score,
			});
		}
	}
}

function collectProfiles(rows: JoinedRow[]): SourceCredibilityProfile[] {
	const profiles = new Map<string, SourceCredibilityProfile>();
	for (const row of rows) {
		let profile = profiles.get(row.profile_id);
		if (!profile) {
			profile = {
				profileId: row.profile_id,
				sourceId: row.source_id,
				sourceName: row.source_name,
				sourceType: row.source_type,
				profileAuthor: row.profile_author,
				lastReviewed: row.last_reviewed,
				reviewStatus: row.review_status,
				provenance: mapArtifactProvenanceFromDb(row.provenance),
				sensitivityLevel: row.sensitivity_level ?? 'internal',
				sensitivityMetadata: normalizeSensitivityMetadata(
					row.sensitivity_metadata,
					row.sensitivity_level ?? 'internal',
				),
				dimensions: [],
				createdAt: row.profile_created_at,
				updatedAt: row.profile_updated_at,
			};
			profiles.set(row.profile_id, profile);
		}
		if (row.dim_row_id && row.dimension_id && row.label && row.score !== null && row.rationale) {
			profile.dimensions.push({
				id: row.dim_row_id,
				profileId: row.profile_id,
				dimensionId: row.dimension_id,
				label: row.label,
				score: typeof row.score === 'number' ? row.score : Number.parseFloat(row.score),
				rationale: row.rationale,
				evidenceRefs: row.evidence_refs ?? [],
				knownFactors: row.known_factors ?? [],
				createdAt: row.dim_created_at ?? row.profile_created_at,
				updatedAt: row.dim_updated_at ?? row.profile_updated_at,
			});
		}
	}
	return [...profiles.values()].map((profile) => ({
		...profile,
		dimensions: profile.dimensions.sort((left, right) => left.dimensionId.localeCompare(right.dimensionId)),
	}));
}

async function readProfiles(pool: Queryable, whereSql: string, params: unknown[]): Promise<SourceCredibilityProfile[]> {
	const result = await pool.query<JoinedRow>(
		`
			SELECT
				p.profile_id, p.source_id, p.source_name, p.source_type, p.profile_author,
				p.last_reviewed, p.review_status, p.provenance, p.sensitivity_level, p.sensitivity_metadata,
				p.created_at AS profile_created_at, p.updated_at AS profile_updated_at,
				d.id AS dim_row_id, d.dimension_id, d.label, d.score, d.rationale, d.evidence_refs, d.known_factors,
				d.created_at AS dim_created_at, d.updated_at AS dim_updated_at
			FROM source_credibility_profiles p
			JOIN sources s ON s.id = p.source_id
			LEFT JOIN credibility_dimensions d ON d.profile_id = p.profile_id
			${whereSql}
			ORDER BY p.updated_at DESC, p.source_name ASC, p.profile_id ASC, d.dimension_id ASC
		`,
		params,
	);
	return collectProfiles(result.rows);
}

export async function findSourceCredibilityProfileBySourceId(
	pool: Queryable,
	sourceId: string,
	options?: Pick<SourceCredibilityProfileListOptions, 'maxSensitivityLevel'>,
): Promise<SourceCredibilityProfile | null> {
	const params: unknown[] = [sourceId];
	const filters = ['p.source_id = $1', "s.deletion_status NOT IN ('soft_deleted', 'purging', 'purged')"];
	if (options?.maxSensitivityLevel) {
		params.push(allowedSensitivityLevelsForMax(options.maxSensitivityLevel));
		filters.push(`p.sensitivity_level = ANY($${params.length})`);
		filters.push(`s.sensitivity_level = ANY($${params.length})`);
	}
	try {
		return (await readProfiles(pool, `WHERE ${filters.join(' AND ')}`, params))[0] ?? null;
	} catch (cause: unknown) {
		throw new DatabaseError('Failed to find source credibility profile', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause,
			context: { sourceId, maxSensitivityLevel: options?.maxSensitivityLevel },
		});
	}
}

export async function listSourceCredibilityProfiles(
	pool: Queryable,
	options?: SourceCredibilityProfileListOptions,
): Promise<SourceCredibilityProfile[]> {
	const params: unknown[] = [];
	const filters: string[] = ["s.deletion_status NOT IN ('soft_deleted', 'purging', 'purged')"];
	if (options?.sourceType) {
		assertEnum(options.sourceType, SOURCE_TYPES, 'sourceType');
		params.push(options.sourceType);
		filters.push(`p.source_type = $${params.length}`);
	}
	if (options?.reviewStatus) {
		assertEnum(options.reviewStatus, STATUSES, 'reviewStatus');
		params.push(options.reviewStatus);
		filters.push(`p.review_status = $${params.length}`);
	}
	if (options?.maxSensitivityLevel) {
		params.push(allowedSensitivityLevelsForMax(options.maxSensitivityLevel));
		filters.push(`p.sensitivity_level = ANY($${params.length})`);
		filters.push(`s.sensitivity_level = ANY($${params.length})`);
	}
	const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
	const limit = options?.limit ?? 100;
	const offset = options?.offset ?? 0;
	try {
		return (await readProfiles(pool, where, params)).slice(offset, offset + limit);
	} catch (cause: unknown) {
		throw new DatabaseError('Failed to list source credibility profiles', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause,
			context: {
				sourceType: options?.sourceType,
				reviewStatus: options?.reviewStatus,
				maxSensitivityLevel: options?.maxSensitivityLevel,
				limit,
				offset,
			},
		});
	}
}

export async function countSourceCredibilityProfiles(
	pool: Queryable,
	options?: Omit<SourceCredibilityProfileListOptions, 'limit' | 'offset'>,
): Promise<number> {
	const params: unknown[] = [];
	const filters: string[] = ["s.deletion_status NOT IN ('soft_deleted', 'purging', 'purged')"];
	if (options?.sourceType) {
		assertEnum(options.sourceType, SOURCE_TYPES, 'sourceType');
		params.push(options.sourceType);
		filters.push(`p.source_type = $${params.length}`);
	}
	if (options?.reviewStatus) {
		assertEnum(options.reviewStatus, STATUSES, 'reviewStatus');
		params.push(options.reviewStatus);
		filters.push(`p.review_status = $${params.length}`);
	}
	if (options?.maxSensitivityLevel) {
		params.push(allowedSensitivityLevelsForMax(options.maxSensitivityLevel));
		filters.push(`p.sensitivity_level = ANY($${params.length})`);
		filters.push(`s.sensitivity_level = ANY($${params.length})`);
	}
	const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
	try {
		const result = await pool.query<{ count: string }>(
			`
				SELECT COUNT(DISTINCT p.profile_id) AS count
				FROM source_credibility_profiles p
				JOIN sources s ON s.id = p.source_id
				${where}
			`,
			params,
		);
		return Number.parseInt(result.rows[0]?.count ?? '0', 10) || 0;
	} catch (cause: unknown) {
		throw new DatabaseError('Failed to count source credibility profiles', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause,
			context: {
				sourceType: options?.sourceType,
				reviewStatus: options?.reviewStatus,
				maxSensitivityLevel: options?.maxSensitivityLevel,
			},
		});
	}
}

async function readSourceTrust(client: Queryable, sourceId: string): Promise<SourceTrustRow> {
	const result = await client.query<SourceTrustRow>(
		'SELECT id, sensitivity_level, sensitivity_metadata, created_at FROM sources WHERE id = $1',
		[sourceId],
	);
	const source = result.rows[0];
	if (!source) fail('Source credibility profile source does not exist', { sourceId });
	return source;
}

async function writeProfile(
	client: Queryable,
	input: UpsertSourceCredibilityProfileInput,
): Promise<SourceCredibilityProfile> {
	const source = await readSourceTrust(client, input.sourceId);
	const sensitivityLevel = input.sensitivityLevel ?? source.sensitivity_level ?? 'internal';
	const sensitivityMetadata = input.sensitivityMetadata ?? source.sensitivity_metadata;
	const provenance = profileProvenanceForSource(input.sourceId, input.provenance, source.created_at);
	const profile = await client.query<{ profile_id: string }>(
		`
			INSERT INTO source_credibility_profiles (
				source_id,
				source_name,
				source_type,
				profile_author,
				last_reviewed,
				review_status,
				provenance,
				sensitivity_level,
				sensitivity_metadata
			)
			VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::jsonb)
			ON CONFLICT (source_id) DO UPDATE SET
				source_name = EXCLUDED.source_name,
				source_type = EXCLUDED.source_type,
				profile_author = EXCLUDED.profile_author,
				last_reviewed = EXCLUDED.last_reviewed,
				review_status = EXCLUDED.review_status,
				provenance = EXCLUDED.provenance,
				sensitivity_level = EXCLUDED.sensitivity_level,
				sensitivity_metadata = EXCLUDED.sensitivity_metadata,
				updated_at = now()
			RETURNING profile_id
		`,
		[
			input.sourceId,
			required(input.sourceName, 'sourceName'),
			input.sourceType,
			input.profileAuthor ?? 'llm_auto',
			input.lastReviewed ?? null,
			input.reviewStatus ?? 'draft',
			stringifyArtifactProvenance(provenance),
			sensitivityLevel,
			stringifySensitivityMetadata(sensitivityMetadata, sensitivityLevel),
		],
	);
	const profileId = profile.rows[0].profile_id;
	const dimensionIds = input.dimensions.map((dimension) => required(dimension.dimensionId, 'dimensionId'));
	await client.query(
		'DELETE FROM credibility_dimensions WHERE profile_id = $1 AND NOT (dimension_id = ANY($2::text[]))',
		[profileId, dimensionIds],
	);
	for (const dimension of input.dimensions) {
		await client.query(
			`
				INSERT INTO credibility_dimensions (profile_id, dimension_id, label, score, rationale, evidence_refs, known_factors)
				VALUES ($1, $2, $3, $4, $5, $6, $7)
				ON CONFLICT (profile_id, dimension_id) DO UPDATE SET
					label = EXCLUDED.label,
					score = EXCLUDED.score,
					rationale = EXCLUDED.rationale,
					evidence_refs = EXCLUDED.evidence_refs,
					known_factors = EXCLUDED.known_factors,
					updated_at = now()
			`,
			[
				profileId,
				required(dimension.dimensionId, 'dimensionId'),
				required(dimension.label, 'label'),
				dimension.score,
				required(dimension.rationale, 'rationale'),
				normalizeTextArray(dimension.evidenceRefs),
				normalizeTextArray(dimension.knownFactors),
			],
		);
	}
	const written = await findSourceCredibilityProfileBySourceId(client, input.sourceId);
	if (!written) fail('Source credibility profile disappeared after upsert', { sourceId: input.sourceId });
	if (written.profileAuthor === 'llm_auto' || written.reviewStatus === 'draft') {
		await upsertReviewableArtifact(client, {
			artifactType: 'credibility_profile',
			subjectId: written.profileId,
			subjectTable: 'source_credibility_profiles',
			createdBy: written.profileAuthor === 'llm_auto' ? 'llm_auto' : 'human',
			reviewStatus: 'pending',
			currentValue: {
				source_name: written.sourceName,
				source_type: written.sourceType,
				profile_author: written.profileAuthor,
				review_status: written.reviewStatus,
				dimensions: written.dimensions.map((dimension) => ({
					id: dimension.dimensionId,
					label: dimension.label,
					score: dimension.score,
					rationale: dimension.rationale,
					evidence_refs: dimension.evidenceRefs,
					known_factors: dimension.knownFactors,
				})),
			},
			context: {
				source_id: written.sourceId,
				last_reviewed: written.lastReviewed?.toISOString() ?? null,
				dimension_count: written.dimensions.length,
				provenance: parseJsonValue(stringifyArtifactProvenance(written.provenance)),
				sensitivity_level: written.sensitivityLevel,
				sensitivity_metadata: parseJsonValue(
					stringifySensitivityMetadata(written.sensitivityMetadata, written.sensitivityLevel),
				),
			},
			sourceId: written.sourceId,
		});
	}
	return written;
}

export async function upsertSourceCredibilityProfile(
	pool: Queryable,
	input: UpsertSourceCredibilityProfileInput,
): Promise<SourceCredibilityProfile> {
	try {
		validate(input);
		if (!isPool(pool)) return await writeProfile(pool, input);
		const client = await pool.connect();
		try {
			await client.query('BEGIN');
			const written = await writeProfile(client, input);
			await client.query('COMMIT');
			return written;
		} catch (cause: unknown) {
			await client.query('ROLLBACK').catch(() => {});
			throw cause;
		} finally {
			client.release();
		}
	} catch (cause: unknown) {
		if (cause instanceof DatabaseError) throw cause;
		throw new DatabaseError('Failed to upsert source credibility profile', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause,
			context: { sourceId: input.sourceId, sourceName: input.sourceName },
		});
	}
}
