import {
	type Collection,
	type CollectionSummary,
	createCollection,
	findCollectionById,
	listCollections,
	MulderError,
	setCollectionTags,
	summarizeCollection,
	updateCollection,
} from '@mulder/core';
import type { AuthPrincipal } from '../middleware/auth.js';
import type {
	CollectionDetailResponse,
	CollectionListQuery,
	CollectionListResponse,
	CollectionSummaryResponse,
	CreateCollectionRequest,
	PatchCollectionRequest,
} from '../routes/collections.schemas.js';
import { actorIdForPrincipal, resolveApiDataContext, resolveReadMaxSensitivity, toIsoString } from './api-runtime.js';

interface CollectionRouteOptions {
	authPrincipal?: AuthPrincipal;
}

function assertCanManageCollections(authPrincipal: AuthPrincipal | undefined): void {
	if (authPrincipal?.type === 'session' && !['owner', 'admin'].includes(authPrincipal.role)) {
		throw new MulderError('The current principal cannot manage collections', 'AUTH_FORBIDDEN', {
			context: { resource: 'collections', required_role: 'admin' },
		});
	}
}

function collectionToResponse(collection: Collection | CollectionSummary): CollectionSummaryResponse {
	return {
		collection_id: collection.collectionId,
		name: collection.name,
		description: collection.description,
		type: collection.type,
		archive_id: collection.archiveId,
		created_by: collection.createdBy,
		visibility: collection.visibility,
		tags: collection.tags,
		defaults: {
			sensitivity_level: collection.defaults.sensitivityLevel,
			default_language: collection.defaults.defaultLanguage,
			credibility_profile_id: collection.defaults.credibilityProfileId,
		},
		created_at: collection.createdAt.toISOString(),
		updated_at: collection.updatedAt.toISOString(),
		document_count: 'documentCount' in collection ? collection.documentCount : 0,
		total_size_bytes: 'totalSizeBytes' in collection ? collection.totalSizeBytes : 0,
		languages: 'languages' in collection ? collection.languages : [],
		date_range:
			'dateRange' in collection
				? {
						earliest: toIsoString(collection.dateRange.earliest),
						latest: toIsoString(collection.dateRange.latest),
					}
				: { earliest: null, latest: null },
	};
}

async function countCollections(query: CollectionListQuery): Promise<number> {
	const { pool } = resolveApiDataContext('collections');
	const params: unknown[] = [];
	const conditions: string[] = [];
	if (query.type) {
		params.push(query.type);
		conditions.push(`type = $${params.length}`);
	}
	if (query.visibility) {
		params.push(query.visibility);
		conditions.push(`visibility = $${params.length}`);
	}
	if (query.archive_id) {
		params.push(query.archive_id);
		conditions.push(`archive_id = $${params.length}`);
	}
	if (query.tag) {
		params.push(query.tag);
		conditions.push(`$${params.length} = ANY(tags)`);
	}
	const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
	const result = await pool.query<{ count: string }>(`SELECT COUNT(*) AS count FROM collections ${where}`, params);
	return Number.parseInt(result.rows[0]?.count ?? '0', 10) || 0;
}

async function collectionSummaryOrNull(collectionId: string): Promise<CollectionSummaryResponse | null> {
	const { pool } = resolveApiDataContext('collections');
	const summary = await summarizeCollection(pool, collectionId);
	if (summary) {
		return collectionToResponse(summary);
	}
	const collection = await findCollectionById(pool, collectionId);
	return collection ? collectionToResponse(collection) : null;
}

export async function listCollectionSummaries(
	query: CollectionListQuery,
	options?: CollectionRouteOptions,
): Promise<CollectionListResponse> {
	const { config, pool } = resolveApiDataContext('collections');
	resolveReadMaxSensitivity(config, options?.authPrincipal, 'collections');
	const [collections, count] = await Promise.all([
		listCollections(pool, {
			type: query.type,
			visibility: query.visibility,
			archiveId: query.archive_id,
			tag: query.tag,
			limit: query.limit,
			offset: query.offset,
		}),
		countCollections(query),
	]);
	const summaries = await Promise.all(
		collections.map((collection) => collectionSummaryOrNull(collection.collectionId)),
	);
	return {
		data: summaries.flatMap((summary) => (summary ? [summary] : [])),
		meta: {
			count,
			limit: query.limit,
			offset: query.offset,
		},
	};
}

export async function getCollectionDetail(
	collectionId: string,
	options?: CollectionRouteOptions,
): Promise<CollectionDetailResponse> {
	const { config } = resolveApiDataContext('collections');
	resolveReadMaxSensitivity(config, options?.authPrincipal, 'collections');
	const summary = await collectionSummaryOrNull(collectionId);
	if (!summary) {
		throw new MulderError(`Collection not found: ${collectionId}`, 'COLLECTION_NOT_FOUND', {
			context: { collection_id: collectionId },
		});
	}
	return { data: summary };
}

export async function createCollectionFromApi(
	input: CreateCollectionRequest,
	options?: CollectionRouteOptions,
): Promise<CollectionDetailResponse> {
	assertCanManageCollections(options?.authPrincipal);
	const { pool } = resolveApiDataContext('collections');
	const collection = await createCollection(pool, {
		name: input.name,
		description: input.description,
		type: input.type,
		archiveId: input.archive_id ?? null,
		createdBy: actorIdForPrincipal(options?.authPrincipal),
		visibility: input.visibility,
		tags: input.tags,
		defaults: {
			sensitivityLevel: input.defaults.sensitivity_level,
			defaultLanguage: input.defaults.default_language,
			credibilityProfileId: input.defaults.credibility_profile_id,
		},
	});
	return { data: collectionToResponse(collection) };
}

export async function patchCollectionFromApi(
	collectionId: string,
	input: PatchCollectionRequest,
	options?: CollectionRouteOptions,
): Promise<CollectionDetailResponse> {
	assertCanManageCollections(options?.authPrincipal);
	const { pool } = resolveApiDataContext('collections');
	let collection = await updateCollection(pool, collectionId, {
		name: input.name,
		description: input.description,
		archiveId: input.archive_id,
		visibility: input.visibility,
		defaults: input.defaults
			? {
					sensitivityLevel: input.defaults.sensitivity_level,
					defaultLanguage: input.defaults.default_language,
					credibilityProfileId: input.defaults.credibility_profile_id,
				}
			: undefined,
	});
	if (input.tags) {
		collection = await setCollectionTags(pool, collection.collectionId, input.tags);
	}
	return { data: collectionToResponse(collection) };
}
