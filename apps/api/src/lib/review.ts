import {
	findReviewableArtifactById,
	listReviewEvents,
	listReviewQueueArtifacts,
	listReviewQueues,
	MulderError,
	type ReviewableArtifact,
	type ReviewEvent,
	type ReviewQueue,
	recordReviewEvent,
} from '@mulder/core';
import type { AuthPrincipal } from '../middleware/auth.js';
import type {
	ReviewActionRequest,
	ReviewActionResponse,
	ReviewArtifactDetailResponse,
	ReviewArtifactListResponse,
	ReviewArtifactResponse,
	ReviewEventListResponse,
	ReviewEventResponse,
	ReviewEventsQuery,
	ReviewListQuery,
	ReviewQueueListResponse,
	ReviewQueueResponse,
} from '../routes/review.schemas.js';
import {
	actorIdForPrincipal,
	allowedSensitivity,
	resolveApiDataContext,
	resolvePermissionMaxSensitivity,
	resolveReadMaxSensitivity,
	toIsoString,
} from './api-runtime.js';

interface ReviewRouteOptions {
	authPrincipal?: AuthPrincipal;
}

const REVIEW_QUEUE_NOT_FOUND_CODE = 'REVIEW_QUEUE_NOT_FOUND';
const REVIEW_ARTIFACT_NOT_FOUND_CODE = 'REVIEW_ARTIFACT_NOT_FOUND';

function mapQueue(queue: ReviewQueue): ReviewQueueResponse {
	return {
		queue_key: queue.queueKey,
		name: queue.name,
		artifact_types: queue.artifactTypes,
		assignees: queue.assignees,
		priority_rules: queue.priorityRules,
		active: queue.active,
		pending_count: queue.pendingCount,
		oldest_pending: toIsoString(queue.oldestPending),
		created_at: queue.createdAt.toISOString(),
		updated_at: queue.updatedAt.toISOString(),
	};
}

function mapArtifact(artifact: ReviewableArtifact): ReviewArtifactResponse {
	return {
		artifact_id: artifact.artifactId,
		artifact_type: artifact.artifactType,
		subject_id: artifact.subjectId,
		subject_table: artifact.subjectTable,
		created_by: artifact.createdBy,
		review_status: artifact.reviewStatus,
		current_value: artifact.currentValue,
		context: artifact.context,
		source_id: artifact.sourceId,
		priority: artifact.priority,
		due_at: toIsoString(artifact.dueAt),
		created_at: artifact.createdAt.toISOString(),
		updated_at: artifact.updatedAt.toISOString(),
	};
}

function mapEvent(event: ReviewEvent): ReviewEventResponse {
	return {
		event_id: event.eventId,
		artifact_id: event.artifactId,
		reviewer_id: event.reviewerId,
		action: event.action,
		previous_value: event.previousValue,
		new_value: event.newValue,
		confidence: event.confidence,
		rationale: event.rationale,
		tags: event.tags,
		created_at: event.createdAt.toISOString(),
	};
}

async function countQueueArtifacts(
	queueKey: string,
	query: ReviewListQuery,
	maxSensitivityLevel?: ReturnType<typeof resolveReadMaxSensitivity>,
): Promise<number> {
	const { pool } = resolveApiDataContext('review');
	const queue = await pool.query<{ artifact_types: string[] | null; active: boolean }>(
		'SELECT artifact_types, active FROM review_queues WHERE queue_key = $1',
		[queueKey],
	);
	const row = queue.rows[0];
	if (!row?.active || !row.artifact_types) {
		throw new MulderError(`Review queue not found: ${queueKey}`, REVIEW_QUEUE_NOT_FOUND_CODE, {
			context: { queueKey },
		});
	}
	const reviewStatus = query.review_status ?? (queueKey === 'contested_artifacts' ? 'contested' : 'pending');
	const params: unknown[] = [row.artifact_types, reviewStatus];
	const filters = ['artifact_type = ANY($1::text[])', 'review_status = $2', 'deleted_at IS NULL'];
	const allowed = allowedSensitivity(maxSensitivityLevel);
	if (allowed) {
		params.push(allowed);
		filters.push(`COALESCE(NULLIF(context->>'sensitivity_level', ''), 'internal') = ANY($${params.length})`);
	}
	const result = await pool.query<{ count: string }>(
		`SELECT COUNT(*) AS count FROM review_artifacts WHERE ${filters.join(' AND ')}`,
		params,
	);
	return Number.parseInt(result.rows[0]?.count ?? '0', 10) || 0;
}

async function countReviewEvents(
	artifactId: string,
	maxSensitivityLevel?: ReturnType<typeof resolveReadMaxSensitivity>,
): Promise<number> {
	const { pool } = resolveApiDataContext('review');
	const params: unknown[] = [artifactId];
	const filters = ['re.artifact_id = $1', 'ra.deleted_at IS NULL'];
	const allowed = allowedSensitivity(maxSensitivityLevel);
	if (allowed) {
		params.push(allowed);
		filters.push(`COALESCE(NULLIF(ra.context->>'sensitivity_level', ''), 'internal') = ANY($${params.length})`);
	}
	const result = await pool.query<{ count: string }>(
		`
			SELECT COUNT(*) AS count
			FROM review_events re
			JOIN review_artifacts ra ON ra.artifact_id = re.artifact_id
			WHERE ${filters.join(' AND ')}
		`,
		params,
	);
	return Number.parseInt(result.rows[0]?.count ?? '0', 10) || 0;
}

function reviewArtifactNotFound(artifactId: string): MulderError {
	return new MulderError(`Review artifact not found: ${artifactId}`, REVIEW_ARTIFACT_NOT_FOUND_CODE, {
		context: { artifactId },
	});
}

async function requireVisibleReviewArtifact(
	pool: Parameters<typeof findReviewableArtifactById>[0],
	artifactId: string,
	maxSensitivityLevel: ReturnType<typeof resolveReadMaxSensitivity>,
): Promise<ReviewableArtifact> {
	const artifact = await findReviewableArtifactById(pool, artifactId, { maxSensitivityLevel });
	if (!artifact) {
		throw reviewArtifactNotFound(artifactId);
	}
	return artifact;
}

export async function listReviewQueueSummaries(options?: ReviewRouteOptions): Promise<ReviewQueueListResponse> {
	const { config, pool } = resolveApiDataContext('review');
	const maxSensitivityLevel = resolveReadMaxSensitivity(config, options?.authPrincipal, 'review queues');
	const queues = await listReviewQueues(pool, { activeOnly: true, maxSensitivityLevel });
	return { data: queues.map(mapQueue) };
}

export async function listReviewArtifactsForQueue(
	queueKey: string,
	query: ReviewListQuery,
	options?: ReviewRouteOptions,
): Promise<ReviewArtifactListResponse> {
	const { config, pool } = resolveApiDataContext('review');
	const maxSensitivityLevel = resolveReadMaxSensitivity(config, options?.authPrincipal, 'review artifacts');
	const [count, artifacts] = await Promise.all([
		countQueueArtifacts(queueKey, query, maxSensitivityLevel),
		listReviewQueueArtifacts(pool, queueKey, {
			reviewStatus: query.review_status,
			maxSensitivityLevel,
			limit: query.limit,
			offset: query.offset,
		}),
	]);
	return {
		data: artifacts.map(mapArtifact),
		meta: { count, limit: query.limit, offset: query.offset },
	};
}

export async function getReviewArtifact(
	artifactId: string,
	options?: ReviewRouteOptions,
): Promise<ReviewArtifactDetailResponse> {
	const { config, pool } = resolveApiDataContext('review');
	const maxSensitivityLevel = resolveReadMaxSensitivity(config, options?.authPrincipal, 'review artifacts');
	const artifact = await requireVisibleReviewArtifact(pool, artifactId, maxSensitivityLevel);
	return { data: mapArtifact(artifact) };
}

export async function listReviewArtifactEvents(
	artifactId: string,
	query: ReviewEventsQuery,
	options?: ReviewRouteOptions,
): Promise<ReviewEventListResponse> {
	const { config, pool } = resolveApiDataContext('review');
	const maxSensitivityLevel = resolveReadMaxSensitivity(config, options?.authPrincipal, 'review events');
	await requireVisibleReviewArtifact(pool, artifactId, maxSensitivityLevel);
	const [count, events] = await Promise.all([
		countReviewEvents(artifactId, maxSensitivityLevel),
		listReviewEvents(pool, artifactId, { maxSensitivityLevel, limit: query.limit, offset: query.offset }),
	]);
	return {
		data: events.map(mapEvent),
		meta: { count, limit: query.limit, offset: query.offset },
	};
}

export async function recordReviewAction(
	artifactId: string,
	input: ReviewActionRequest,
	options?: ReviewRouteOptions,
): Promise<ReviewActionResponse> {
	const { config, pool } = resolveApiDataContext('review');
	const maxSensitivityLevel = resolvePermissionMaxSensitivity(
		config,
		options?.authPrincipal,
		'review artifacts',
		'review',
	);
	await requireVisibleReviewArtifact(pool, artifactId, maxSensitivityLevel);
	const result = await recordReviewEvent(pool, {
		artifactId,
		reviewerId: actorIdForPrincipal(options?.authPrincipal),
		action: input.action,
		newValue: input.new_value,
		confidence: input.confidence,
		rationale: input.rationale,
		tags: input.tags,
		maxSensitivityLevel,
	});
	return {
		data: {
			artifact: mapArtifact(result.artifact),
			event: mapEvent(result.event),
		},
	};
}
