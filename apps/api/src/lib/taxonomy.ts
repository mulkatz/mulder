import {
	countTaxonomyEntries,
	createLogger,
	findAllTaxonomyEntries,
	type Logger,
	type TaxonomyEntry,
} from '@mulder/core';
import { exportTaxonomy } from '@mulder/taxonomy';
import type { AuthPrincipal } from '../middleware/auth.js';
import type {
	TaxonomyEntryResponse,
	TaxonomyExportQuery,
	TaxonomyListQuery,
	TaxonomyListResponse,
} from '../routes/taxonomy.schemas.js';
import { resolveApiDataContext, resolveReadMaxSensitivity } from './api-runtime.js';

interface TaxonomyRouteOptions {
	authPrincipal?: AuthPrincipal;
	logger?: Logger;
}

function taxonomyEntryToResponse(entry: TaxonomyEntry): TaxonomyEntryResponse {
	return {
		id: entry.id,
		canonical_name: entry.canonicalName,
		entity_type: entry.entityType,
		category: entry.category,
		status: entry.status,
		aliases: entry.aliases,
		created_at: entry.createdAt.toISOString(),
		updated_at: entry.updatedAt.toISOString(),
	};
}

export async function listTaxonomyEntries(
	query: TaxonomyListQuery,
	options?: TaxonomyRouteOptions,
): Promise<TaxonomyListResponse> {
	const { config, pool } = resolveApiDataContext('taxonomy');
	resolveReadMaxSensitivity(config, options?.authPrincipal, 'taxonomy');
	const filter = {
		entityType: query.entity_type,
		status: query.status,
		limit: query.limit,
		offset: query.offset,
	};
	const [entries, count] = await Promise.all([
		findAllTaxonomyEntries(pool, filter),
		countTaxonomyEntries(pool, filter),
	]);
	return {
		data: entries.map(taxonomyEntryToResponse),
		meta: {
			count,
			limit: query.limit,
			offset: query.offset,
		},
	};
}

export async function exportTaxonomyYaml(query: TaxonomyExportQuery, options?: TaxonomyRouteOptions): Promise<string> {
	const { config, pool } = resolveApiDataContext('taxonomy');
	resolveReadMaxSensitivity(config, options?.authPrincipal, 'taxonomy export');
	const result = await exportTaxonomy({
		pool,
		typeFilter: query.entity_type,
		logger: options?.logger ?? createLogger(),
	});
	return result.yaml;
}
