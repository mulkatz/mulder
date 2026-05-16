import {
	createChildLogger,
	createLogger,
	DATABASE_ERROR_CODES,
	DatabaseError,
	getQueryPool,
	type Logger,
	loadConfig,
	type MulderConfig,
	planSourcePurge,
	purgeSource,
	restoreSource,
	type SourceDeletion,
	type SourcePurgeEffects,
	type SourcePurgePlan,
	type SourcePurgeReport,
	softDeleteSource,
} from '@mulder/core';
import type pg from 'pg';
import type { AuthPrincipal } from '../middleware/auth.js';
import type { DocumentActionResponse } from '../routes/documents.schemas.js';
import { actorIdForPrincipal, assertOperatorPrincipal } from './api-runtime.js';

interface DocumentActionContext {
	config: MulderConfig;
	pool: pg.Pool;
}

interface RouteAccessOptions {
	authPrincipal?: AuthPrincipal;
}

let cachedContext: DocumentActionContext | null = null;
let cachedConfigPath: string | null = null;

function resolveConfigPath(): string {
	return process.env.MULDER_CONFIG ?? 'mulder.config.yaml';
}

function resolveContext(): DocumentActionContext {
	const configPath = resolveConfigPath();
	if (cachedContext && cachedConfigPath === configPath) {
		return cachedContext;
	}

	const config = loadConfig(configPath);
	if (!config.gcp?.cloud_sql) {
		throw new DatabaseError(
			'GCP cloud_sql configuration is required for document action routes',
			DATABASE_ERROR_CODES.DB_CONNECTION_FAILED,
			{ context: { configPath } },
		);
	}

	cachedContext = {
		config,
		pool: getQueryPool(config.gcp.cloud_sql),
	};
	cachedConfigPath = configPath;

	return cachedContext;
}

function createRouteLogger(rootLogger: Logger, metadata: Record<string, string | number | boolean | null | undefined>) {
	return createChildLogger(rootLogger, {
		module: 'api',
		route: 'document-actions',
		...metadata,
	});
}

function toNullableIsoString(value: Date | null): string | null {
	return value ? value.toISOString() : null;
}

function mapSourceDeletion(deletion: SourceDeletion) {
	return {
		id: deletion.id,
		source_id: deletion.sourceId,
		deleted_by: deletion.deletedBy,
		deleted_at: deletion.deletedAt.toISOString(),
		reason: deletion.reason,
		status: deletion.status,
		undo_deadline: deletion.undoDeadline.toISOString(),
		restored_at: toNullableIsoString(deletion.restoredAt),
		purged_at: toNullableIsoString(deletion.purgedAt),
		created_at: deletion.createdAt.toISOString(),
		updated_at: deletion.updatedAt.toISOString(),
	};
}

function mapPurgePlan(plan: SourcePurgePlan) {
	return {
		source_id: plan.sourceId,
		deletion: plan.deletion ? mapSourceDeletion(plan.deletion) : null,
		counts: plan.counts,
		total_exclusive: plan.totalExclusive,
		total_shared: plan.totalShared,
		can_purge: plan.canPurge,
	};
}

function mapPurgeEffects(effects: SourcePurgeEffects): Record<string, number> {
	return Object.fromEntries(Object.entries(effects).map(([key, value]) => [key, value]));
}

function assertCanManageDocument(options?: RouteAccessOptions): void {
	assertOperatorPrincipal(options?.authPrincipal, 'document actions');
}

export async function deleteDocument(
	id: string,
	input: { reason: string },
	logger?: Logger,
	options?: RouteAccessOptions,
): Promise<DocumentActionResponse> {
	assertCanManageDocument(options);
	const rootLogger = logger ?? createLogger();
	const requestLogger = createRouteLogger(rootLogger, { action: 'soft_delete', source_id: id });
	const { config, pool } = resolveContext();
	const deletion = await softDeleteSource(pool, {
		sourceId: id,
		actor: actorIdForPrincipal(options?.authPrincipal),
		reason: input.reason,
		undoWindowHours: config.source_rollback.undo_window_hours,
	});
	requestLogger.info({ deletion_id: deletion.id }, 'document soft-deleted');
	return {
		data: {
			source_id: id,
			action: 'soft_deleted',
			deletion: mapSourceDeletion(deletion),
		},
	};
}

export async function restoreDocument(
	id: string,
	logger?: Logger,
	options?: RouteAccessOptions,
): Promise<DocumentActionResponse> {
	assertCanManageDocument(options);
	const rootLogger = logger ?? createLogger();
	const requestLogger = createRouteLogger(rootLogger, { action: 'restore', source_id: id });
	const { pool } = resolveContext();
	const deletion = await restoreSource(pool, {
		sourceId: id,
		actor: actorIdForPrincipal(options?.authPrincipal),
	});
	requestLogger.info({ deletion_id: deletion.id }, 'document restored');
	return {
		data: {
			source_id: id,
			action: 'restored',
			deletion: mapSourceDeletion(deletion),
		},
	};
}

export async function getDocumentPurgePlan(
	id: string,
	logger?: Logger,
	options?: RouteAccessOptions,
): Promise<DocumentActionResponse> {
	assertCanManageDocument(options);
	const rootLogger = logger ?? createLogger();
	const requestLogger = createRouteLogger(rootLogger, { action: 'purge_plan', source_id: id });
	const { pool } = resolveContext();
	const plan = await planSourcePurge(pool, id);
	requestLogger.info(
		{ can_purge: plan.canPurge, total_exclusive: plan.totalExclusive, total_shared: plan.totalShared },
		'document purge plan generated',
	);
	return {
		data: {
			source_id: id,
			action: 'purge_plan',
			plan: mapPurgePlan(plan),
		},
	};
}

export async function purgeDocument(
	id: string,
	input: { reason: string; confirm: boolean },
	logger?: Logger,
	options?: RouteAccessOptions,
): Promise<DocumentActionResponse> {
	assertCanManageDocument(options);
	const rootLogger = logger ?? createLogger();
	const requestLogger = createRouteLogger(rootLogger, { action: 'purge', source_id: id });
	const { config, pool } = resolveContext();
	const report: SourcePurgeReport = await purgeSource(pool, {
		sourceId: id,
		actor: actorIdForPrincipal(options?.authPrincipal),
		reason: input.reason,
		confirmed: input.confirm,
		orphanHandling: config.source_rollback.orphan_handling,
	});
	requestLogger.info({ effects: report.effects }, 'document purged');
	return {
		data: {
			source_id: id,
			action: 'purged',
			plan: mapPurgePlan(report.plan),
			effects: mapPurgeEffects(report.effects),
			purged_at: report.purgedAt.toISOString(),
		},
	};
}
