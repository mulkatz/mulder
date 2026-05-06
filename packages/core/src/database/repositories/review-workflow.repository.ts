import type pg from 'pg';
import { DATABASE_ERROR_CODES, DatabaseError } from '../../shared/errors.js';
import type {
	AutoApproveDueReviewArtifactsOptions,
	AutoApproveDueReviewArtifactsResult,
	PipelineReviewResetStep,
	RecordReviewEventInput,
	ReviewAction,
	ReviewArtifactType,
	ReviewableArtifact,
	ReviewableArtifactListOptions,
	ReviewConfidence,
	ReviewCreatedBy,
	ReviewEvent,
	ReviewEventListOptions,
	ReviewJsonObject,
	ReviewQueue,
	ReviewQueueArtifactListOptions,
	ReviewQueueListOptions,
	ReviewStatus,
	UpsertReviewableArtifactInput,
	UpsertReviewQueueInput,
} from './review-workflow.types.js';

type Queryable = pg.Pool | pg.PoolClient;

const ARTIFACT_TYPES: readonly ReviewArtifactType[] = [
	'assertion_classification',
	'credibility_profile',
	'taxonomy_mapping',
	'similar_case_link',
	'agent_finding',
	'conflict_node',
	'conflict_resolution',
] as const;
const STATUSES: readonly ReviewStatus[] = [
	'pending',
	'approved',
	'auto_approved',
	'corrected',
	'contested',
	'rejected',
] as const;
const ACTIONS: readonly ReviewAction[] = ['approve', 'correct', 'reject', 'comment', 'escalate'] as const;
const CONFIDENCE_VALUES: readonly ReviewConfidence[] = ['certain', 'likely', 'uncertain'] as const;
const CREATED_BY_VALUES: readonly ReviewCreatedBy[] = ['llm_auto', 'human', 'agent'] as const;
const TERMINAL_ACTIONS: readonly ReviewAction[] = ['approve', 'correct', 'reject'] as const;

interface ReviewArtifactRow {
	artifact_id: string;
	artifact_type: ReviewArtifactType;
	subject_id: string;
	subject_table: string;
	created_by: ReviewCreatedBy;
	review_status: ReviewStatus;
	current_value: unknown;
	context: unknown;
	source_id: string | null;
	priority: number;
	due_at: Date | null;
	created_at: Date;
	updated_at: Date;
	deleted_at: Date | null;
}

interface ReviewEventRow {
	event_id: string;
	artifact_id: string;
	reviewer_id: string;
	action: ReviewAction;
	previous_value: unknown | null;
	new_value: unknown | null;
	confidence: ReviewConfidence;
	rationale: string | null;
	tags: string[] | null;
	created_at: Date;
	correction_value_differs?: boolean | null;
}

interface ReviewQueueRow {
	queue_key: string;
	name: string;
	artifact_types: ReviewArtifactType[] | null;
	assignees: string[] | null;
	priority_rules: unknown;
	active: boolean;
	pending_count: string | number;
	oldest_pending: Date | null;
	created_at: Date;
	updated_at: Date;
}

function isPool(value: Queryable): value is pg.Pool {
	return 'connect' in value;
}

function isRecord(value: unknown): value is ReviewJsonObject {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fail(message: string, context?: Record<string, unknown>): never {
	throw new DatabaseError(message, DATABASE_ERROR_CODES.DB_QUERY_FAILED, { context });
}

function assertEnum<T extends string>(value: T, allowed: readonly T[], field: string): void {
	if (!allowed.includes(value)) fail(`Invalid review workflow ${field}: ${value}`, { field, value });
}

function requiredText(value: string, field: string): string {
	const trimmed = value.trim();
	if (trimmed.length === 0) fail(`Invalid review workflow ${field}: value is required`, { field });
	return trimmed;
}

function normalizeTags(value: readonly string[] | undefined): string[] {
	return [...new Set((value ?? []).map((item) => item.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function parseDate(value: Date | string | null | undefined): Date | null {
	if (value === null || value === undefined) return null;
	return value instanceof Date ? value : new Date(value);
}

function normalizeObject(value: unknown, field: string): ReviewJsonObject {
	if (!isRecord(value)) fail(`Review workflow ${field} must be a JSON object`, { field });
	return value;
}

function mapArtifactRow(row: ReviewArtifactRow): ReviewableArtifact {
	return {
		artifactId: row.artifact_id,
		artifactType: row.artifact_type,
		subjectId: row.subject_id,
		subjectTable: row.subject_table,
		createdBy: row.created_by,
		reviewStatus: row.review_status,
		currentValue: normalizeObject(row.current_value, 'currentValue'),
		context: normalizeObject(row.context, 'context'),
		sourceId: row.source_id,
		priority: row.priority,
		dueAt: row.due_at,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		deletedAt: row.deleted_at,
	};
}

function mapEventRow(row: ReviewEventRow): ReviewEvent {
	return {
		eventId: row.event_id,
		artifactId: row.artifact_id,
		reviewerId: row.reviewer_id,
		action: row.action,
		previousValue: row.previous_value,
		newValue: row.new_value,
		confidence: row.confidence,
		rationale: row.rationale,
		tags: row.tags ?? [],
		createdAt: row.created_at,
	};
}

function mapQueueRow(row: ReviewQueueRow): ReviewQueue {
	return {
		queueKey: row.queue_key,
		name: row.name,
		artifactTypes: row.artifact_types ?? [],
		assignees: row.assignees ?? [],
		priorityRules: normalizeObject(row.priority_rules, 'priorityRules'),
		active: row.active,
		pendingCount: typeof row.pending_count === 'number' ? row.pending_count : Number.parseInt(row.pending_count, 10),
		oldestPending: row.oldest_pending,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function artifactSelect(whereSql: string, suffixSql = ''): string {
	return `
		SELECT *
		FROM review_artifacts
		${whereSql}
		ORDER BY priority DESC, COALESCE(due_at, created_at) ASC, artifact_id ASC
		${suffixSql}
	`;
}

async function readArtifacts(pool: Queryable, whereSql: string, params: unknown[], suffixSql = '') {
	const result = await pool.query<ReviewArtifactRow>(artifactSelect(whereSql, suffixSql), params);
	return result.rows.map(mapArtifactRow);
}

function validateArtifactInput(input: UpsertReviewableArtifactInput): void {
	assertEnum(input.artifactType, ARTIFACT_TYPES, 'artifactType');
	requiredText(input.subjectId, 'subjectId');
	requiredText(input.subjectTable, 'subjectTable');
	assertEnum(input.createdBy ?? 'llm_auto', CREATED_BY_VALUES, 'createdBy');
	assertEnum(input.reviewStatus ?? 'pending', STATUSES, 'reviewStatus');
	normalizeObject(input.currentValue, 'currentValue');
	normalizeObject(input.context ?? {}, 'context');
}

export async function upsertReviewableArtifact(
	pool: Queryable,
	input: UpsertReviewableArtifactInput,
): Promise<ReviewableArtifact> {
	try {
		validateArtifactInput(input);
		const result = await pool.query<ReviewArtifactRow>(
			`
				INSERT INTO review_artifacts (
					artifact_type,
					subject_id,
					subject_table,
					created_by,
					review_status,
					current_value,
					context,
					source_id,
					priority,
					due_at
				)
				VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10)
				ON CONFLICT (artifact_type, subject_id)
				WHERE deleted_at IS NULL
				DO UPDATE SET
					subject_table = EXCLUDED.subject_table,
					created_by = EXCLUDED.created_by,
					review_status = CASE
						WHEN review_artifacts.current_value IS DISTINCT FROM EXCLUDED.current_value
							OR ($11 AND review_artifacts.context IS DISTINCT FROM EXCLUDED.context)
						THEN CASE
							WHEN review_artifacts.review_status = 'contested' THEN review_artifacts.review_status
							WHEN review_artifacts.review_status IN ('approved', 'auto_approved', 'corrected', 'rejected') THEN 'pending'
							ELSE review_artifacts.review_status
						END
						ELSE review_artifacts.review_status
					END,
					current_value = EXCLUDED.current_value,
					context = CASE WHEN $11 THEN EXCLUDED.context ELSE review_artifacts.context END,
					source_id = CASE WHEN $12 THEN EXCLUDED.source_id ELSE review_artifacts.source_id END,
					priority = CASE WHEN $13 THEN EXCLUDED.priority ELSE review_artifacts.priority END,
					due_at = CASE WHEN $14 THEN EXCLUDED.due_at ELSE review_artifacts.due_at END,
					updated_at = now()
				RETURNING *
			`,
			[
				input.artifactType,
				requiredText(input.subjectId, 'subjectId'),
				requiredText(input.subjectTable, 'subjectTable'),
				input.createdBy ?? 'llm_auto',
				input.reviewStatus ?? 'pending',
				JSON.stringify(input.currentValue),
				JSON.stringify(input.context ?? {}),
				input.sourceId ?? null,
				input.priority ?? 0,
				parseDate(input.dueAt),
				input.context !== undefined,
				input.sourceId !== undefined,
				input.priority !== undefined,
				input.dueAt !== undefined,
			],
		);
		return mapArtifactRow(result.rows[0]);
	} catch (cause: unknown) {
		if (cause instanceof DatabaseError) throw cause;
		throw new DatabaseError('Failed to upsert reviewable artifact', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause,
			context: { artifactType: input.artifactType, subjectId: input.subjectId },
		});
	}
}

export async function findReviewableArtifactById(
	pool: Queryable,
	artifactId: string,
): Promise<ReviewableArtifact | null> {
	try {
		return (await readArtifacts(pool, 'WHERE artifact_id = $1', [artifactId]))[0] ?? null;
	} catch (cause: unknown) {
		throw new DatabaseError('Failed to find reviewable artifact by ID', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause,
			context: { artifactId },
		});
	}
}

export async function findReviewableArtifactBySubject(
	pool: Queryable,
	artifactType: ReviewArtifactType,
	subjectId: string,
): Promise<ReviewableArtifact | null> {
	try {
		assertEnum(artifactType, ARTIFACT_TYPES, 'artifactType');
		return (
			(
				await readArtifacts(pool, 'WHERE artifact_type = $1 AND subject_id = $2 AND deleted_at IS NULL', [
					artifactType,
					subjectId,
				])
			)[0] ?? null
		);
	} catch (cause: unknown) {
		if (cause instanceof DatabaseError) throw cause;
		throw new DatabaseError('Failed to find reviewable artifact by subject', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause,
			context: { artifactType, subjectId },
		});
	}
}

export async function listReviewableArtifacts(
	pool: Queryable,
	options?: ReviewableArtifactListOptions,
): Promise<ReviewableArtifact[]> {
	const filters: string[] = [];
	const params: unknown[] = [];
	if (!options?.includeDeleted) filters.push('deleted_at IS NULL');
	if (options?.artifactType) {
		assertEnum(options.artifactType, ARTIFACT_TYPES, 'artifactType');
		params.push(options.artifactType);
		filters.push(`artifact_type = $${params.length}`);
	}
	if (options?.reviewStatus) {
		assertEnum(options.reviewStatus, STATUSES, 'reviewStatus');
		params.push(options.reviewStatus);
		filters.push(`review_status = $${params.length}`);
	}
	if (options?.sourceId) {
		params.push(options.sourceId);
		filters.push(`source_id = $${params.length}`);
	}
	const limit = options?.limit ?? 100;
	const offset = options?.offset ?? 0;
	params.push(limit, offset);
	const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
	try {
		return await readArtifacts(pool, where, params, `LIMIT $${params.length - 1} OFFSET $${params.length}`);
	} catch (cause: unknown) {
		throw new DatabaseError('Failed to list reviewable artifacts', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause,
			context: { options },
		});
	}
}

function statusForAction(action: ReviewAction, previousStatus: ReviewStatus): ReviewStatus {
	if (previousStatus === 'contested') return 'contested';
	if (action === 'approve') return 'approved';
	if (action === 'correct') return 'corrected';
	if (action === 'reject') return 'rejected';
	if (action === 'escalate') return 'contested';
	return previousStatus;
}

function isContradictoryTerminalAction(
	latest: ReviewEventRow | undefined,
	input: RecordReviewEventInput,
	currentStatus: ReviewStatus,
): boolean {
	if (!TERMINAL_ACTIONS.includes(input.action)) return false;
	if (!['approved', 'corrected', 'rejected'].includes(currentStatus)) return false;
	if (!latest || latest.reviewer_id === input.reviewerId) return false;
	if (latest.action === 'correct' && input.action === 'correct') return latest.correction_value_differs === true;
	return latest.action !== input.action;
}

async function recordEventInTransaction(
	client: Queryable,
	input: RecordReviewEventInput,
): Promise<{ artifact: ReviewableArtifact; event: ReviewEvent }> {
	assertEnum(input.action, ACTIONS, 'action');
	assertEnum(input.confidence ?? 'likely', CONFIDENCE_VALUES, 'confidence');
	const reviewerId = requiredText(input.reviewerId, 'reviewerId');
	const rationale = input.rationale?.trim() || null;
	if (['correct', 'reject', 'escalate'].includes(input.action) && !rationale) {
		fail(`Review ${input.action} requires rationale`, { action: input.action, artifactId: input.artifactId });
	}
	if (input.action === 'correct') normalizeObject(input.newValue, 'newValue');

	const artifactResult = await client.query<ReviewArtifactRow>(
		'SELECT * FROM review_artifacts WHERE artifact_id = $1 AND deleted_at IS NULL FOR UPDATE',
		[input.artifactId],
	);
	const artifactRow = artifactResult.rows[0];
	if (!artifactRow) fail('Review artifact not found', { artifactId: input.artifactId });

	const latestTerminal = await client.query<ReviewEventRow>(
		`
			SELECT *
				, CASE
					WHEN action = 'correct' AND $2::jsonb IS NOT NULL THEN new_value IS DISTINCT FROM $2::jsonb
					ELSE false
				END AS correction_value_differs
			FROM review_events
			WHERE artifact_id = $1
				AND action IN ('approve', 'correct', 'reject')
			ORDER BY created_at DESC, event_id DESC
			LIMIT 1
		`,
		[input.artifactId, input.action === 'correct' ? JSON.stringify(input.newValue) : null],
	);
	const eventResult = await client.query<ReviewEventRow>(
		`
			INSERT INTO review_events (
				artifact_id,
				reviewer_id,
				action,
				previous_value,
				new_value,
				confidence,
				rationale,
				tags,
				created_at
			)
			VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, COALESCE($9, now()))
			RETURNING *
		`,
		[
			input.artifactId,
			reviewerId,
			input.action,
			input.action === 'comment' ? null : JSON.stringify(artifactRow.current_value),
			input.newValue === undefined || input.newValue === null ? null : JSON.stringify(input.newValue),
			input.confidence ?? 'likely',
			rationale,
			normalizeTags(input.tags),
			parseDate(input.createdAt),
		],
	);
	const nextStatus = isContradictoryTerminalAction(latestTerminal.rows[0], input, artifactRow.review_status)
		? 'contested'
		: statusForAction(input.action, artifactRow.review_status);
	const nextValue =
		input.action === 'correct' && isRecord(input.newValue)
			? input.newValue
			: normalizeObject(artifactRow.current_value, 'currentValue');
	const updated = await client.query<ReviewArtifactRow>(
		`
			UPDATE review_artifacts
			SET review_status = $2,
				current_value = $3::jsonb,
				updated_at = now()
			WHERE artifact_id = $1
			RETURNING *
		`,
		[input.artifactId, nextStatus, JSON.stringify(nextValue)],
	);
	return {
		artifact: mapArtifactRow(updated.rows[0]),
		event: mapEventRow(eventResult.rows[0]),
	};
}

export async function recordReviewEvent(
	pool: Queryable,
	input: RecordReviewEventInput,
): Promise<{ artifact: ReviewableArtifact; event: ReviewEvent }> {
	try {
		if (!isPool(pool)) return await recordEventInTransaction(pool, input);
		const client = await pool.connect();
		try {
			await client.query('BEGIN');
			const output = await recordEventInTransaction(client, input);
			await client.query('COMMIT');
			return output;
		} catch (cause: unknown) {
			await client.query('ROLLBACK').catch(() => {});
			throw cause;
		} finally {
			client.release();
		}
	} catch (cause: unknown) {
		if (cause instanceof DatabaseError) throw cause;
		throw new DatabaseError('Failed to record review event', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause,
			context: { artifactId: input.artifactId, action: input.action },
		});
	}
}

export async function listReviewEvents(
	pool: Queryable,
	artifactId: string,
	options?: ReviewEventListOptions,
): Promise<ReviewEvent[]> {
	const filters = ['artifact_id = $1'];
	const params: unknown[] = [artifactId];
	if (options?.action) {
		assertEnum(options.action, ACTIONS, 'action');
		params.push(options.action);
		filters.push(`action = $${params.length}`);
	}
	if (options?.reviewerId) {
		params.push(options.reviewerId);
		filters.push(`reviewer_id = $${params.length}`);
	}
	const limit = options?.limit ?? 100;
	const offset = options?.offset ?? 0;
	params.push(limit, offset);
	try {
		const result = await pool.query<ReviewEventRow>(
			`
				SELECT *
				FROM review_events
				WHERE ${filters.join(' AND ')}
				ORDER BY created_at ASC, event_id ASC
				LIMIT $${params.length - 1} OFFSET $${params.length}
			`,
			params,
		);
		return result.rows.map(mapEventRow);
	} catch (cause: unknown) {
		if (cause instanceof DatabaseError) throw cause;
		throw new DatabaseError('Failed to list review events', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause,
			context: { artifactId, options },
		});
	}
}

export async function upsertReviewQueue(pool: Queryable, input: UpsertReviewQueueInput): Promise<ReviewQueue> {
	try {
		for (const artifactType of input.artifactTypes) assertEnum(artifactType, ARTIFACT_TYPES, 'artifactType');
		const result = await pool.query<ReviewQueueRow>(
			`
				WITH written AS (
					INSERT INTO review_queues (queue_key, name, artifact_types, assignees, priority_rules, active)
					VALUES ($1, $2, $3, $4, $5::jsonb, $6)
					ON CONFLICT (queue_key) DO UPDATE SET
						name = EXCLUDED.name,
						artifact_types = EXCLUDED.artifact_types,
						assignees = EXCLUDED.assignees,
						priority_rules = EXCLUDED.priority_rules,
						active = EXCLUDED.active,
						updated_at = now()
					RETURNING *
				)
				SELECT written.*, 0 AS pending_count, NULL::timestamptz AS oldest_pending
				FROM written
			`,
			[
				requiredText(input.queueKey, 'queueKey'),
				requiredText(input.name, 'name'),
				input.artifactTypes,
				normalizeTags(input.assignees),
				JSON.stringify(input.priorityRules ?? {}),
				input.active ?? true,
			],
		);
		return mapQueueRow(result.rows[0]);
	} catch (cause: unknown) {
		if (cause instanceof DatabaseError) throw cause;
		throw new DatabaseError('Failed to upsert review queue', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause,
			context: { queueKey: input.queueKey },
		});
	}
}

export async function listReviewQueues(pool: Queryable, options?: ReviewQueueListOptions): Promise<ReviewQueue[]> {
	const where = (options?.activeOnly ?? true) ? 'WHERE rq.active' : '';
	try {
		const result = await pool.query<ReviewQueueRow>(`
			SELECT
				rq.*,
				COUNT(ra.artifact_id) AS pending_count,
				MIN(COALESCE(ra.due_at, ra.created_at)) AS oldest_pending
			FROM review_queues rq
			LEFT JOIN review_artifacts ra ON ra.artifact_type = ANY(rq.artifact_types)
				AND ra.deleted_at IS NULL
				AND (
					(rq.queue_key = 'contested_artifacts' AND ra.review_status = 'contested')
					OR (rq.queue_key <> 'contested_artifacts' AND ra.review_status = 'pending')
				)
			${where}
			GROUP BY rq.queue_key
			ORDER BY rq.name ASC, rq.queue_key ASC
		`);
		return result.rows.map(mapQueueRow);
	} catch (cause: unknown) {
		throw new DatabaseError('Failed to list review queues', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause,
			context: { options },
		});
	}
}

export async function listReviewQueueArtifacts(
	pool: Queryable,
	queueKey: string,
	options?: ReviewQueueArtifactListOptions,
): Promise<ReviewableArtifact[]> {
	const queue = await pool.query<{ artifact_types: ReviewArtifactType[] | null }>(
		'SELECT artifact_types FROM review_queues WHERE queue_key = $1 AND active',
		[queueKey],
	);
	const artifactTypes = queue.rows[0]?.artifact_types ?? null;
	if (!artifactTypes) return [];
	const reviewStatus = options?.reviewStatus ?? (queueKey === 'contested_artifacts' ? 'contested' : 'pending');
	assertEnum(reviewStatus, STATUSES, 'reviewStatus');
	const limit = options?.limit ?? 100;
	const offset = options?.offset ?? 0;
	try {
		return await readArtifacts(
			pool,
			'WHERE artifact_type = ANY($1::text[]) AND review_status = $2 AND deleted_at IS NULL',
			[artifactTypes, reviewStatus, limit, offset],
			'LIMIT $3 OFFSET $4',
		);
	} catch (cause: unknown) {
		if (cause instanceof DatabaseError) throw cause;
		throw new DatabaseError('Failed to list review queue artifacts', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause,
			context: { queueKey, reviewStatus },
		});
	}
}

export async function autoApproveDueReviewArtifacts(
	pool: Queryable,
	options?: AutoApproveDueReviewArtifactsOptions,
): Promise<AutoApproveDueReviewArtifactsResult> {
	const now = parseDate(options?.now) ?? new Date();
	const artifactTypes = options?.artifactTypes ? [...options.artifactTypes] : ARTIFACT_TYPES;
	for (const artifactType of artifactTypes) assertEnum(artifactType, ARTIFACT_TYPES, 'artifactType');
	const limit = options?.limit ?? 100;
	try {
		const result = await pool.query<ReviewArtifactRow>(
			`
				WITH due AS (
					SELECT artifact_id
					FROM review_artifacts
					WHERE deleted_at IS NULL
						AND review_status = 'pending'
						AND due_at IS NOT NULL
						AND due_at <= $1
						AND artifact_type = ANY($2::text[])
					ORDER BY due_at ASC, priority DESC, created_at ASC
					LIMIT $3
					FOR UPDATE
				)
				UPDATE review_artifacts ra
				SET review_status = 'auto_approved',
					updated_at = now()
				FROM due
				WHERE ra.artifact_id = due.artifact_id
				RETURNING ra.*
			`,
			[now, artifactTypes, limit],
		);
		const artifacts = result.rows.map(mapArtifactRow);
		return { updatedCount: artifacts.length, artifacts };
	} catch (cause: unknown) {
		if (cause instanceof DatabaseError) throw cause;
		throw new DatabaseError('Failed to auto-approve due review artifacts', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause,
			context: { artifactTypes, now },
		});
	}
}

export async function softDeleteReviewArtifactsForSource(
	pool: Queryable,
	sourceId: string,
	deletedAt?: Date,
): Promise<number> {
	try {
		const result = await pool.query(
			`
				UPDATE review_artifacts
				SET deleted_at = COALESCE(deleted_at, $2),
					updated_at = now()
				WHERE (
						source_id = $1
						OR (
							artifact_type = 'conflict_node'
							AND subject_id IN (
								SELECT ca.conflict_id
								FROM conflict_assertions ca
								WHERE ca.source_document_id = $1
							)
						)
						OR (
							artifact_type = 'conflict_resolution'
							AND subject_id IN (
								SELECT cr.id
								FROM conflict_resolutions cr
								JOIN conflict_assertions ca ON ca.conflict_id = cr.conflict_id
								WHERE ca.source_document_id = $1
							)
						)
					)
					AND deleted_at IS NULL
			`,
			[sourceId, deletedAt ?? new Date()],
		);
		return result.rowCount ?? 0;
	} catch (cause: unknown) {
		throw new DatabaseError('Failed to soft-delete source review artifacts', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause,
			context: { sourceId },
		});
	}
}

export async function restoreReviewArtifactsForSource(
	pool: Queryable,
	sourceId: string,
	deletedAt: Date,
): Promise<number> {
	try {
		const result = await pool.query(
			`
				UPDATE review_artifacts
				SET deleted_at = NULL,
					updated_at = now()
				WHERE (
						source_id = $1
						OR (
							artifact_type = 'conflict_node'
							AND subject_id IN (
								SELECT ca.conflict_id
								FROM conflict_assertions ca
								WHERE ca.source_document_id = $1
							)
						)
						OR (
							artifact_type = 'conflict_resolution'
							AND subject_id IN (
								SELECT cr.id
								FROM conflict_resolutions cr
								JOIN conflict_assertions ca ON ca.conflict_id = cr.conflict_id
								WHERE ca.source_document_id = $1
							)
						)
					)
					AND deleted_at = $2
			`,
			[sourceId, deletedAt],
		);
		return result.rowCount ?? 0;
	} catch (cause: unknown) {
		throw new DatabaseError('Failed to restore source review artifacts', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause,
			context: { sourceId },
		});
	}
}

export async function softDeleteReviewArtifactsForPipelineReset(
	pool: Queryable,
	sourceId: string,
	step: PipelineReviewResetStep,
	deletedAt?: Date,
): Promise<number> {
	try {
		const result = await pool.query<{ deleted_count: number }>(
			'SELECT mark_review_artifacts_for_pipeline_reset_deleted($1, $2, $3) AS deleted_count',
			[sourceId, step, deletedAt ?? new Date()],
		);
		return result.rows[0]?.deleted_count ?? 0;
	} catch (cause: unknown) {
		throw new DatabaseError('Failed to soft-delete reset review artifacts', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause,
			context: { sourceId, step },
		});
	}
}

export async function purgeReviewArtifactsForSource(pool: Queryable, sourceId: string): Promise<number> {
	try {
		const result = await pool.query(
			`
				DELETE FROM review_artifacts
				WHERE source_id = $1
					OR (
						artifact_type = 'conflict_node'
						AND subject_id IN (
							SELECT ca.conflict_id
							FROM conflict_assertions ca
							WHERE ca.source_document_id = $1
						)
					)
					OR (
						artifact_type = 'conflict_resolution'
						AND subject_id IN (
							SELECT cr.id
							FROM conflict_resolutions cr
							JOIN conflict_assertions ca ON ca.conflict_id = cr.conflict_id
							WHERE ca.source_document_id = $1
						)
					)
			`,
			[sourceId],
		);
		return result.rowCount ?? 0;
	} catch (cause: unknown) {
		throw new DatabaseError('Failed to purge source review artifacts', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause,
			context: { sourceId },
		});
	}
}
