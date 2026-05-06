import type pg from 'pg';
import { DATABASE_ERROR_CODES, DatabaseError } from '../../shared/errors.js';
import type {
	AuditLogEvent,
	PurgeSourceInput,
	RestoreSourceInput,
	SoftDeleteSourceInput,
	SourceDeletion,
	SourcePurgeEffects,
	SourcePurgePlan,
	SourcePurgeReport,
	SourcePurgeSubsystemCount,
} from './source-rollback.types.js';

type Queryable = pg.Pool | pg.PoolClient;

interface SourceDeletionRow {
	id: string;
	source_id: string;
	deleted_by: string;
	deleted_at: Date;
	reason: string;
	status: SourceDeletion['status'];
	undo_deadline: Date;
	restored_at: Date | null;
	purged_at: Date | null;
	created_at: Date;
	updated_at: Date;
}

interface AuditLogRow {
	id: string;
	event_type: string;
	artifact_type: string;
	artifact_id: string | null;
	source_id: string | null;
	actor: string;
	reason: string | null;
	metadata: Record<string, unknown> | null;
	created_at: Date;
}

interface SourceRollbackSourceRow {
	id: string;
	file_hash: string;
	deletion_status: string;
	deleted_at: Date | null;
}

function mapSourceDeletionRow(row: SourceDeletionRow): SourceDeletion {
	return {
		id: row.id,
		sourceId: row.source_id,
		deletedBy: row.deleted_by,
		deletedAt: row.deleted_at,
		reason: row.reason,
		status: row.status,
		undoDeadline: row.undo_deadline,
		restoredAt: row.restored_at,
		purgedAt: row.purged_at,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function mapAuditLogRow(row: AuditLogRow): AuditLogEvent {
	return {
		id: row.id,
		eventType: row.event_type,
		artifactType: row.artifact_type,
		artifactId: row.artifact_id,
		sourceId: row.source_id,
		actor: row.actor,
		reason: row.reason,
		metadata: row.metadata ?? {},
		createdAt: row.created_at,
	};
}

function assertReason(reason: string, operation: string): string {
	const trimmed = reason.trim();
	if (trimmed.length === 0) {
		throw new DatabaseError(`${operation} reason is required`, DATABASE_ERROR_CODES.DB_QUERY_FAILED);
	}
	return trimmed;
}

function assertActor(actor: string): string {
	const trimmed = actor.trim();
	if (trimmed.length === 0) {
		throw new DatabaseError('Rollback actor is required', DATABASE_ERROR_CODES.DB_QUERY_FAILED);
	}
	return trimmed;
}

function removeSourceFromProvenanceSql(tableAlias: string): string {
	return `
		jsonb_set(
			${tableAlias}.provenance,
			'{source_document_ids}',
			(
				SELECT COALESCE(jsonb_agg(source_id ORDER BY source_id), '[]'::jsonb)
				FROM jsonb_array_elements_text(COALESCE(${tableAlias}.provenance->'source_document_ids', '[]'::jsonb)) AS provenance_ids(source_id)
				WHERE provenance_ids.source_id <> $1
			),
			true
		)
	`;
}

async function insertAuditEvent(
	pool: Queryable,
	input: {
		eventType: string;
		artifactType: string;
		artifactId?: string | null;
		sourceId?: string | null;
		actor: string;
		reason?: string | null;
		metadata?: Record<string, unknown>;
	},
): Promise<AuditLogEvent> {
	const sql = `
		INSERT INTO audit_log (event_type, artifact_type, artifact_id, source_id, actor, reason, metadata)
		VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
		RETURNING *
	`;
	const result = await pool.query<AuditLogRow>(sql, [
		input.eventType,
		input.artifactType,
		input.artifactId ?? null,
		input.sourceId ?? null,
		input.actor,
		input.reason ?? null,
		JSON.stringify(input.metadata ?? {}),
	]);
	return mapAuditLogRow(result.rows[0]);
}

async function requireSource(pool: Queryable, sourceId: string): Promise<SourceRollbackSourceRow> {
	const result = await pool.query<SourceRollbackSourceRow>(
		'SELECT id, file_hash, deletion_status, deleted_at FROM sources WHERE id = $1 FOR UPDATE',
		[sourceId],
	);
	const row = result.rows[0];
	if (!row) {
		throw new DatabaseError(`Source not found: ${sourceId}`, DATABASE_ERROR_CODES.DB_NOT_FOUND, {
			context: { sourceId },
		});
	}
	return row;
}

async function countRows(pool: Queryable, sql: string, params: unknown[]): Promise<number> {
	const result = await pool.query<{ count: string }>(sql, params);
	return Number.parseInt(result.rows[0]?.count ?? '0', 10);
}

async function countExclusiveAndShared(
	pool: Queryable,
	subsystem: string,
	sourceId: string,
	exclusiveSql: string,
	sharedSql = 'SELECT 0::text AS count',
): Promise<SourcePurgeSubsystemCount> {
	const exclusive = await countRows(pool, exclusiveSql, [sourceId]);
	const shared = await countRows(pool, sharedSql, [sourceId]);
	return { subsystem, exclusive, shared, total: exclusive + shared };
}

export async function softDeleteSource(pool: pg.Pool, input: SoftDeleteSourceInput): Promise<SourceDeletion> {
	const actor = assertActor(input.actor);
	const reason = assertReason(input.reason, 'Source rollback');
	const deletedAt = input.deletedAt ?? new Date();
	const undoWindowHours = input.undoWindowHours ?? 72;
	const undoDeadline = new Date(deletedAt.getTime() + undoWindowHours * 60 * 60 * 1000);
	const client = await pool.connect();

	try {
		await client.query('BEGIN');
		const source = await requireSource(client, input.sourceId);
		if (source.deletion_status === 'soft_deleted') {
			throw new DatabaseError('Source is already soft-deleted', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
				context: { sourceId: input.sourceId },
			});
		}
		if (source.deletion_status === 'purged' || source.deletion_status === 'purging') {
			throw new DatabaseError(
				`Source cannot be soft-deleted from ${source.deletion_status}`,
				DATABASE_ERROR_CODES.DB_QUERY_FAILED,
				{
					context: { sourceId: input.sourceId, deletionStatus: source.deletion_status },
				},
			);
		}

		await client.query(
			`
				UPDATE sources
				SET deletion_status = 'soft_deleted', deleted_at = $2, updated_at = now()
				WHERE id = $1
			`,
			[input.sourceId, deletedAt],
		);

		const deletionResult = await client.query<SourceDeletionRow>(
			`
				INSERT INTO source_deletions (source_id, deleted_by, deleted_at, reason, status, undo_deadline)
				VALUES ($1, $2, $3, $4, 'soft_deleted', $5)
				RETURNING *
			`,
			[input.sourceId, actor, deletedAt, reason, undoDeadline],
		);
		const deletion = mapSourceDeletionRow(deletionResult.rows[0]);
		await insertAuditEvent(client, {
			eventType: 'source.rollback.soft_deleted',
			artifactType: 'source',
			artifactId: input.sourceId,
			sourceId: input.sourceId,
			actor,
			reason,
			metadata: { undo_deadline: undoDeadline.toISOString(), deletion_id: deletion.id },
		});
		await client.query('COMMIT');
		return deletion;
	} catch (error: unknown) {
		await client.query('ROLLBACK').catch(() => {});
		if (error instanceof DatabaseError) {
			throw error;
		}
		throw new DatabaseError('Failed to soft-delete source', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { sourceId: input.sourceId },
		});
	} finally {
		client.release();
	}
}

export async function restoreSource(pool: pg.Pool, input: RestoreSourceInput): Promise<SourceDeletion> {
	const actor = assertActor(input.actor);
	const restoredAt = input.restoredAt ?? new Date();
	const client = await pool.connect();

	try {
		await client.query('BEGIN');
		await requireSource(client, input.sourceId);
		const deletionResult = await client.query<SourceDeletionRow>(
			`
				UPDATE source_deletions
				SET status = 'restored', restored_at = $2, updated_at = now()
				WHERE id = (
					SELECT id
					FROM source_deletions
					WHERE source_id = $1 AND status = 'soft_deleted' AND undo_deadline >= $2
					ORDER BY deleted_at DESC
					LIMIT 1
					FOR UPDATE
				)
				RETURNING *
			`,
			[input.sourceId, restoredAt],
		);
		const deletionRow = deletionResult.rows[0];
		if (!deletionRow) {
			throw new DatabaseError(
				`No restorable soft deletion for source: ${input.sourceId}`,
				DATABASE_ERROR_CODES.DB_NOT_FOUND,
				{
					context: { sourceId: input.sourceId },
				},
			);
		}
		await client.query(
			`
				UPDATE sources
				SET deletion_status = 'restored', deleted_at = NULL, updated_at = now()
				WHERE id = $1
			`,
			[input.sourceId],
		);
		const deletion = mapSourceDeletionRow(deletionRow);
		await insertAuditEvent(client, {
			eventType: 'source.rollback.restored',
			artifactType: 'source',
			artifactId: input.sourceId,
			sourceId: input.sourceId,
			actor,
			reason: input.reason ?? null,
			metadata: { deletion_id: deletion.id, restored_at: restoredAt.toISOString() },
		});
		await client.query('COMMIT');
		return deletion;
	} catch (error: unknown) {
		await client.query('ROLLBACK').catch(() => {});
		if (error instanceof DatabaseError) {
			throw error;
		}
		throw new DatabaseError('Failed to restore source', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { sourceId: input.sourceId },
		});
	} finally {
		client.release();
	}
}

export async function findSourceDeletionForSource(pool: Queryable, sourceId: string): Promise<SourceDeletion | null> {
	const result = await pool.query<SourceDeletionRow>(
		`
			SELECT *
			FROM source_deletions
			WHERE source_id = $1
			ORDER BY created_at DESC
			LIMIT 1
		`,
		[sourceId],
	);
	const row = result.rows[0];
	return row ? mapSourceDeletionRow(row) : null;
}

export async function listSourceDeletions(
	pool: Queryable,
	options?: { status?: SourceDeletion['status']; limit?: number; offset?: number },
): Promise<SourceDeletion[]> {
	const params: unknown[] = [];
	const conditions: string[] = [];
	let paramIndex = 1;
	if (options?.status) {
		conditions.push(`status = $${paramIndex}`);
		params.push(options.status);
		paramIndex++;
	}
	const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
	const limit = options?.limit ?? 100;
	const offset = options?.offset ?? 0;
	const result = await pool.query<SourceDeletionRow>(
		`
			SELECT *
			FROM source_deletions
			${whereClause}
			ORDER BY created_at DESC
			LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
		`,
		[...params, limit, offset],
	);
	return result.rows.map(mapSourceDeletionRow);
}

export async function listAuditEventsForSource(
	pool: Queryable,
	sourceId: string,
	options?: { limit?: number; offset?: number },
): Promise<AuditLogEvent[]> {
	const limit = options?.limit ?? 100;
	const offset = options?.offset ?? 0;
	const result = await pool.query<AuditLogRow>(
		`
			SELECT *
			FROM audit_log
			WHERE source_id = $1
			ORDER BY created_at DESC
			LIMIT $2 OFFSET $3
		`,
		[sourceId, limit, offset],
	);
	return result.rows.map(mapAuditLogRow);
}

export async function planSourcePurge(pool: Queryable, sourceId: string): Promise<SourcePurgePlan> {
	const deletion = await findSourceDeletionForSource(pool, sourceId);
	const counts = [
		await countExclusiveAndShared(
			pool,
			'source_steps',
			sourceId,
			'SELECT COUNT(*) AS count FROM source_steps WHERE source_id = $1',
		),
		await countExclusiveAndShared(
			pool,
			'pipeline_run_sources',
			sourceId,
			'SELECT COUNT(*) AS count FROM pipeline_run_sources WHERE source_id = $1',
		),
		await countExclusiveAndShared(
			pool,
			'document_quality_assessments',
			sourceId,
			'SELECT COUNT(*) AS count FROM document_quality_assessments WHERE source_id = $1',
		),
		await countExclusiveAndShared(
			pool,
			'url_lifecycle',
			sourceId,
			'SELECT COUNT(*) AS count FROM url_lifecycle WHERE source_id = $1',
		),
		await countExclusiveAndShared(
			pool,
			'stories',
			sourceId,
			'SELECT COUNT(*) AS count FROM stories WHERE source_id = $1',
		),
		await countExclusiveAndShared(
			pool,
			'chunks',
			sourceId,
			`
				SELECT COUNT(*) AS count
				FROM chunks c
				JOIN stories s ON s.id = c.story_id
				WHERE s.source_id = $1
					OR (c.provenance->'source_document_ids' ? $1 AND jsonb_array_length(c.provenance->'source_document_ids') = 1)
			`,
			`
				SELECT COUNT(*) AS count
				FROM chunks c
				JOIN stories s ON s.id = c.story_id
				WHERE s.source_id <> $1
					AND c.provenance->'source_document_ids' ? $1
					AND jsonb_array_length(c.provenance->'source_document_ids') > 1
			`,
		),
		await countExclusiveAndShared(
			pool,
			'story_entities',
			sourceId,
			`
				SELECT COUNT(*) AS count
				FROM story_entities se
				JOIN stories s ON s.id = se.story_id
				WHERE s.source_id = $1
					OR (se.provenance->'source_document_ids' ? $1 AND jsonb_array_length(se.provenance->'source_document_ids') = 1)
			`,
			`
				SELECT COUNT(*) AS count
				FROM story_entities se
				JOIN stories s ON s.id = se.story_id
				WHERE s.source_id <> $1
					AND se.provenance->'source_document_ids' ? $1
					AND jsonb_array_length(se.provenance->'source_document_ids') > 1
			`,
		),
		await countExclusiveAndShared(
			pool,
			'entity_edges',
			sourceId,
			`
				SELECT COUNT(*) AS count
				FROM entity_edges ee
				LEFT JOIN stories s ON s.id = ee.story_id
				WHERE s.source_id = $1
					OR (ee.provenance->'source_document_ids' ? $1 AND jsonb_array_length(ee.provenance->'source_document_ids') = 1)
			`,
			`
				SELECT COUNT(*) AS count
				FROM entity_edges ee
				LEFT JOIN stories s ON s.id = ee.story_id
				WHERE (s.source_id IS NULL OR s.source_id <> $1)
					AND ee.provenance->'source_document_ids' ? $1
					AND jsonb_array_length(ee.provenance->'source_document_ids') > 1
			`,
		),
		await countExclusiveAndShared(
			pool,
			'knowledge_assertions',
			sourceId,
			`
				SELECT COUNT(*) AS count
				FROM knowledge_assertions ka
				LEFT JOIN stories s ON s.id = ka.story_id
				WHERE ka.deleted_at IS NULL
					AND (
						ka.source_id = $1
						OR s.source_id = $1
						OR (ka.provenance->'source_document_ids' ? $1 AND jsonb_array_length(ka.provenance->'source_document_ids') = 1)
					)
			`,
			`
				SELECT COUNT(*) AS count
				FROM knowledge_assertions ka
				LEFT JOIN stories s ON s.id = ka.story_id
				WHERE ka.deleted_at IS NULL
					AND ka.source_id <> $1
					AND (s.source_id IS NULL OR s.source_id <> $1)
					AND ka.provenance->'source_document_ids' ? $1
					AND jsonb_array_length(ka.provenance->'source_document_ids') > 1
			`,
		),
		await countExclusiveAndShared(
			pool,
			'entities',
			sourceId,
			`
				SELECT COUNT(*) AS count
				FROM entities
				WHERE provenance->'source_document_ids' ? $1
					AND jsonb_array_length(provenance->'source_document_ids') = 1
			`,
			`
				SELECT COUNT(*) AS count
				FROM entities
				WHERE provenance->'source_document_ids' ? $1
					AND jsonb_array_length(provenance->'source_document_ids') > 1
			`,
		),
		await countExclusiveAndShared(
			pool,
			'entity_aliases',
			sourceId,
			`
				SELECT COUNT(*) AS count
				FROM entity_aliases
				WHERE provenance->'source_document_ids' ? $1
					AND jsonb_array_length(provenance->'source_document_ids') = 1
			`,
			`
				SELECT COUNT(*) AS count
				FROM entity_aliases
				WHERE provenance->'source_document_ids' ? $1
					AND jsonb_array_length(provenance->'source_document_ids') > 1
			`,
		),
		await countExclusiveAndShared(
			pool,
			'document_blobs',
			sourceId,
			`
				SELECT COUNT(*) AS count
				FROM sources s
				JOIN document_blobs db ON db.content_hash = s.file_hash
				WHERE s.id = $1
					AND NOT EXISTS (
						SELECT 1
						FROM sources other
						WHERE other.file_hash = s.file_hash
							AND other.id <> s.id
							AND other.active_source
					)
			`,
			`
				SELECT COUNT(*) AS count
				FROM sources s
				JOIN document_blobs db ON db.content_hash = s.file_hash
				WHERE s.id = $1
					AND EXISTS (
						SELECT 1
						FROM sources other
						WHERE other.file_hash = s.file_hash
							AND other.id <> s.id
							AND other.active_source
					)
			`,
		),
	];
	const totalExclusive = counts.reduce((total, count) => total + count.exclusive, 0);
	const totalShared = counts.reduce((total, count) => total + count.shared, 0);
	return {
		sourceId,
		deletion,
		counts,
		totalExclusive,
		totalShared,
		canPurge: deletion?.status === 'soft_deleted' || deletion?.status === 'purging',
	};
}

async function updateSharedProvenance(
	client: pg.PoolClient,
	sourceId: string,
	tableName: string,
	alias: string,
): Promise<number> {
	const sql = `
		UPDATE ${tableName} ${alias}
		SET provenance = ${removeSourceFromProvenanceSql(alias)}
		WHERE ${alias}.provenance->'source_document_ids' ? $1
			AND jsonb_array_length(${alias}.provenance->'source_document_ids') > 1
	`;
	const result = await client.query(sql, [sourceId]);
	return result.rowCount ?? 0;
}

export async function purgeSource(pool: pg.Pool, input: PurgeSourceInput): Promise<SourcePurgeReport> {
	const actor = assertActor(input.actor);
	const reason = assertReason(input.reason, 'Source purge');
	if (!input.confirmed) {
		throw new DatabaseError('Source purge confirmation is required', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			context: { sourceId: input.sourceId },
		});
	}
	const purgedAt = input.purgedAt ?? new Date();
	const orphanHandling = input.orphanHandling ?? 'mark';
	const client = await pool.connect();

	try {
		await client.query('BEGIN');
		const source = await requireSource(client, input.sourceId);
		const deletionResult = await client.query<SourceDeletionRow>(
			`
				UPDATE source_deletions
				SET status = 'purging', updated_at = now()
				WHERE id = (
					SELECT id
					FROM source_deletions
					WHERE source_id = $1 AND status IN ('soft_deleted', 'purging')
					ORDER BY deleted_at DESC
					LIMIT 1
					FOR UPDATE
				)
				RETURNING *
			`,
			[input.sourceId],
		);
		const deletionRow = deletionResult.rows[0];
		if (!deletionRow) {
			throw new DatabaseError(
				`No current soft deletion for source: ${input.sourceId}`,
				DATABASE_ERROR_CODES.DB_NOT_FOUND,
				{
					context: { sourceId: input.sourceId },
				},
			);
		}
		await client.query(
			`
				UPDATE sources
				SET deletion_status = 'purging', updated_at = now()
				WHERE id = $1
			`,
			[input.sourceId],
		);
		const plan = await planSourcePurge(client, input.sourceId);
		await insertAuditEvent(client, {
			eventType: 'source.rollback.purge_started',
			artifactType: 'source',
			artifactId: input.sourceId,
			sourceId: input.sourceId,
			actor,
			reason,
			metadata: { deletion_id: deletionRow.id, orphan_handling: orphanHandling, plan },
		});

		const effects: SourcePurgeEffects = {
			sourceStepsDeleted: 0,
			pipelineRunLinksDeleted: 0,
			documentQualityAssessmentsDeleted: 0,
			urlLifecycleRowsDeleted: 0,
			storiesDeleted: 0,
			chunksDeleted: 0,
			chunksUpdated: 0,
			storyEntitiesDeleted: 0,
			storyEntitiesUpdated: 0,
			entityEdgesDeleted: 0,
			entityEdgesUpdated: 0,
			knowledgeAssertionsSoftDeleted: 0,
			knowledgeAssertionsUpdated: 0,
			entitiesDeleted: 0,
			entitiesUpdated: 0,
			entityAliasesDeleted: 0,
			entityAliasesUpdated: 0,
			documentBlobsMovedToColdStorage: 0,
			orphanedEntitiesDeleted: 0,
		};

		await client.query(
			`
				CREATE TEMP TABLE source_purge_affected_entities (
					entity_id UUID PRIMARY KEY
				) ON COMMIT DROP
			`,
		);
		await client.query(
			`
				INSERT INTO source_purge_affected_entities(entity_id)
				SELECT DISTINCT entity_id
				FROM (
					SELECT se.entity_id
					FROM story_entities se
					JOIN stories s ON s.id = se.story_id
					WHERE s.source_id = $1 OR se.provenance->'source_document_ids' ? $1
					UNION
					SELECT ee.source_entity_id
					FROM entity_edges ee
					LEFT JOIN stories s ON s.id = ee.story_id
					WHERE s.source_id = $1 OR ee.provenance->'source_document_ids' ? $1
					UNION
					SELECT ee.target_entity_id
					FROM entity_edges ee
					LEFT JOIN stories s ON s.id = ee.story_id
					WHERE s.source_id = $1 OR ee.provenance->'source_document_ids' ? $1
					UNION
					SELECT e.id
					FROM entities e
					WHERE e.provenance->'source_document_ids' ? $1
				) affected
				ON CONFLICT (entity_id) DO NOTHING
			`,
			[input.sourceId],
		);

		effects.knowledgeAssertionsUpdated = await updateSharedProvenance(
			client,
			input.sourceId,
			'knowledge_assertions',
			'ka',
		);
		effects.chunksUpdated = await updateSharedProvenance(client, input.sourceId, 'chunks', 'c');
		effects.storyEntitiesUpdated = await updateSharedProvenance(client, input.sourceId, 'story_entities', 'se');
		effects.entityEdgesUpdated = await updateSharedProvenance(client, input.sourceId, 'entity_edges', 'ee');
		effects.entityAliasesUpdated = await updateSharedProvenance(client, input.sourceId, 'entity_aliases', 'ea');
		effects.entitiesUpdated = await updateSharedProvenance(client, input.sourceId, 'entities', 'e');

		const softDeleteAssertions = await client.query(
			`
				UPDATE knowledge_assertions ka
				SET deleted_at = COALESCE(deleted_at, $2), updated_at = now()
				WHERE deleted_at IS NULL
					AND ka.provenance->'source_document_ids' ? $1
					AND jsonb_array_length(COALESCE(ka.provenance->'source_document_ids', '[]'::jsonb)) <= 1
			`,
			[input.sourceId, purgedAt],
		);
		effects.knowledgeAssertionsSoftDeleted = softDeleteAssertions.rowCount ?? 0;

		const deleteChunks = await client.query(
			`
				DELETE FROM chunks c
				WHERE c.provenance->'source_document_ids' ? $1
					AND jsonb_array_length(COALESCE(c.provenance->'source_document_ids', '[]'::jsonb)) <= 1
			`,
			[input.sourceId],
		);
		effects.chunksDeleted = deleteChunks.rowCount ?? 0;

		const deleteStoryEntities = await client.query(
			`
				DELETE FROM story_entities se
				WHERE se.provenance->'source_document_ids' ? $1
					AND jsonb_array_length(COALESCE(se.provenance->'source_document_ids', '[]'::jsonb)) <= 1
			`,
			[input.sourceId],
		);
		effects.storyEntitiesDeleted = deleteStoryEntities.rowCount ?? 0;

		const deleteEdges = await client.query(
			`
				DELETE FROM entity_edges ee
				WHERE ee.provenance->'source_document_ids' ? $1
					AND jsonb_array_length(COALESCE(ee.provenance->'source_document_ids', '[]'::jsonb)) <= 1
			`,
			[input.sourceId],
		);
		effects.entityEdgesDeleted = deleteEdges.rowCount ?? 0;

		const deleteAliases = await client.query(
			`
				DELETE FROM entity_aliases ea
				WHERE ea.provenance->'source_document_ids' ? $1
					AND jsonb_array_length(COALESCE(ea.provenance->'source_document_ids', '[]'::jsonb)) <= 1
			`,
			[input.sourceId],
		);
		effects.entityAliasesDeleted = deleteAliases.rowCount ?? 0;

		const sourceSteps = await client.query('DELETE FROM source_steps WHERE source_id = $1', [input.sourceId]);
		effects.sourceStepsDeleted = sourceSteps.rowCount ?? 0;
		const pipelineRunLinks = await client.query('DELETE FROM pipeline_run_sources WHERE source_id = $1', [
			input.sourceId,
		]);
		effects.pipelineRunLinksDeleted = pipelineRunLinks.rowCount ?? 0;
		const quality = await client.query('DELETE FROM document_quality_assessments WHERE source_id = $1', [
			input.sourceId,
		]);
		effects.documentQualityAssessmentsDeleted = quality.rowCount ?? 0;
		const urlLifecycle = await client.query('DELETE FROM url_lifecycle WHERE source_id = $1', [input.sourceId]);
		effects.urlLifecycleRowsDeleted = urlLifecycle.rowCount ?? 0;
		const stories = await client.query('DELETE FROM stories WHERE source_id = $1', [input.sourceId]);
		effects.storiesDeleted = stories.rowCount ?? 0;

		const deleteEntities = await client.query(
			`
				DELETE FROM entities e
				WHERE e.provenance->'source_document_ids' ? $1
					AND jsonb_array_length(COALESCE(e.provenance->'source_document_ids', '[]'::jsonb)) <= 1
					AND NOT EXISTS (SELECT 1 FROM story_entities se WHERE se.entity_id = e.id)
					AND NOT EXISTS (
						SELECT 1
						FROM entity_edges ee
						WHERE ee.source_entity_id = e.id OR ee.target_entity_id = e.id
					)
			`,
			[input.sourceId],
		);
		effects.entitiesDeleted = deleteEntities.rowCount ?? 0;

		await client.query(
			`
				UPDATE entities
				SET source_count = jsonb_array_length(COALESCE(provenance->'source_document_ids', '[]'::jsonb)),
					updated_at = now()
				WHERE source_count <> jsonb_array_length(COALESCE(provenance->'source_document_ids', '[]'::jsonb))
			`,
		);

		const orphanedEntities = await client.query(
			`
				DELETE FROM entities e
				WHERE e.id IN (SELECT entity_id FROM source_purge_affected_entities)
					AND NOT EXISTS (SELECT 1 FROM story_entities se WHERE se.entity_id = e.id)
					AND NOT EXISTS (
						SELECT 1
						FROM entity_edges ee
						WHERE ee.source_entity_id = e.id OR ee.target_entity_id = e.id
					)
			`,
		);
		effects.orphanedEntitiesDeleted = orphanedEntities.rowCount ?? 0;

		const blobUpdate = await client.query(
			`
				UPDATE document_blobs db
				SET storage_status = 'cold_storage', updated_at = now()
				WHERE db.content_hash = $1
					AND NOT EXISTS (
						SELECT 1
						FROM sources other
						WHERE other.file_hash = $1
							AND other.id <> $2
							AND other.active_source
					)
			`,
			[source.file_hash, input.sourceId],
		);
		effects.documentBlobsMovedToColdStorage = blobUpdate.rowCount ?? 0;

		await client.query(
			`
				UPDATE sources
				SET deletion_status = 'purged', updated_at = now()
				WHERE id = $1
			`,
			[input.sourceId],
		);
		await client.query(
			`
				UPDATE source_deletions
				SET status = 'purged', purged_at = $2, updated_at = now()
				WHERE id = $1
			`,
			[deletionRow.id, purgedAt],
		);

		const report: SourcePurgeReport = {
			sourceId: input.sourceId,
			deletionId: deletionRow.id,
			status: 'purged',
			plan,
			effects,
			purgedAt,
		};
		await insertAuditEvent(client, {
			eventType: 'source.rollback.purge_completed',
			artifactType: 'source',
			artifactId: input.sourceId,
			sourceId: input.sourceId,
			actor,
			reason,
			metadata: { deletion_id: deletionRow.id, orphan_handling: orphanHandling, effects },
		});
		await client.query('COMMIT');
		return report;
	} catch (error: unknown) {
		await client.query('ROLLBACK').catch(() => {});
		if (error instanceof DatabaseError) {
			throw error;
		}
		throw new DatabaseError('Failed to purge source', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { sourceId: input.sourceId },
		});
	} finally {
		client.release();
	}
}
