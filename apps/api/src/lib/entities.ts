import { performance } from 'node:perf_hooks';
import {
	type Entity as CoreEntity,
	type EntityAlias as CoreEntityAlias,
	type EntityEdge as CoreEntityEdge,
	countEntities,
	createChildLogger,
	createLogger,
	DATABASE_ERROR_CODES,
	DatabaseError,
	type EntityFilter,
	findAliasesByEntityId,
	findAllEntities,
	findEdgesByEntityId,
	findEntitiesByCanonicalId,
	findEntityById,
	findStoriesByEntityId,
	getQueryPool,
	type Logger,
	loadConfig,
	type MergeEntitiesResult,
	MulderError,
	mergeEntities as mergeEntitiesRepository,
} from '@mulder/core';
import type pg from 'pg';
import type {
	EntityAliasResponse,
	EntityDetailResponse,
	EntityEdgeResponse,
	EntityEdgesResponse,
	EntityListQuery,
	EntityListResponse,
	EntityMergeResponse,
	EntityResponse,
	EntityStoryResponse,
} from '../routes/entities.schemas.js';

interface EntityContext {
	pool: pg.Pool;
}

let cachedContext: EntityContext | null = null;
let cachedConfigPath: string | null = null;

function resolveConfigPath(): string {
	return process.env.MULDER_CONFIG ?? 'mulder.config.yaml';
}

function resolveContext(): EntityContext {
	const configPath = resolveConfigPath();
	if (cachedContext && cachedConfigPath === configPath) {
		return cachedContext;
	}

	const config = loadConfig(configPath);
	if (!config.gcp?.cloud_sql) {
		throw new DatabaseError(
			'GCP cloud_sql configuration is required for entity routes',
			DATABASE_ERROR_CODES.DB_CONNECTION_FAILED,
			{
				context: {
					configPath,
				},
			},
		);
	}

	cachedContext = {
		pool: getQueryPool(config.gcp.cloud_sql),
	};
	cachedConfigPath = configPath;

	return cachedContext;
}

function mapEntity(entity: CoreEntity): EntityResponse {
	return {
		id: entity.id,
		canonical_id: entity.canonicalId,
		name: entity.name,
		type: entity.type,
		taxonomy_status: entity.taxonomyStatus,
		taxonomy_id: entity.taxonomyId,
		corroboration_score: entity.corroborationScore,
		source_count: entity.sourceCount,
		attributes: entity.attributes ?? {},
		created_at: entity.createdAt.toISOString(),
		updated_at: entity.updatedAt.toISOString(),
	};
}

function mapAlias(alias: CoreEntityAlias): EntityAliasResponse {
	return {
		id: alias.id,
		entity_id: alias.entityId,
		alias: alias.alias,
		source: alias.source,
	};
}

function mapStory(story: Awaited<ReturnType<typeof findStoriesByEntityId>>[number]): EntityStoryResponse {
	return {
		id: story.id,
		source_id: story.sourceId,
		title: story.title,
		status: story.status,
		confidence: story.confidence,
		mention_count: story.mentionCount,
	};
}

function mapEdge(edge: CoreEntityEdge): EntityEdgeResponse {
	return {
		id: edge.id,
		source_entity_id: edge.sourceEntityId,
		target_entity_id: edge.targetEntityId,
		relationship: edge.relationship,
		edge_type: edge.edgeType,
		confidence: edge.confidence,
		story_id: edge.storyId,
		attributes: edge.attributes ?? {},
	};
}

async function requireEntityById(pool: pg.Pool, id: string): Promise<CoreEntity> {
	const entity = await findEntityById(pool, id);
	if (!entity) {
		throw new DatabaseError(`Entity not found: ${id}`, DATABASE_ERROR_CODES.DB_NOT_FOUND, {
			context: { id },
		});
	}

	return entity;
}

function createRouteLogger(rootLogger: Logger, metadata: Record<string, string | number | null | undefined>) {
	return createChildLogger(rootLogger, {
		module: 'api',
		route: 'entities',
		...metadata,
	});
}

export async function listEntities(input: EntityListQuery, logger?: Logger): Promise<EntityListResponse> {
	const rootLogger = logger ?? createLogger();
	const { pool } = resolveContext();
	const requestLogger = createRouteLogger(rootLogger, {
		action: 'list',
		type: input.type ?? null,
		search: input.search ?? null,
		taxonomy_status: input.taxonomy_status ?? null,
		limit: input.limit,
		offset: input.offset,
	});
	const startedAt = performance.now();

	const filter: EntityFilter = {
		type: input.type,
		search: input.search,
		taxonomyStatus: input.taxonomy_status,
		limit: input.limit,
		offset: input.offset,
	};

	const [count, entities] = await Promise.all([countEntities(pool, filter), findAllEntities(pool, filter)]);
	const response: EntityListResponse = {
		data: entities.map(mapEntity),
		meta: {
			count,
			limit: input.limit,
			offset: input.offset,
		},
	};

	requestLogger.info(
		{
			count,
			result_count: response.data.length,
			duration_ms: Math.round(performance.now() - startedAt),
		},
		'entity list request completed',
	);

	return response;
}

export async function getEntityDetail(id: string, logger?: Logger): Promise<EntityDetailResponse> {
	const rootLogger = logger ?? createLogger();
	const { pool } = resolveContext();
	const requestLogger = createRouteLogger(rootLogger, {
		action: 'detail',
		entity_id: id,
	});
	const startedAt = performance.now();

	const entity = await requireEntityById(pool, id);
	const [aliases, stories, mergedEntities] = await Promise.all([
		findAliasesByEntityId(pool, id),
		findStoriesByEntityId(pool, id),
		findEntitiesByCanonicalId(pool, id),
	]);

	const response: EntityDetailResponse = {
		data: {
			entity: mapEntity(entity),
			aliases: aliases.map(mapAlias),
			stories: stories.map(mapStory),
			merged_entities: mergedEntities.map(mapEntity),
		},
	};

	requestLogger.info(
		{
			alias_count: response.data.aliases.length,
			story_count: response.data.stories.length,
			merged_count: response.data.merged_entities.length,
			duration_ms: Math.round(performance.now() - startedAt),
		},
		'entity detail request completed',
	);

	return response;
}

export async function getEntityEdges(id: string, logger?: Logger): Promise<EntityEdgesResponse> {
	const rootLogger = logger ?? createLogger();
	const { pool } = resolveContext();
	const requestLogger = createRouteLogger(rootLogger, {
		action: 'edges',
		entity_id: id,
	});
	const startedAt = performance.now();

	await requireEntityById(pool, id);
	const edges = await findEdgesByEntityId(pool, id);
	const response: EntityEdgesResponse = {
		data: edges.map(mapEdge),
	};

	requestLogger.info(
		{
			result_count: response.data.length,
			duration_ms: Math.round(performance.now() - startedAt),
		},
		'entity edges request completed',
	);

	return response;
}

export async function mergeEntities(targetId: string, sourceId: string, logger?: Logger): Promise<EntityMergeResponse> {
	const rootLogger = logger ?? createLogger();
	const { pool } = resolveContext();
	const requestLogger = createRouteLogger(rootLogger, {
		action: 'merge',
		target_id: targetId,
		source_id: sourceId,
	});
	const startedAt = performance.now();

	if (targetId === sourceId) {
		throw new MulderError('Cannot merge an entity into itself', 'VALIDATION_ERROR', {
			context: {
				target_id: targetId,
				source_id: sourceId,
			},
		});
	}

	const [target, source] = await Promise.all([requireEntityById(pool, targetId), requireEntityById(pool, sourceId)]);

	if (target.canonicalId !== null || source.canonicalId !== null) {
		throw new MulderError('One or both entities are already merged', 'VALIDATION_ERROR', {
			context: {
				target_id: targetId,
				source_id: sourceId,
				target_canonical_id: target.canonicalId,
				source_canonical_id: source.canonicalId,
			},
		});
	}

	const result: MergeEntitiesResult = await mergeEntitiesRepository(pool, targetId, sourceId);
	const response: EntityMergeResponse = {
		data: {
			target: {
				id: result.target.id,
			},
			merged: {
				id: result.merged.id,
				canonical_id: result.merged.canonicalId ?? targetId,
			},
			edges_reassigned: result.edgesReassigned,
			stories_reassigned: result.storiesReassigned,
			aliases_copied: result.aliasesCopied,
		},
	};

	requestLogger.info(
		{
			edges_reassigned: response.data.edges_reassigned,
			stories_reassigned: response.data.stories_reassigned,
			aliases_copied: response.data.aliases_copied,
			duration_ms: Math.round(performance.now() - startedAt),
		},
		'entity merge request completed',
	);

	return response;
}

export function resetEntityContextForTests(): void {
	cachedContext = null;
	cachedConfigPath = null;
}
