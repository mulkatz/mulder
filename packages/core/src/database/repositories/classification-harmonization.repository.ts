import type pg from 'pg';
import { allowedSensitivityLevelsForMax } from '../../shared/access-control.js';
import { DATABASE_ERROR_CODES, DatabaseError } from '../../shared/errors.js';
import { normalizeSensitivityMetadata, stringifySensitivityMetadata } from '../../shared/sensitivity.js';
import {
	mapArtifactProvenanceFromDb,
	normalizeArtifactProvenance,
	stringifyArtifactProvenance,
} from './artifact-provenance.js';
import type {
	ClassificationCategory,
	ClassificationCategoryListOptions,
	ClassificationCategoryStatus,
	ClassificationTaxonomy,
	ClassificationTaxonomyListOptions,
	ClassificationTaxonomyStatus,
	ResolveTaxonomyMappingsOptions,
	TaxonomyMapping,
	TaxonomyMappingAuthor,
	TaxonomyMappingListOptions,
	TaxonomyMappingReviewStatus,
	TaxonomyMappingType,
	TaxonomyMappingView,
	UpsertClassificationCategoryInput,
	UpsertClassificationTaxonomyInput,
	UpsertTaxonomyMappingInput,
} from './classification-harmonization.types.js';
import { upsertReviewableArtifact } from './review-workflow.repository.js';

type Queryable = pg.Pool | pg.PoolClient;

const TAXONOMY_STATUSES: readonly ClassificationTaxonomyStatus[] = [
	'active',
	'inactive',
	'draft',
	'deprecated',
] as const;
const CATEGORY_STATUSES: readonly ClassificationCategoryStatus[] = TAXONOMY_STATUSES;
const MAPPING_TYPES: readonly TaxonomyMappingType[] = [
	'equivalent',
	'broader',
	'narrower',
	'overlapping',
	'related',
] as const;
const MAPPING_AUTHORS: readonly TaxonomyMappingAuthor[] = ['llm_auto', 'human', 'hybrid'] as const;
const MAPPING_REVIEW_STATUSES: readonly TaxonomyMappingReviewStatus[] = ['draft', 'reviewed', 'contested'] as const;

interface ClassificationTaxonomyRow {
	id: string;
	name: string;
	version: string | null;
	language: string | null;
	description: string | null;
	status: ClassificationTaxonomyStatus;
	source_ref: string | null;
	provenance: unknown;
	sensitivity_level: ClassificationTaxonomy['sensitivityLevel'];
	sensitivity_metadata: unknown;
	created_at: Date;
	updated_at: Date;
	deleted_at: Date | null;
}

interface ClassificationCategoryRow {
	id: string;
	taxonomy_id: string;
	code: string;
	label: string;
	translations: unknown;
	definition: string | null;
	parent_id: string | null;
	attributes: unknown;
	status: ClassificationCategoryStatus;
	provenance: unknown;
	sensitivity_level: ClassificationCategory['sensitivityLevel'];
	sensitivity_metadata: unknown;
	created_at: Date;
	updated_at: Date;
	deleted_at: Date | null;
}

interface TaxonomyMappingRow {
	id: string;
	source_taxonomy_id: string;
	source_category_id: string;
	target_taxonomy_id: string;
	target_category_id: string;
	mapping_type: TaxonomyMappingType;
	confidence: number | string;
	conditions: string | null;
	rationale: string;
	mapping_author: TaxonomyMappingAuthor;
	review_status: TaxonomyMappingReviewStatus;
	provenance: unknown;
	sensitivity_level: TaxonomyMapping['sensitivityLevel'];
	sensitivity_metadata: unknown;
	created_at: Date;
	updated_at: Date;
	deleted_at: Date | null;
}

function isPool(value: Queryable): value is pg.Pool {
	return 'connect' in value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fail(message: string, context?: Record<string, unknown>): never {
	throw new DatabaseError(message, DATABASE_ERROR_CODES.DB_QUERY_FAILED, { context });
}

function isAllowed<T extends string>(value: string, allowed: readonly T[]): value is T {
	return allowed.some((item) => item === value);
}

function assertEnum<T extends string>(value: string, allowed: readonly T[], field: string): T {
	if (isAllowed(value, allowed)) return value;
	fail(`Invalid classification harmonization ${field}: ${value}`, { field, value });
}

function requiredText(value: string | null | undefined, field: string): string {
	const trimmed = value?.trim() ?? '';
	if (trimmed.length === 0) fail(`Invalid classification harmonization ${field}: value is required`, { field });
	return trimmed;
}

function nullableText(value: string | null | undefined): string | null {
	const trimmed = value?.trim() ?? '';
	return trimmed.length > 0 ? trimmed : null;
}

function normalizeTranslations(value: Record<string, string> | unknown): Record<string, string> {
	if (!isRecord(value)) return {};
	const normalized: Record<string, string> = {};
	for (const [language, label] of Object.entries(value)) {
		const key = language.trim();
		if (key.length === 0 || typeof label !== 'string') continue;
		const translated = label.trim();
		if (translated.length > 0) normalized[key] = translated;
	}
	return Object.fromEntries(Object.entries(normalized).sort(([left], [right]) => left.localeCompare(right)));
}

function normalizeAttributes(value: unknown): unknown[] | Record<string, unknown> {
	if (Array.isArray(value)) return [...value];
	if (isRecord(value)) return { ...value };
	return [];
}

function normalizeJsonObject(value: unknown): Record<string, unknown> {
	return isRecord(value) ? value : {};
}

function parseJsonObject(value: string): Record<string, unknown> {
	const parsed = JSON.parse(value);
	return normalizeJsonObject(parsed);
}

function assertConfidence(value: number, field: string): number {
	if (!Number.isFinite(value) || value < 0 || value > 1) {
		fail(`Invalid classification harmonization ${field}: must be between 0 and 1`, { field, value });
	}
	return value;
}

function enumFilter<T extends string>(value: T | readonly T[] | undefined, allowed: readonly T[], field: string): T[] {
	if (value === undefined) return [];
	const values = Array.isArray(value) ? value : [value];
	return values.map((item) => assertEnum(item, allowed, field));
}

function appendLimitOffset(params: unknown[], limit: number, offset: number): string {
	params.push(limit, offset);
	return `LIMIT $${params.length - 1} OFFSET $${params.length}`;
}

function mapTaxonomyRow(row: ClassificationTaxonomyRow): ClassificationTaxonomy {
	return {
		id: row.id,
		name: row.name,
		version: row.version,
		language: row.language,
		description: row.description,
		status: row.status,
		sourceRef: row.source_ref,
		provenance: mapArtifactProvenanceFromDb(row.provenance),
		sensitivityLevel: row.sensitivity_level ?? 'internal',
		sensitivityMetadata: normalizeSensitivityMetadata(row.sensitivity_metadata, row.sensitivity_level ?? 'internal'),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		deletedAt: row.deleted_at,
	};
}

function mapCategoryRow(row: ClassificationCategoryRow): ClassificationCategory {
	return {
		id: row.id,
		taxonomyId: row.taxonomy_id,
		code: row.code,
		label: row.label,
		translations: normalizeTranslations(row.translations),
		definition: row.definition,
		parentId: row.parent_id,
		attributes: normalizeAttributes(row.attributes),
		status: row.status,
		provenance: mapArtifactProvenanceFromDb(row.provenance),
		sensitivityLevel: row.sensitivity_level ?? 'internal',
		sensitivityMetadata: normalizeSensitivityMetadata(row.sensitivity_metadata, row.sensitivity_level ?? 'internal'),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		deletedAt: row.deleted_at,
	};
}

function mapMappingRow(row: TaxonomyMappingRow): TaxonomyMapping {
	return {
		id: row.id,
		sourceTaxonomyId: row.source_taxonomy_id,
		sourceCategoryId: row.source_category_id,
		targetTaxonomyId: row.target_taxonomy_id,
		targetCategoryId: row.target_category_id,
		mappingType: row.mapping_type,
		confidence: typeof row.confidence === 'number' ? row.confidence : Number.parseFloat(row.confidence),
		conditions: row.conditions,
		rationale: row.rationale,
		mappingAuthor: row.mapping_author,
		reviewStatus: row.review_status,
		provenance: mapArtifactProvenanceFromDb(row.provenance),
		sensitivityLevel: row.sensitivity_level ?? 'internal',
		sensitivityMetadata: normalizeSensitivityMetadata(row.sensitivity_metadata, row.sensitivity_level ?? 'internal'),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		deletedAt: row.deleted_at,
	};
}

function invertMappingType(mappingType: TaxonomyMappingType): TaxonomyMappingType {
	if (mappingType === 'broader') return 'narrower';
	if (mappingType === 'narrower') return 'broader';
	return mappingType;
}

function mappingView(mapping: TaxonomyMapping, direction: TaxonomyMappingView['direction']): TaxonomyMappingView {
	if (direction === 'forward') {
		return {
			...mapping,
			direction,
			originalMappingType: mapping.mappingType,
			originalSourceTaxonomyId: mapping.sourceTaxonomyId,
			originalSourceCategoryId: mapping.sourceCategoryId,
			originalTargetTaxonomyId: mapping.targetTaxonomyId,
			originalTargetCategoryId: mapping.targetCategoryId,
		};
	}
	return {
		...mapping,
		sourceTaxonomyId: mapping.targetTaxonomyId,
		sourceCategoryId: mapping.targetCategoryId,
		targetTaxonomyId: mapping.sourceTaxonomyId,
		targetCategoryId: mapping.sourceCategoryId,
		mappingType: invertMappingType(mapping.mappingType),
		direction,
		originalMappingType: mapping.mappingType,
		originalSourceTaxonomyId: mapping.sourceTaxonomyId,
		originalSourceCategoryId: mapping.sourceCategoryId,
		originalTargetTaxonomyId: mapping.targetTaxonomyId,
		originalTargetCategoryId: mapping.targetCategoryId,
	};
}

function viewForCategory(mapping: TaxonomyMapping, categoryId: string, taxonomyId?: string): TaxonomyMappingView {
	const matchesSource =
		mapping.sourceCategoryId === categoryId && (taxonomyId === undefined || mapping.sourceTaxonomyId === taxonomyId);
	return mappingView(mapping, matchesSource ? 'forward' : 'reverse');
}

async function readTaxonomies(
	pool: Queryable,
	whereSql: string,
	params: unknown[],
	suffixSql = '',
): Promise<ClassificationTaxonomy[]> {
	const result = await pool.query<ClassificationTaxonomyRow>(
		`
			SELECT *
			FROM classification_taxonomies
			${whereSql}
			ORDER BY id ASC
			${suffixSql}
		`,
		params,
	);
	return result.rows.map(mapTaxonomyRow);
}

async function readCategories(
	pool: Queryable,
	whereSql: string,
	params: unknown[],
	suffixSql = '',
): Promise<ClassificationCategory[]> {
	const result = await pool.query<ClassificationCategoryRow>(
		`
			SELECT *
			FROM classification_categories
			${whereSql}
			ORDER BY taxonomy_id ASC, code ASC, id ASC
			${suffixSql}
		`,
		params,
	);
	return result.rows.map(mapCategoryRow);
}

async function readMappings(
	pool: Queryable,
	whereSql: string,
	params: unknown[],
	suffixSql = '',
): Promise<TaxonomyMapping[]> {
	const result = await pool.query<TaxonomyMappingRow>(
		`
			SELECT *
			FROM taxonomy_mappings
			${whereSql}
			ORDER BY confidence DESC, updated_at DESC, id ASC
			${suffixSql}
		`,
		params,
	);
	return result.rows.map(mapMappingRow);
}

export async function upsertClassificationTaxonomy(
	pool: Queryable,
	input: UpsertClassificationTaxonomyInput,
): Promise<ClassificationTaxonomy> {
	const sensitivityLevel = input.sensitivityLevel ?? 'internal';
	const status = assertEnum(input.status ?? 'active', TAXONOMY_STATUSES, 'status');
	try {
		const result = await pool.query<ClassificationTaxonomyRow>(
			`
				INSERT INTO classification_taxonomies (
					id,
					name,
					version,
					language,
					description,
					status,
					source_ref,
					provenance,
					sensitivity_level,
					sensitivity_metadata
				)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10::jsonb)
				ON CONFLICT (id) DO UPDATE SET
					name = EXCLUDED.name,
					version = EXCLUDED.version,
					language = EXCLUDED.language,
					description = EXCLUDED.description,
					status = EXCLUDED.status,
					source_ref = EXCLUDED.source_ref,
					provenance = EXCLUDED.provenance,
					sensitivity_level = EXCLUDED.sensitivity_level,
					sensitivity_metadata = EXCLUDED.sensitivity_metadata,
					deleted_at = NULL,
					updated_at = now()
				RETURNING *
			`,
			[
				requiredText(input.id, 'id'),
				requiredText(input.name, 'name'),
				nullableText(input.version),
				nullableText(input.language),
				nullableText(input.description),
				status,
				nullableText(input.sourceRef),
				stringifyArtifactProvenance(input.provenance),
				sensitivityLevel,
				stringifySensitivityMetadata(input.sensitivityMetadata, sensitivityLevel),
			],
		);
		return mapTaxonomyRow(result.rows[0]);
	} catch (cause: unknown) {
		if (cause instanceof DatabaseError) throw cause;
		throw new DatabaseError('Failed to upsert classification taxonomy', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause,
			context: { taxonomyId: input.id },
		});
	}
}

export async function findClassificationTaxonomy(
	pool: Queryable,
	taxonomyId: string,
	options?: Pick<ClassificationTaxonomyListOptions, 'includeDeleted' | 'maxSensitivityLevel'>,
): Promise<ClassificationTaxonomy | null> {
	const filters = ['id = $1'];
	const params: unknown[] = [taxonomyId];
	if (!options?.includeDeleted) filters.push('deleted_at IS NULL');
	if (options?.maxSensitivityLevel) {
		params.push(allowedSensitivityLevelsForMax(options.maxSensitivityLevel));
		filters.push(`sensitivity_level = ANY($${params.length})`);
	}
	try {
		return (await readTaxonomies(pool, `WHERE ${filters.join(' AND ')}`, params))[0] ?? null;
	} catch (cause: unknown) {
		throw new DatabaseError('Failed to find classification taxonomy', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause,
			context: { taxonomyId, options },
		});
	}
}

export async function listClassificationTaxonomies(
	pool: Queryable,
	options?: ClassificationTaxonomyListOptions,
): Promise<ClassificationTaxonomy[]> {
	const filters: string[] = [];
	const params: unknown[] = [];
	if (!options?.includeDeleted) filters.push('deleted_at IS NULL');
	if (options?.status) {
		params.push(assertEnum(options.status, TAXONOMY_STATUSES, 'status'));
		filters.push(`status = $${params.length}`);
	}
	if (options?.sourceRef) {
		params.push(options.sourceRef);
		filters.push(`source_ref = $${params.length}`);
	}
	if (options?.maxSensitivityLevel) {
		params.push(allowedSensitivityLevelsForMax(options.maxSensitivityLevel));
		filters.push(`sensitivity_level = ANY($${params.length})`);
	}
	const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
	const suffix = appendLimitOffset(params, options?.limit ?? 100, options?.offset ?? 0);
	try {
		return await readTaxonomies(pool, where, params, suffix);
	} catch (cause: unknown) {
		throw new DatabaseError('Failed to list classification taxonomies', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause,
			context: { options },
		});
	}
}

export async function upsertClassificationCategory(
	pool: Queryable,
	input: UpsertClassificationCategoryInput,
): Promise<ClassificationCategory> {
	const sensitivityLevel = input.sensitivityLevel ?? 'internal';
	const status = assertEnum(input.status ?? 'active', CATEGORY_STATUSES, 'status');
	try {
		const result = await pool.query<ClassificationCategoryRow>(
			`
				INSERT INTO classification_categories (
					id,
					taxonomy_id,
					code,
					label,
					translations,
					definition,
					parent_id,
					attributes,
					status,
					provenance,
					sensitivity_level,
					sensitivity_metadata
				)
				VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8::jsonb, $9, $10::jsonb, $11, $12::jsonb)
				ON CONFLICT (id) DO UPDATE SET
					taxonomy_id = EXCLUDED.taxonomy_id,
					code = EXCLUDED.code,
					label = EXCLUDED.label,
					translations = EXCLUDED.translations,
					definition = EXCLUDED.definition,
					parent_id = EXCLUDED.parent_id,
					attributes = EXCLUDED.attributes,
					status = EXCLUDED.status,
					provenance = EXCLUDED.provenance,
					sensitivity_level = EXCLUDED.sensitivity_level,
					sensitivity_metadata = EXCLUDED.sensitivity_metadata,
					deleted_at = NULL,
					updated_at = now()
				RETURNING *
			`,
			[
				requiredText(input.id, 'id'),
				requiredText(input.taxonomyId, 'taxonomyId'),
				requiredText(input.code, 'code'),
				requiredText(input.label, 'label'),
				JSON.stringify(normalizeTranslations(input.translations ?? {})),
				nullableText(input.definition),
				nullableText(input.parentId),
				JSON.stringify(normalizeAttributes(input.attributes)),
				status,
				stringifyArtifactProvenance(input.provenance),
				sensitivityLevel,
				stringifySensitivityMetadata(input.sensitivityMetadata, sensitivityLevel),
			],
		);
		return mapCategoryRow(result.rows[0]);
	} catch (cause: unknown) {
		if (cause instanceof DatabaseError) throw cause;
		throw new DatabaseError('Failed to upsert classification category', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause,
			context: { categoryId: input.id, taxonomyId: input.taxonomyId },
		});
	}
}

export async function findClassificationCategory(
	pool: Queryable,
	categoryId: string,
	options?: Pick<ClassificationCategoryListOptions, 'includeDeleted' | 'maxSensitivityLevel'>,
): Promise<ClassificationCategory | null> {
	const filters = ['id = $1'];
	const params: unknown[] = [categoryId];
	if (!options?.includeDeleted) filters.push('deleted_at IS NULL');
	if (options?.maxSensitivityLevel) {
		params.push(allowedSensitivityLevelsForMax(options.maxSensitivityLevel));
		filters.push(`sensitivity_level = ANY($${params.length})`);
	}
	try {
		return (await readCategories(pool, `WHERE ${filters.join(' AND ')}`, params))[0] ?? null;
	} catch (cause: unknown) {
		throw new DatabaseError('Failed to find classification category', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause,
			context: { categoryId, options },
		});
	}
}

export async function listClassificationCategories(
	pool: Queryable,
	options?: ClassificationCategoryListOptions,
): Promise<ClassificationCategory[]> {
	const filters: string[] = [];
	const params: unknown[] = [];
	if (!options?.includeDeleted) filters.push('deleted_at IS NULL');
	if (options?.taxonomyId) {
		params.push(options.taxonomyId);
		filters.push(`taxonomy_id = $${params.length}`);
	}
	if (options && 'parentId' in options) {
		if (options.parentId === null) {
			filters.push('parent_id IS NULL');
		} else if (options.parentId !== undefined) {
			params.push(options.parentId);
			filters.push(`parent_id = $${params.length}`);
		}
	}
	if (options?.status) {
		params.push(assertEnum(options.status, CATEGORY_STATUSES, 'status'));
		filters.push(`status = $${params.length}`);
	}
	if (options?.maxSensitivityLevel) {
		params.push(allowedSensitivityLevelsForMax(options.maxSensitivityLevel));
		filters.push(`sensitivity_level = ANY($${params.length})`);
	}
	const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
	const suffix = appendLimitOffset(params, options?.limit ?? 100, options?.offset ?? 0);
	try {
		return await readCategories(pool, where, params, suffix);
	} catch (cause: unknown) {
		throw new DatabaseError('Failed to list classification categories', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause,
			context: { options },
		});
	}
}

function mappingParams(input: UpsertTaxonomyMappingInput) {
	const sourceTaxonomyId = requiredText(input.source.taxonomyId, 'source.taxonomyId');
	const sourceCategoryId = requiredText(input.source.categoryId, 'source.categoryId');
	const targetTaxonomyId = requiredText(input.target.taxonomyId, 'target.taxonomyId');
	const targetCategoryId = requiredText(input.target.categoryId, 'target.categoryId');
	const mappingType = assertEnum(input.mappingType, MAPPING_TYPES, 'mappingType');
	const mappingAuthor = assertEnum(input.mappingAuthor ?? 'human', MAPPING_AUTHORS, 'mappingAuthor');
	const reviewStatus = assertEnum(input.reviewStatus ?? 'draft', MAPPING_REVIEW_STATUSES, 'reviewStatus');
	const sensitivityLevel = input.sensitivityLevel ?? 'internal';
	return {
		sourceTaxonomyId,
		sourceCategoryId,
		targetTaxonomyId,
		targetCategoryId,
		mappingType,
		confidence: assertConfidence(input.confidence, 'confidence'),
		conditions: nullableText(input.conditions),
		rationale: requiredText(input.rationale, 'rationale'),
		mappingAuthor,
		reviewStatus,
		provenance: normalizeArtifactProvenance(input.provenance),
		sensitivityLevel,
		sensitivityMetadata: stringifySensitivityMetadata(input.sensitivityMetadata, sensitivityLevel),
	};
}

async function findTaxonomyMappingRequired(client: Queryable, mappingId: string): Promise<TaxonomyMapping> {
	const mapping = await findTaxonomyMapping(client, mappingId, { includeDeleted: true });
	if (!mapping) fail('Taxonomy mapping disappeared after upsert', { mappingId });
	return mapping;
}

async function registerTaxonomyMappingReviewArtifact(client: Queryable, mapping: TaxonomyMapping): Promise<void> {
	if (mapping.mappingAuthor !== 'llm_auto' && mapping.reviewStatus !== 'draft') return;
	await upsertReviewableArtifact(client, {
		artifactType: 'taxonomy_mapping',
		subjectId: mapping.id,
		subjectTable: 'taxonomy_mappings',
		createdBy: mapping.mappingAuthor === 'llm_auto' ? 'llm_auto' : 'human',
		reviewStatus: 'pending',
		currentValue: {
			source: {
				taxonomy_id: mapping.sourceTaxonomyId,
				category_id: mapping.sourceCategoryId,
			},
			target: {
				taxonomy_id: mapping.targetTaxonomyId,
				category_id: mapping.targetCategoryId,
			},
			mapping_type: mapping.mappingType,
			confidence: mapping.confidence,
			conditions: mapping.conditions,
			rationale: mapping.rationale,
			mapping_author: mapping.mappingAuthor,
			review_status: mapping.reviewStatus,
		},
		context: {
			provenance: parseJsonObject(stringifyArtifactProvenance(mapping.provenance)),
			sensitivity_level: mapping.sensitivityLevel,
			sensitivity_metadata: parseJsonObject(
				stringifySensitivityMetadata(mapping.sensitivityMetadata, mapping.sensitivityLevel),
			),
		},
		sourceId: mapping.provenance.sourceDocumentIds[0] ?? null,
	});
}

async function writeTaxonomyMapping(client: Queryable, input: UpsertTaxonomyMappingInput): Promise<TaxonomyMapping> {
	const normalized = mappingParams(input);
	const baseParams = [
		normalized.sourceTaxonomyId,
		normalized.sourceCategoryId,
		normalized.targetTaxonomyId,
		normalized.targetCategoryId,
		normalized.mappingType,
		normalized.confidence,
		normalized.conditions,
		normalized.rationale,
		normalized.mappingAuthor,
		normalized.reviewStatus,
		stringifyArtifactProvenance(normalized.provenance),
		normalized.sensitivityLevel,
		normalized.sensitivityMetadata,
	];
	const hasId = input.id !== undefined;
	const sql = hasId
		? `
			INSERT INTO taxonomy_mappings (
				id,
				source_taxonomy_id,
				source_category_id,
				target_taxonomy_id,
				target_category_id,
				mapping_type,
				confidence,
				conditions,
				rationale,
				mapping_author,
				review_status,
				provenance,
				sensitivity_level,
				sensitivity_metadata
			)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14::jsonb)
			ON CONFLICT (id) DO UPDATE SET
				source_taxonomy_id = EXCLUDED.source_taxonomy_id,
				source_category_id = EXCLUDED.source_category_id,
				target_taxonomy_id = EXCLUDED.target_taxonomy_id,
				target_category_id = EXCLUDED.target_category_id,
				mapping_type = EXCLUDED.mapping_type,
				confidence = EXCLUDED.confidence,
				conditions = EXCLUDED.conditions,
				rationale = EXCLUDED.rationale,
				mapping_author = EXCLUDED.mapping_author,
				review_status = EXCLUDED.review_status,
				provenance = EXCLUDED.provenance,
				sensitivity_level = EXCLUDED.sensitivity_level,
				sensitivity_metadata = EXCLUDED.sensitivity_metadata,
				deleted_at = NULL,
				updated_at = now()
			RETURNING id
		`
		: `
			INSERT INTO taxonomy_mappings (
				source_taxonomy_id,
				source_category_id,
				target_taxonomy_id,
				target_category_id,
				mapping_type,
				confidence,
				conditions,
				rationale,
				mapping_author,
				review_status,
				provenance,
				sensitivity_level,
				sensitivity_metadata
			)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13::jsonb)
			ON CONFLICT (
				source_taxonomy_id,
				source_category_id,
				target_taxonomy_id,
				target_category_id,
				mapping_type,
				(COALESCE(conditions, ''::text))
			)
			WHERE deleted_at IS NULL
			DO UPDATE SET
				confidence = EXCLUDED.confidence,
				conditions = EXCLUDED.conditions,
				rationale = EXCLUDED.rationale,
				mapping_author = EXCLUDED.mapping_author,
				review_status = EXCLUDED.review_status,
				provenance = EXCLUDED.provenance,
				sensitivity_level = EXCLUDED.sensitivity_level,
				sensitivity_metadata = EXCLUDED.sensitivity_metadata,
				updated_at = now()
			RETURNING id
		`;
	const params = hasId ? [requiredText(input.id, 'id'), ...baseParams] : baseParams;
	const result = await client.query<{ id: string }>(sql, params);
	const mapping = await findTaxonomyMappingRequired(client, result.rows[0].id);
	await registerTaxonomyMappingReviewArtifact(client, mapping);
	return mapping;
}

export async function upsertTaxonomyMapping(
	pool: Queryable,
	input: UpsertTaxonomyMappingInput,
): Promise<TaxonomyMapping> {
	try {
		if (!isPool(pool)) return await writeTaxonomyMapping(pool, input);
		const client = await pool.connect();
		try {
			await client.query('BEGIN');
			const mapping = await writeTaxonomyMapping(client, input);
			await client.query('COMMIT');
			return mapping;
		} catch (cause: unknown) {
			await client.query('ROLLBACK');
			throw cause;
		} finally {
			client.release();
		}
	} catch (cause: unknown) {
		if (cause instanceof DatabaseError) throw cause;
		throw new DatabaseError('Failed to upsert taxonomy mapping', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause,
			context: { mappingId: input.id, source: input.source, target: input.target },
		});
	}
}

export async function findTaxonomyMapping(
	pool: Queryable,
	mappingId: string,
	options?: Pick<TaxonomyMappingListOptions, 'includeDeleted' | 'maxSensitivityLevel'>,
): Promise<TaxonomyMapping | null> {
	const filters = ['id = $1'];
	const params: unknown[] = [mappingId];
	if (!options?.includeDeleted) filters.push('deleted_at IS NULL');
	if (options?.maxSensitivityLevel) {
		params.push(allowedSensitivityLevelsForMax(options.maxSensitivityLevel));
		filters.push(`sensitivity_level = ANY($${params.length})`);
	}
	try {
		return (await readMappings(pool, `WHERE ${filters.join(' AND ')}`, params))[0] ?? null;
	} catch (cause: unknown) {
		throw new DatabaseError('Failed to find taxonomy mapping', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause,
			context: { mappingId, options },
		});
	}
}

function addMappingListFilters(
	filters: string[],
	params: unknown[],
	options?: TaxonomyMappingListOptions,
	alias = '',
): void {
	const prefix = alias ? `${alias}.` : '';
	if (!options?.includeDeleted) filters.push(`${prefix}deleted_at IS NULL`);
	if (options?.taxonomyId) {
		params.push(options.taxonomyId);
		filters.push(
			`(${prefix}source_taxonomy_id = $${params.length} OR ${prefix}target_taxonomy_id = $${params.length})`,
		);
	}
	if (options?.categoryId) {
		params.push(options.categoryId);
		filters.push(
			`(${prefix}source_category_id = $${params.length} OR ${prefix}target_category_id = $${params.length})`,
		);
	}
	if (options?.sourceTaxonomyId) {
		params.push(options.sourceTaxonomyId);
		filters.push(`${prefix}source_taxonomy_id = $${params.length}`);
	}
	if (options?.sourceCategoryId) {
		params.push(options.sourceCategoryId);
		filters.push(`${prefix}source_category_id = $${params.length}`);
	}
	if (options?.targetTaxonomyId) {
		params.push(options.targetTaxonomyId);
		filters.push(`${prefix}target_taxonomy_id = $${params.length}`);
	}
	if (options?.targetCategoryId) {
		params.push(options.targetCategoryId);
		filters.push(`${prefix}target_category_id = $${params.length}`);
	}
	const mappingTypes = enumFilter(options?.mappingType, MAPPING_TYPES, 'mappingType');
	if (mappingTypes.length > 0) {
		params.push(mappingTypes);
		filters.push(`${prefix}mapping_type = ANY($${params.length})`);
	}
	const reviewStatuses = enumFilter(options?.reviewStatus, MAPPING_REVIEW_STATUSES, 'reviewStatus');
	if (reviewStatuses.length > 0) {
		params.push(reviewStatuses);
		filters.push(`${prefix}review_status = ANY($${params.length})`);
	}
	if (options?.minConfidence !== undefined) {
		params.push(assertConfidence(options.minConfidence, 'minConfidence'));
		filters.push(`${prefix}confidence >= $${params.length}`);
	}
	if (options?.maxSensitivityLevel) {
		params.push(allowedSensitivityLevelsForMax(options.maxSensitivityLevel));
		filters.push(`${prefix}sensitivity_level = ANY($${params.length})`);
	}
}

export async function listTaxonomyMappings(
	pool: Queryable,
	options?: TaxonomyMappingListOptions,
): Promise<TaxonomyMapping[]> {
	const filters: string[] = [];
	const params: unknown[] = [];
	addMappingListFilters(filters, params, options);
	const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
	const suffix = appendLimitOffset(params, options?.limit ?? 100, options?.offset ?? 0);
	try {
		return await readMappings(pool, where, params, suffix);
	} catch (cause: unknown) {
		throw new DatabaseError('Failed to list taxonomy mappings', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause,
			context: { options },
		});
	}
}

export async function resolveTaxonomyMappings(
	pool: Queryable,
	options: ResolveTaxonomyMappingsOptions,
): Promise<TaxonomyMappingView[]> {
	const categoryId = requiredText(options.categoryId, 'categoryId');
	const filters: string[] = [];
	const params: unknown[] = [];
	if (!options.includeDeleted) filters.push('deleted_at IS NULL');
	params.push(categoryId);
	if (options.taxonomyId) {
		params.push(options.taxonomyId);
		filters.push(
			`((source_category_id = $1 AND source_taxonomy_id = $2) OR (target_category_id = $1 AND target_taxonomy_id = $2))`,
		);
	} else {
		filters.push('(source_category_id = $1 OR target_category_id = $1)');
	}
	if (options.targetCategoryId) {
		params.push(options.targetCategoryId);
		const targetParam = params.length;
		filters.push(
			`((source_category_id = $1 AND target_category_id = $${targetParam}) OR (target_category_id = $1 AND source_category_id = $${targetParam}))`,
		);
	}
	if (options.targetTaxonomyId) {
		params.push(options.targetTaxonomyId);
		const targetParam = params.length;
		filters.push(
			`((source_category_id = $1 AND target_taxonomy_id = $${targetParam}) OR (target_category_id = $1 AND source_taxonomy_id = $${targetParam}))`,
		);
	}
	addMappingListFilters(filters, params, {
		...options,
		includeDeleted: true,
		categoryId: undefined,
		taxonomyId: undefined,
	});
	const where = `WHERE ${filters.join(' AND ')}`;
	const suffix = appendLimitOffset(params, options.limit ?? 100, options.offset ?? 0);
	try {
		const mappings = await readMappings(pool, where, params, suffix);
		return mappings.map((mapping) => viewForCategory(mapping, categoryId, options.taxonomyId));
	} catch (cause: unknown) {
		throw new DatabaseError('Failed to resolve taxonomy mappings', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause,
			context: { options },
		});
	}
}
