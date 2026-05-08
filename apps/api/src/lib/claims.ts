import {
	findSourceById,
	findStoryById,
	MulderError,
	mapArtifactProvenanceFromDb,
	normalizeConfidenceMetadata,
	normalizeSensitivityMetadata,
} from '@mulder/core';
import type pg from 'pg';
import type { AuthPrincipal } from '../middleware/auth.js';
import type {
	ClaimDetailResponse,
	ClaimListQuery,
	ClaimListResponse,
	ClaimResponse,
} from '../routes/claims.schemas.js';
import { allowedSensitivity, resolveApiDataContext, resolveReadMaxSensitivity } from './api-runtime.js';
import { isJsonRecord, objectToJsonRecord } from './json-record.js';

interface ClaimsRouteOptions {
	authPrincipal?: AuthPrincipal;
}

const CLAIM_NOT_FOUND_CODE = 'CLAIM_NOT_FOUND';
const DOCUMENT_NOT_FOUND_CODE = 'DOCUMENT_NOT_FOUND';
const STORY_NOT_FOUND_CODE = 'STORY_NOT_FOUND';

interface ClaimRow {
	id: string;
	source_id: string;
	story_id: string;
	assertion_type: ClaimResponse['assertion_type'];
	content: string;
	confidence_metadata: unknown;
	classification_provenance: ClaimResponse['classification_provenance'];
	extracted_entity_ids: string[] | null;
	provenance: unknown;
	quality_metadata: unknown;
	sensitivity_level: ClaimResponse['sensitivity_level'];
	sensitivity_metadata: unknown;
	created_at: Date;
	updated_at: Date;
}

function mapClaim(row: ClaimRow): ClaimResponse {
	const confidence = normalizeConfidenceMetadata(row.confidence_metadata);
	return {
		id: row.id,
		source_id: row.source_id,
		story_id: row.story_id,
		assertion_type: row.assertion_type,
		content: row.content,
		confidence_metadata: {
			witness_count: confidence.witnessCount,
			measurement_based: confidence.measurementBased,
			contemporaneous: confidence.contemporaneous,
			corroborated: confidence.corroborated,
			peer_reviewed: confidence.peerReviewed,
			author_is_interpreter: confidence.authorIsInterpreter,
		},
		classification_provenance: row.classification_provenance,
		extracted_entity_ids: row.extracted_entity_ids ?? [],
		provenance: objectToJsonRecord(mapArtifactProvenanceFromDb(row.provenance)),
		quality_metadata: isJsonRecord(row.quality_metadata) ? { ...row.quality_metadata } : null,
		sensitivity_level: row.sensitivity_level ?? 'internal',
		sensitivity_metadata: objectToJsonRecord(
			normalizeSensitivityMetadata(row.sensitivity_metadata, row.sensitivity_level ?? 'internal'),
		),
		created_at: row.created_at.toISOString(),
		updated_at: row.updated_at.toISOString(),
	};
}

function buildClaimFilters(query: ClaimListQuery, maxSensitivityLevel?: ClaimResponse['sensitivity_level']) {
	const filters = [
		'knowledge_assertions.deleted_at IS NULL',
		"COALESCE(sources.deletion_status, 'active') NOT IN ('soft_deleted', 'purging', 'purged')",
	];
	const params: unknown[] = [];
	if (query.source_id) {
		params.push(query.source_id);
		filters.push(`knowledge_assertions.source_id = $${params.length}`);
	}
	if (query.story_id) {
		params.push(query.story_id);
		filters.push(`knowledge_assertions.story_id = $${params.length}`);
	}
	if (query.assertion_type) {
		params.push(query.assertion_type);
		filters.push(`knowledge_assertions.assertion_type = $${params.length}`);
	}
	const allowed = allowedSensitivity(maxSensitivityLevel);
	if (allowed) {
		params.push(allowed);
		filters.push(`knowledge_assertions.sensitivity_level = ANY($${params.length})`);
		filters.push(`sources.sensitivity_level = ANY($${params.length})`);
	}
	return { filters, params };
}

async function readClaims(
	pool: pg.Pool,
	query: ClaimListQuery,
	maxSensitivityLevel?: ClaimResponse['sensitivity_level'],
): Promise<{ count: number; rows: ClaimRow[] }> {
	const { filters, params } = buildClaimFilters(query, maxSensitivityLevel);
	const whereSql = filters.join(' AND ');
	const countResult = await pool.query<{ count: string }>(
		`
			SELECT COUNT(*) AS count
			FROM knowledge_assertions
			JOIN sources ON sources.id = knowledge_assertions.source_id
			WHERE ${whereSql}
		`,
		params,
	);
	const pageParams = [...params, query.limit, query.offset];
	const rows = await pool.query<ClaimRow>(
		`
			SELECT knowledge_assertions.*
			FROM knowledge_assertions
			JOIN sources ON sources.id = knowledge_assertions.source_id
			WHERE ${whereSql}
			ORDER BY knowledge_assertions.created_at DESC, knowledge_assertions.id ASC
			LIMIT $${pageParams.length - 1} OFFSET $${pageParams.length}
		`,
		pageParams,
	);
	return {
		count: Number.parseInt(countResult.rows[0]?.count ?? '0', 10) || 0,
		rows: rows.rows,
	};
}

async function ensureSource(sourceId: string, maxSensitivityLevel?: ClaimResponse['sensitivity_level']) {
	const { pool } = resolveApiDataContext('claims');
	const source = await findSourceById(pool, sourceId, { maxSensitivityLevel });
	if (!source) {
		throw new MulderError(`Document not found: ${sourceId}`, DOCUMENT_NOT_FOUND_CODE, { context: { id: sourceId } });
	}
}

async function ensureStory(storyId: string) {
	const { pool } = resolveApiDataContext('claims');
	const story = await findStoryById(pool, storyId);
	if (!story) {
		throw new MulderError(`Story not found: ${storyId}`, STORY_NOT_FOUND_CODE, { context: { storyId } });
	}
	return story;
}

export async function listClaims(query: ClaimListQuery, options?: ClaimsRouteOptions): Promise<ClaimListResponse> {
	const { config, pool } = resolveApiDataContext('claims');
	const maxSensitivityLevel = resolveReadMaxSensitivity(config, options?.authPrincipal, 'claims');
	const result = await readClaims(pool, query, maxSensitivityLevel);
	return {
		data: result.rows.map(mapClaim),
		meta: { count: result.count, limit: query.limit, offset: query.offset },
	};
}

export async function getClaim(claimId: string, options?: ClaimsRouteOptions): Promise<ClaimDetailResponse> {
	const { config, pool } = resolveApiDataContext('claims');
	const maxSensitivityLevel = resolveReadMaxSensitivity(config, options?.authPrincipal, 'claims');
	const allowed = allowedSensitivity(maxSensitivityLevel);
	const params: unknown[] = [claimId];
	const filters = [
		'knowledge_assertions.id = $1',
		'knowledge_assertions.deleted_at IS NULL',
		"COALESCE(sources.deletion_status, 'active') NOT IN ('soft_deleted', 'purging', 'purged')",
	];
	if (allowed) {
		params.push(allowed);
		filters.push(`knowledge_assertions.sensitivity_level = ANY($${params.length})`);
		filters.push(`sources.sensitivity_level = ANY($${params.length})`);
	}
	const result = await pool.query<ClaimRow>(
		`
			SELECT knowledge_assertions.*
			FROM knowledge_assertions
			JOIN sources ON sources.id = knowledge_assertions.source_id
			WHERE ${filters.join(' AND ')}
			LIMIT 1
		`,
		params,
	);
	const row = result.rows[0];
	if (!row) {
		throw new MulderError(`Claim not found: ${claimId}`, CLAIM_NOT_FOUND_CODE, { context: { claimId } });
	}
	return { data: mapClaim(row) };
}

export async function listDocumentClaims(
	sourceId: string,
	query: Omit<ClaimListQuery, 'source_id'>,
	options?: ClaimsRouteOptions,
): Promise<ClaimListResponse> {
	const { config } = resolveApiDataContext('claims');
	const maxSensitivityLevel = resolveReadMaxSensitivity(config, options?.authPrincipal, 'claims');
	await ensureSource(sourceId, maxSensitivityLevel);
	return listClaims({ ...query, source_id: sourceId }, options);
}

export async function listStoryClaims(
	storyId: string,
	query: Omit<ClaimListQuery, 'story_id'>,
	options?: ClaimsRouteOptions,
): Promise<ClaimListResponse> {
	const { config } = resolveApiDataContext('claims');
	const maxSensitivityLevel = resolveReadMaxSensitivity(config, options?.authPrincipal, 'claims');
	const story = await ensureStory(storyId);
	await ensureSource(story.sourceId, maxSensitivityLevel);
	return listClaims({ ...query, story_id: storyId }, options);
}
