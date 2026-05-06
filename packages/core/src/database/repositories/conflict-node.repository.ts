import type pg from 'pg';
import { DATABASE_ERROR_CODES, DatabaseError } from '../../shared/errors.js';
import {
	mergeSensitivityMetadata,
	normalizeSensitivityMetadata,
	stringifySensitivityMetadata,
} from '../../shared/sensitivity.js';
import {
	mapArtifactProvenanceFromDb,
	mapArtifactProvenanceToDb,
	normalizeArtifactProvenance,
} from './artifact-provenance.js';
import type {
	ConflictAssertion,
	ConflictDetectionMethod,
	ConflictInvolvementBySource,
	ConflictNode,
	ConflictNodeListOptions,
	ConflictParticipantRole,
	ConflictResolution,
	ConflictResolutionStatus,
	ConflictSeverity,
	ConflictType,
	CreateConflictAssertionInput,
	CreateConflictNodeInput,
	ResolutionType,
	ResolveConflictNodeInput,
} from './conflict-node.types.js';

type Queryable = pg.Pool | pg.PoolClient;

const CONFLICT_TYPES: readonly ConflictType[] = [
	'factual',
	'interpretive',
	'taxonomic',
	'temporal',
	'spatial',
	'attributive',
] as const;
const DETECTION_METHODS: readonly ConflictDetectionMethod[] = ['llm_auto', 'statistical', 'human_reported'] as const;
const RESOLUTION_STATUSES: readonly ConflictResolutionStatus[] = [
	'open',
	'explained',
	'confirmed_contradictory',
	'false_positive',
] as const;
const SEVERITIES: readonly ConflictSeverity[] = ['minor', 'significant', 'fundamental'] as const;
const ROLES: readonly ConflictParticipantRole[] = ['claim_a', 'claim_b', 'context'] as const;
const RESOLUTION_TYPES: readonly ResolutionType[] = [
	'different_vantage_point',
	'different_time',
	'measurement_error',
	'source_unreliable',
	'scope_difference',
	'genuinely_contradictory',
	'duplicate_misidentification',
	'other',
] as const;

interface ConflictNodeRow {
	id: string;
	conflict_type: ConflictType;
	detection_method: ConflictDetectionMethod;
	detected_at: Date;
	detected_by: string;
	resolution_status: ConflictResolutionStatus;
	severity: ConflictSeverity;
	severity_rationale: string;
	review_status: string;
	legacy_edge_id: string | null;
	canonical_assertion_pair: [string, string];
	confidence: string | number;
	provenance: unknown;
	sensitivity_level: ConflictNode['sensitivityLevel'];
	sensitivity_metadata: unknown;
	created_at: Date;
	updated_at: Date;
	deleted_at: Date | null;
	assertions: unknown;
	latest_resolution: unknown;
}

interface AssertionContextRow {
	assertion_id: string;
	source_document_id: string;
	assertion_type: ConflictAssertion['assertionType'];
	content: string;
	credibility_profile_id: string | null;
	provenance: unknown;
	sensitivity_level: ConflictNode['sensitivityLevel'];
	sensitivity_metadata: unknown;
}

function isPool(value: Queryable): value is pg.Pool {
	return !('release' in value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fail(message: string, context?: Record<string, unknown>): never {
	throw new DatabaseError(message, DATABASE_ERROR_CODES.DB_QUERY_FAILED, { context });
}

function assertEnum<T extends string>(value: T, allowed: readonly T[], field: string): void {
	if (!allowed.includes(value)) {
		fail(`Invalid conflict node ${field}: ${value}`, { field, value });
	}
}

function requiredText(value: string, field: string): string {
	const trimmed = value.trim();
	if (trimmed.length === 0) {
		fail(`Invalid conflict node ${field}: value is required`, { field });
	}
	return trimmed;
}

function normalizeEvidenceRefs(value: readonly string[] | undefined): string[] {
	return [...new Set((value ?? []).map((item) => item.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function normalizePair(assertions: readonly CreateConflictAssertionInput[]): [string, string] {
	const primaryIds = assertions
		.filter((assertion) => (assertion.participantRole ?? 'context') !== 'context')
		.map((assertion) => assertion.assertionId.trim())
		.filter(Boolean);
	const ids =
		primaryIds.length >= 2 ? primaryIds : assertions.map((assertion) => assertion.assertionId.trim()).filter(Boolean);
	const unique = [...new Set(ids)].sort((a, b) => a.localeCompare(b));
	if (unique.length < 2) {
		fail('Conflict node requires at least two distinct assertion participants', { assertionCount: unique.length });
	}
	return [unique[0], unique[1]];
}

function defaultRole(index: number): ConflictParticipantRole {
	if (index === 0) return 'claim_a';
	if (index === 1) return 'claim_b';
	return 'context';
}

function mapAssertion(value: unknown): ConflictAssertion | null {
	if (!isRecord(value)) return null;
	return {
		conflictId: String(value.conflict_id),
		assertionId: String(value.assertion_id),
		sourceDocumentId: String(value.source_document_id),
		assertionType: String(value.assertion_type) as ConflictAssertion['assertionType'],
		claim: String(value.claim),
		credibilityProfileId: typeof value.credibility_profile_id === 'string' ? value.credibility_profile_id : null,
		participantRole: String(value.participant_role) as ConflictParticipantRole,
		createdAt: new Date(String(value.created_at)),
	};
}

function mapResolution(value: unknown): ConflictResolution | null {
	if (!isRecord(value)) return null;
	return {
		id: String(value.id),
		conflictId: String(value.conflict_id),
		resolutionType: String(value.resolution_type) as ResolutionType,
		explanation: String(value.explanation),
		resolvedBy: String(value.resolved_by),
		resolvedAt: new Date(String(value.resolved_at)),
		evidenceRefs: Array.isArray(value.evidence_refs) ? value.evidence_refs.map(String) : [],
		reviewStatus: String(value.review_status),
		legacyEdgeId: typeof value.legacy_edge_id === 'string' ? value.legacy_edge_id : null,
		createdAt: new Date(String(value.created_at)),
		updatedAt: new Date(String(value.updated_at)),
	};
}

function mapConflictNodeRow(row: ConflictNodeRow): ConflictNode {
	const assertionValues = Array.isArray(row.assertions) ? row.assertions : [];
	const pair = Array.isArray(row.canonical_assertion_pair)
		? ([String(row.canonical_assertion_pair[0]), String(row.canonical_assertion_pair[1])] as [string, string])
		: (['', ''] as [string, string]);
	return {
		id: row.id,
		conflictType: row.conflict_type,
		detectionMethod: row.detection_method,
		detectedAt: row.detected_at,
		detectedBy: row.detected_by,
		resolutionStatus: row.resolution_status,
		severity: row.severity,
		severityRationale: row.severity_rationale,
		reviewStatus: row.review_status,
		legacyEdgeId: row.legacy_edge_id,
		canonicalAssertionPair: pair,
		confidence: typeof row.confidence === 'number' ? row.confidence : Number.parseFloat(row.confidence),
		provenance: mapArtifactProvenanceFromDb(row.provenance),
		sensitivityLevel: row.sensitivity_level ?? 'internal',
		sensitivityMetadata: normalizeSensitivityMetadata(row.sensitivity_metadata, row.sensitivity_level ?? 'internal'),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		deletedAt: row.deleted_at,
		assertions: assertionValues
			.map(mapAssertion)
			.filter((assertion): assertion is ConflictAssertion => assertion !== null),
		latestResolution: mapResolution(row.latest_resolution),
	};
}

function conflictNodeSelect(whereSql: string, suffixSql = ''): string {
	return `
		SELECT
			cn.*,
			COALESCE(assertion_rows.assertions, '[]'::jsonb) AS assertions,
			to_jsonb(latest_resolution.*) AS latest_resolution
		FROM conflict_nodes cn
		LEFT JOIN LATERAL (
			SELECT jsonb_agg(
					jsonb_build_object(
						'conflict_id', ca.conflict_id,
						'assertion_id', ca.assertion_id,
						'source_document_id', ca.source_document_id,
						'assertion_type', ca.assertion_type,
						'claim', ca.claim,
						'credibility_profile_id', ca.credibility_profile_id,
						'participant_role', ca.participant_role,
						'created_at', ca.created_at
					)
					ORDER BY ca.participant_role, ca.assertion_id
				) AS assertions
			FROM conflict_assertions ca
			WHERE ca.conflict_id = cn.id
		) assertion_rows ON true
		LEFT JOIN LATERAL (
			SELECT cr.*
			FROM conflict_resolutions cr
			WHERE cr.conflict_id = cn.id
			ORDER BY cr.resolved_at DESC, cr.created_at DESC, cr.id DESC
			LIMIT 1
		) latest_resolution ON true
		${whereSql}
		ORDER BY cn.detected_at DESC, cn.id ASC
		${suffixSql}
	`;
}

async function readConflictNodes(
	pool: Queryable,
	whereSql: string,
	params: unknown[],
	suffixSql = '',
): Promise<ConflictNode[]> {
	const result = await pool.query<ConflictNodeRow>(conflictNodeSelect(whereSql, suffixSql), params);
	return result.rows.map(mapConflictNodeRow);
}

async function getAssertionContexts(pool: Queryable, assertionIds: readonly string[]): Promise<AssertionContextRow[]> {
	const result = await pool.query<AssertionContextRow>(
		`
			SELECT
				ka.id AS assertion_id,
				ka.source_id AS source_document_id,
				ka.assertion_type,
				ka.content,
				scp.profile_id AS credibility_profile_id,
				ka.provenance,
				ka.sensitivity_level,
				ka.sensitivity_metadata
			FROM knowledge_assertions ka
			LEFT JOIN source_credibility_profiles scp ON scp.source_id = ka.source_id
			WHERE ka.id = ANY($1::uuid[])
				AND ka.deleted_at IS NULL
			ORDER BY ka.id
		`,
		[assertionIds],
	);
	return result.rows;
}

async function writeConflictNode(client: Queryable, input: CreateConflictNodeInput): Promise<ConflictNode> {
	assertEnum(input.conflictType, CONFLICT_TYPES, 'conflictType');
	assertEnum(input.detectionMethod, DETECTION_METHODS, 'detectionMethod');
	assertEnum(input.severity, SEVERITIES, 'severity');
	requiredText(input.detectedBy, 'detectedBy');
	requiredText(input.severityRationale, 'severityRationale');
	if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) {
		fail('Conflict node confidence must be between 0 and 1', { confidence: input.confidence });
	}
	if (input.assertions.length < 2) {
		fail('Conflict node requires at least two assertion participants', { assertionCount: input.assertions.length });
	}

	const pair = normalizePair(input.assertions);
	const uniqueAssertionIds = [
		...new Set(input.assertions.map((assertion) => assertion.assertionId.trim()).filter(Boolean)),
	];
	const contexts = await getAssertionContexts(client, uniqueAssertionIds);
	if (contexts.length !== uniqueAssertionIds.length) {
		fail('Conflict node references unknown or deleted assertions', {
			expected: uniqueAssertionIds.length,
			found: contexts.length,
		});
	}
	const contextById = new Map(contexts.map((context) => [context.assertion_id, context]));
	const provenance =
		input.provenance ??
		normalizeArtifactProvenance({
			sourceDocumentIds: contexts.map((context) => context.source_document_id),
		});
	const sensitivity = input.sensitivityMetadata
		? normalizeSensitivityMetadata(input.sensitivityMetadata, input.sensitivityLevel ?? 'internal')
		: mergeSensitivityMetadata(
				contexts.map((context) => context.sensitivity_metadata),
				input.sensitivityLevel ?? 'internal',
			);
	const sensitivityLevel = input.sensitivityLevel ?? sensitivity.level;

	const inserted = await client.query<{ id: string }>(
		`
			INSERT INTO conflict_nodes (
				conflict_type,
				detection_method,
				detected_by,
				severity,
				severity_rationale,
				review_status,
				legacy_edge_id,
				canonical_assertion_pair,
				confidence,
				provenance,
				sensitivity_level,
				sensitivity_metadata
			)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8::uuid[], $9, $10::jsonb, $11, $12::jsonb)
			ON CONFLICT (conflict_type, canonical_assertion_pair)
			WHERE deleted_at IS NULL
			DO UPDATE SET updated_at = conflict_nodes.updated_at
			RETURNING id
		`,
		[
			input.conflictType,
			input.detectionMethod,
			requiredText(input.detectedBy, 'detectedBy'),
			input.severity,
			requiredText(input.severityRationale, 'severityRationale'),
			input.reviewStatus?.trim() || 'pending',
			input.legacyEdgeId ?? null,
			pair,
			input.confidence,
			JSON.stringify(mapArtifactProvenanceToDb(provenance)),
			sensitivityLevel,
			stringifySensitivityMetadata(sensitivity, sensitivityLevel),
		],
	);

	const conflictId = inserted.rows[0].id;
	for (let index = 0; index < input.assertions.length; index++) {
		const participant = input.assertions[index];
		const context = contextById.get(participant.assertionId);
		if (!context) continue;
		const participantRole = participant.participantRole ?? defaultRole(index);
		assertEnum(participantRole, ROLES, 'participantRole');
		await client.query(
			`
				INSERT INTO conflict_assertions (
					conflict_id,
					assertion_id,
					source_document_id,
					assertion_type,
					claim,
					credibility_profile_id,
					participant_role
				)
				VALUES ($1, $2, $3, $4, $5, $6, $7)
				ON CONFLICT (conflict_id, assertion_id) DO UPDATE SET
					claim = EXCLUDED.claim,
					credibility_profile_id = EXCLUDED.credibility_profile_id,
					participant_role = EXCLUDED.participant_role
			`,
			[
				conflictId,
				context.assertion_id,
				context.source_document_id,
				context.assertion_type,
				requiredText(participant.claim ?? context.content, 'claim'),
				context.credibility_profile_id,
				participantRole,
			],
		);
	}

	const written = await findConflictNodeById(client, conflictId);
	if (!written) fail('Conflict node disappeared after write', { conflictId });
	return written;
}

export async function createConflictNode(pool: Queryable, input: CreateConflictNodeInput): Promise<ConflictNode> {
	try {
		if (!isPool(pool)) {
			return await writeConflictNode(pool, input);
		}
		const client = await pool.connect();
		try {
			await client.query('BEGIN');
			const node = await writeConflictNode(client, input);
			await client.query('COMMIT');
			return node;
		} catch (cause: unknown) {
			await client.query('ROLLBACK').catch(() => {});
			throw cause;
		} finally {
			client.release();
		}
	} catch (cause: unknown) {
		if (cause instanceof DatabaseError) throw cause;
		throw new DatabaseError('Failed to create conflict node', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause,
			context: { conflictType: input.conflictType, legacyEdgeId: input.legacyEdgeId },
		});
	}
}

export async function findConflictNodeById(pool: Queryable, conflictId: string): Promise<ConflictNode | null> {
	try {
		return (await readConflictNodes(pool, 'WHERE cn.id = $1', [conflictId]))[0] ?? null;
	} catch (cause: unknown) {
		throw new DatabaseError('Failed to find conflict node by ID', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause,
			context: { conflictId },
		});
	}
}

export async function findConflictNodeByLegacyEdgeId(
	pool: Queryable,
	legacyEdgeId: string,
): Promise<ConflictNode | null> {
	try {
		return (
			(await readConflictNodes(pool, 'WHERE cn.legacy_edge_id = $1 AND cn.deleted_at IS NULL', [legacyEdgeId]))[0] ??
			null
		);
	} catch (cause: unknown) {
		throw new DatabaseError('Failed to find conflict node by legacy edge ID', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause,
			context: { legacyEdgeId },
		});
	}
}

export async function listConflictNodes(pool: Queryable, options?: ConflictNodeListOptions): Promise<ConflictNode[]> {
	const filters: string[] = [];
	const params: unknown[] = [];
	if (!options?.includeDeleted) filters.push('cn.deleted_at IS NULL');
	if (options?.conflictType) {
		assertEnum(options.conflictType, CONFLICT_TYPES, 'conflictType');
		params.push(options.conflictType);
		filters.push(`cn.conflict_type = $${params.length}`);
	}
	if (options?.severity) {
		assertEnum(options.severity, SEVERITIES, 'severity');
		params.push(options.severity);
		filters.push(`cn.severity = $${params.length}`);
	}
	if (options?.resolutionStatus) {
		assertEnum(options.resolutionStatus, RESOLUTION_STATUSES, 'resolutionStatus');
		params.push(options.resolutionStatus);
		filters.push(`cn.resolution_status = $${params.length}`);
	}
	if (options?.sourceDocumentId) {
		params.push(options.sourceDocumentId);
		filters.push(`EXISTS (
			SELECT 1 FROM conflict_assertions ca_filter
			WHERE ca_filter.conflict_id = cn.id AND ca_filter.source_document_id = $${params.length}
		)`);
	}
	const limit = options?.limit ?? 100;
	const offset = options?.offset ?? 0;
	params.push(limit, offset);
	const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
	try {
		return await readConflictNodes(pool, where, params, `LIMIT $${params.length - 1} OFFSET $${params.length}`);
	} catch (cause: unknown) {
		throw new DatabaseError('Failed to list conflict nodes', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause,
			context: { options },
		});
	}
}

export async function listOpenConflictNodes(
	pool: Queryable,
	options?: Omit<ConflictNodeListOptions, 'resolutionStatus'>,
): Promise<ConflictNode[]> {
	return listConflictNodes(pool, { ...options, resolutionStatus: 'open' });
}

function defaultResolutionStatus(resolutionType: ResolutionType): ConflictResolutionStatus {
	if (resolutionType === 'duplicate_misidentification') return 'false_positive';
	if (resolutionType === 'genuinely_contradictory' || resolutionType === 'source_unreliable') {
		return 'confirmed_contradictory';
	}
	return 'explained';
}

async function writeResolution(client: Queryable, input: ResolveConflictNodeInput): Promise<ConflictNode> {
	assertEnum(input.resolutionType, RESOLUTION_TYPES, 'resolutionType');
	const resolutionStatus = input.resolutionStatus ?? defaultResolutionStatus(input.resolutionType);
	assertEnum(resolutionStatus, RESOLUTION_STATUSES, 'resolutionStatus');
	if (resolutionStatus === 'open') {
		fail('Resolved conflict nodes cannot be set back to open', { conflictId: input.conflictId });
	}
	requiredText(input.explanation, 'explanation');
	requiredText(input.resolvedBy, 'resolvedBy');

	await client.query(
		`
			INSERT INTO conflict_resolutions (
				conflict_id,
				resolution_type,
				explanation,
				resolved_by,
				resolved_at,
				evidence_refs,
				review_status,
				legacy_edge_id
			)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
			ON CONFLICT (conflict_id, legacy_edge_id)
			WHERE legacy_edge_id IS NOT NULL
			DO UPDATE SET
				resolution_type = EXCLUDED.resolution_type,
				explanation = EXCLUDED.explanation,
				resolved_by = EXCLUDED.resolved_by,
				resolved_at = EXCLUDED.resolved_at,
				evidence_refs = EXCLUDED.evidence_refs,
				review_status = EXCLUDED.review_status,
				updated_at = now()
		`,
		[
			input.conflictId,
			input.resolutionType,
			requiredText(input.explanation, 'explanation'),
			requiredText(input.resolvedBy, 'resolvedBy'),
			input.resolvedAt ?? new Date(),
			normalizeEvidenceRefs(input.evidenceRefs),
			input.reviewStatus?.trim() || 'pending',
			input.legacyEdgeId ?? null,
		],
	);
	const updated = await client.query(
		`
			UPDATE conflict_nodes
			SET resolution_status = $2,
				legacy_edge_id = COALESCE(legacy_edge_id, $3),
				updated_at = now()
			WHERE id = $1
				AND deleted_at IS NULL
		`,
		[input.conflictId, resolutionStatus, input.legacyEdgeId ?? null],
	);
	if ((updated.rowCount ?? 0) === 0) {
		fail('Conflict node not found for resolution', { conflictId: input.conflictId });
	}
	const node = await findConflictNodeById(client, input.conflictId);
	if (!node) fail('Conflict node disappeared after resolution', { conflictId: input.conflictId });
	return node;
}

export async function resolveConflictNode(pool: Queryable, input: ResolveConflictNodeInput): Promise<ConflictNode> {
	try {
		if (!isPool(pool)) return await writeResolution(pool, input);
		const client = await pool.connect();
		try {
			await client.query('BEGIN');
			const node = await writeResolution(client, input);
			await client.query('COMMIT');
			return node;
		} catch (cause: unknown) {
			await client.query('ROLLBACK').catch(() => {});
			throw cause;
		} finally {
			client.release();
		}
	} catch (cause: unknown) {
		if (cause instanceof DatabaseError) throw cause;
		throw new DatabaseError('Failed to resolve conflict node', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause,
			context: { conflictId: input.conflictId, resolutionType: input.resolutionType },
		});
	}
}

export async function deleteConflictNodesForStory(pool: Queryable, storyId: string): Promise<number> {
	try {
		const result = await pool.query(
			`
				DELETE FROM conflict_nodes
				WHERE id IN (
					SELECT ca.conflict_id
					FROM conflict_assertions ca
					JOIN knowledge_assertions ka ON ka.id = ca.assertion_id
					WHERE ka.story_id = $1
				)
			`,
			[storyId],
		);
		return result.rowCount ?? 0;
	} catch (cause: unknown) {
		throw new DatabaseError('Failed to delete conflict nodes for story', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause,
			context: { storyId },
		});
	}
}

export async function listConflictInvolvementBySource(pool: Queryable): Promise<ConflictInvolvementBySource[]> {
	try {
		const result = await pool.query<{
			source_document_id: string;
			total_count: string;
			open_count: string;
			resolved_count: string;
		}>(`
			SELECT
				ca.source_document_id,
				COUNT(DISTINCT cn.id) AS total_count,
				COUNT(DISTINCT cn.id) FILTER (WHERE cn.resolution_status = 'open') AS open_count,
				COUNT(DISTINCT cn.id) FILTER (WHERE cn.resolution_status <> 'open') AS resolved_count
			FROM conflict_assertions ca
			JOIN conflict_nodes cn ON cn.id = ca.conflict_id
			WHERE cn.deleted_at IS NULL
			GROUP BY ca.source_document_id
			ORDER BY ca.source_document_id
		`);
		return result.rows.map((row) => ({
			sourceDocumentId: row.source_document_id,
			totalCount: Number.parseInt(row.total_count, 10),
			openCount: Number.parseInt(row.open_count, 10),
			resolvedCount: Number.parseInt(row.resolved_count, 10),
		}));
	} catch (cause: unknown) {
		throw new DatabaseError('Failed to list conflict involvement by source', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause,
		});
	}
}
