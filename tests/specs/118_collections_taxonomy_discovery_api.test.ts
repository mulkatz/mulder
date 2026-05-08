import { createHash, randomUUID } from 'node:crypto';
import { createApp } from '@mulder/api';
import {
	createEntity,
	createTaxonomyEntry,
	replaceExternalCorrelationSnapshot,
	replaceTemporalPatternSnapshot,
	upsertClassificationCategory,
	upsertClassificationTaxonomy,
	upsertSimilarityResult,
	upsertTaxonomyMapping,
} from '@mulder/core';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as db from '../lib/db.js';
import { ensureSchema, truncateMulderTables } from '../lib/schema.js';

const TEST_API_CONFIG = {
	port: 8080,
	auth: {
		api_keys: [{ name: 'cli', key: 'test-api-key' }],
		browser: {
			enabled: true,
			cookie_name: 'mulder_session',
			session_secret: 'test-session-secret',
			session_ttl_hours: 168,
			invitation_ttl_hours: 168,
			cookie_secure: false,
			same_site: 'Lax' as const,
		},
	},
	rate_limiting: {
		enabled: true,
	},
	budget: {
		enabled: true,
		monthly_limit_usd: 50,
		extract_per_page_usd: 0.006,
		segment_per_page_usd: 0.002,
		enrich_per_source_usd: 0.015,
		embed_per_source_usd: 0.004,
		graph_per_source_usd: 0.001,
	},
};

function authorizedHeaders(): Record<string, string> {
	return {
		Authorization: 'Bearer test-api-key',
	};
}

function hashToken(token: string): string {
	return createHash('sha256').update(`${TEST_API_CONFIG.auth.browser.session_secret}:${token}`).digest('hex');
}

async function readJson(response: Response): Promise<unknown> {
	return await response.json();
}

async function seedInvitation(
	pool: pg.Pool,
	input: { email: string; token: string; role: 'admin' | 'member' | 'owner' },
): Promise<void> {
	await pool.query(
		`
			INSERT INTO api_invitations (email, role, token_hash, expires_at)
			VALUES ($1, $2, $3, now() + interval '1 day')
		`,
		[input.email, input.role, hashToken(input.token)],
	);
}

async function acceptInvitation(app: ReturnType<typeof createApp>, pool: pg.Pool, role: 'admin' | 'member') {
	const token = `${role}-${randomUUID()}`;
	await seedInvitation(pool, { email: `${role}-${randomUUID()}@example.test`, role, token });
	const response = await app.request('http://localhost/api/auth/invitations/accept', {
		body: JSON.stringify({ token, password: 'correct horse battery staple' }),
		headers: { 'Content-Type': 'application/json' },
		method: 'POST',
	});
	expect(response.status).toBe(200);
	const setCookie = response.headers.get('set-cookie');
	expect(setCookie).toContain('mulder_session=');
	return setCookie?.split(';')[0] ?? '';
}

async function seedSource(pool: pg.Pool, deletionStatus: 'active' | 'soft_deleted' = 'active'): Promise<string> {
	const id = randomUUID();
	await pool.query(
		[
			'INSERT INTO sources (id, filename, storage_path, file_hash, page_count, status, metadata, deletion_status, deleted_at)',
			'VALUES ($1, $2, $3, $4, 2, $5, $6::jsonb, $7, CASE WHEN $7 = $8 THEN now() ELSE NULL END)',
		].join(' '),
		[
			id,
			'discovery-source.pdf',
			`raw/${id}/discovery-source.pdf`,
			randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', ''),
			'analyzed',
			JSON.stringify({ language: 'de' }),
			deletionStatus,
			'soft_deleted',
		],
	);
	return id;
}

async function createEntityFixture(
	pool: pg.Pool,
	label: string,
	options?: { sensitivityLevel?: 'internal' | 'confidential'; sourceDocumentIds?: string[] },
) {
	return await createEntity(pool, {
		name: `${label} ${randomUUID()}`,
		type: 'case',
		attributes: {},
		provenance: options?.sourceDocumentIds ? { sourceDocumentIds: options.sourceDocumentIds } : undefined,
		sensitivityLevel: options?.sensitivityLevel ?? 'internal',
	});
}

describe('Spec 118: collections, taxonomy, and discovery API routes', () => {
	let pool: pg.Pool;
	const originalConfig = process.env.MULDER_CONFIG;

	beforeAll(() => {
		db.requirePg();
		process.env.MULDER_CONFIG = 'mulder.config.example.yaml';
		ensureSchema();
		pool = new pg.Pool({
			host: db.TEST_PG_HOST,
			port: db.TEST_PG_PORT,
			user: db.TEST_PG_USER,
			password: db.TEST_PG_PASSWORD,
			database: db.TEST_PG_DATABASE,
		});
	});

	beforeEach(() => {
		truncateMulderTables();
	});

	afterAll(async () => {
		truncateMulderTables();
		await pool?.end();
		if (originalConfig === undefined) {
			delete process.env.MULDER_CONFIG;
		} else {
			process.env.MULDER_CONFIG = originalConfig;
		}
	});

	it('creates, lists, reads, and patches collections without exposing archive mutation', async () => {
		const app = createApp({ config: TEST_API_CONFIG });
		const createResponse = await app.request('http://localhost/api/collections', {
			body: JSON.stringify({
				name: `Research collection ${randomUUID()}`,
				description: 'Product API collection',
				type: 'curated',
				visibility: 'team',
				tags: ['reader'],
				defaults: { sensitivity_level: 'restricted', default_language: 'de' },
			}),
			headers: { ...authorizedHeaders(), 'Content-Type': 'application/json' },
			method: 'POST',
		});
		expect(createResponse.status).toBe(201);
		const created = (await readJson(createResponse)) as { data: { collection_id: string } };
		expect(created).toMatchObject({
			data: {
				description: 'Product API collection',
				type: 'curated',
				archive_id: null,
				visibility: 'team',
				tags: ['reader'],
				defaults: { sensitivity_level: 'restricted', default_language: 'de' },
			},
		});

		const listResponse = await app.request('http://localhost/api/collections?visibility=team&tag=reader', {
			headers: authorizedHeaders(),
		});
		expect(listResponse.status).toBe(200);
		expect(await readJson(listResponse)).toMatchObject({
			data: [{ collection_id: created.data.collection_id, document_count: 0 }],
			meta: { count: 1, limit: 50, offset: 0 },
		});

		const patchResponse = await app.request(`http://localhost/api/collections/${created.data.collection_id}`, {
			body: JSON.stringify({ visibility: 'private', tags: ['reader', 'curated'] }),
			headers: { ...authorizedHeaders(), 'Content-Type': 'application/json' },
			method: 'PATCH',
		});
		expect(patchResponse.status).toBe(200);
		expect(await readJson(patchResponse)).toMatchObject({
			data: {
				collection_id: created.data.collection_id,
				type: 'curated',
				archive_id: null,
				visibility: 'private',
				tags: ['curated', 'reader'],
			},
		});
	});

	it('serves taxonomy entries and YAML export', async () => {
		const app = createApp({ config: TEST_API_CONFIG });
		const entry = await createTaxonomyEntry(pool, {
			canonicalName: `Taxonomy fixture ${randomUUID()}`,
			entityType: 'person',
			status: 'confirmed',
			aliases: ['Fixture Alias'],
		});

		const listResponse = await app.request('http://localhost/api/taxonomy?entity_type=person&status=confirmed', {
			headers: authorizedHeaders(),
		});
		expect(listResponse.status).toBe(200);
		expect(await readJson(listResponse)).toMatchObject({
			data: [{ id: entry.id, canonical_name: entry.canonicalName, status: 'confirmed' }],
			meta: { count: 1, limit: 100, offset: 0 },
		});

		const exportResponse = await app.request('http://localhost/api/taxonomy/export?entity_type=person', {
			headers: authorizedHeaders(),
		});
		expect(exportResponse.status).toBe(200);
		expect(exportResponse.headers.get('content-type')).toContain('application/yaml');
		const yaml = await exportResponse.text();
		expect(yaml).toContain(entry.canonicalName);
		expect(yaml).toContain('confirmed');
	});

	it('serves discovery leads as caveated research signals', async () => {
		const app = createApp({ config: TEST_API_CONFIG });
		const memberCookie = await acceptInvitation(app, pool, 'member');
		const source = await createEntityFixture(pool, 'Source case');
		const target = await createEntityFixture(pool, 'Target case');
		const secondTarget = await createEntityFixture(pool, 'Second target case');
		const hiddenTarget = await createEntityFixture(pool, 'Hidden target case', { sensitivityLevel: 'confidential' });
		const deletedSourceId = await seedSource(pool, 'soft_deleted');
		const deletedTarget = await createEntityFixture(pool, 'Deleted target case', {
			sourceDocumentIds: [deletedSourceId],
		});
		await upsertSimilarityResult(pool, {
			sourceEntityId: source.id,
			targetEntityId: target.id,
			core: {
				semantic: { status: 'scored', score: 0.82, reason: null },
				structural: { status: 'insufficient_data', score: null, reason: 'missing_structure' },
				geospatial: { status: 'insufficient_data', score: null, reason: 'missing_location' },
				temporal: { status: 'insufficient_data', score: null, reason: 'missing_time' },
			},
			explanation: 'Shared attributes suggest a comparison.',
			sharedEntityIds: [],
			keyDifferences: ['Different time windows'],
			reviewStatus: 'pending',
		});
		await upsertSimilarityResult(pool, {
			sourceEntityId: source.id,
			targetEntityId: secondTarget.id,
			core: {
				semantic: { status: 'scored', score: 0.62, reason: null },
				structural: { status: 'insufficient_data', score: null, reason: 'missing_structure' },
				geospatial: { status: 'insufficient_data', score: null, reason: 'missing_location' },
				temporal: { status: 'insufficient_data', score: null, reason: 'missing_time' },
			},
			explanation: 'Secondary comparison lead.',
			sharedEntityIds: [],
			keyDifferences: ['Different source context'],
			reviewStatus: 'pending',
		});
		await upsertSimilarityResult(pool, {
			sourceEntityId: source.id,
			targetEntityId: hiddenTarget.id,
			core: {
				semantic: { status: 'scored', score: 0.95, reason: null },
				structural: { status: 'insufficient_data', score: null, reason: 'missing_structure' },
				geospatial: { status: 'insufficient_data', score: null, reason: 'missing_location' },
				temporal: { status: 'insufficient_data', score: null, reason: 'missing_time' },
			},
			explanation: 'Confidential comparison lead.',
			sharedEntityIds: [],
			keyDifferences: ['Hidden target'],
			reviewStatus: 'pending',
		});
		await upsertSimilarityResult(pool, {
			sourceEntityId: source.id,
			targetEntityId: deletedTarget.id,
			core: {
				semantic: { status: 'scored', score: 0.9, reason: null },
				structural: { status: 'insufficient_data', score: null, reason: 'missing_structure' },
				geospatial: { status: 'insufficient_data', score: null, reason: 'missing_location' },
				temporal: { status: 'insufficient_data', score: null, reason: 'missing_time' },
			},
			explanation: 'Deleted-source comparison lead.',
			sharedEntityIds: [],
			keyDifferences: ['Deleted target source'],
			reviewStatus: 'pending',
		});

		const leftTaxonomy = await upsertClassificationTaxonomy(pool, {
			id: `local-${randomUUID()}`,
			name: 'Local taxonomy',
			status: 'active',
		});
		const rightTaxonomy = await upsertClassificationTaxonomy(pool, {
			id: `reference-${randomUUID()}`,
			name: 'Reference taxonomy',
			status: 'active',
		});
		const leftCategory = await upsertClassificationCategory(pool, {
			id: `category-a-${randomUUID()}`,
			taxonomyId: leftTaxonomy.id,
			code: 'A',
			label: 'Category A',
		});
		const rightCategory = await upsertClassificationCategory(pool, {
			id: `category-b-${randomUUID()}`,
			taxonomyId: rightTaxonomy.id,
			code: 'B',
			label: 'Category B',
		});
		const secondRightCategory = await upsertClassificationCategory(pool, {
			id: `category-c-${randomUUID()}`,
			taxonomyId: rightTaxonomy.id,
			code: 'C',
			label: 'Category C',
		});
		const mapping = await upsertTaxonomyMapping(pool, {
			source: { taxonomyId: leftTaxonomy.id, categoryId: leftCategory.id },
			target: { taxonomyId: rightTaxonomy.id, categoryId: rightCategory.id },
			mappingType: 'related',
			confidence: 0.71,
			rationale: 'Comparable categories.',
			reviewStatus: 'draft',
		});
		await upsertTaxonomyMapping(pool, {
			source: { taxonomyId: leftTaxonomy.id, categoryId: leftCategory.id },
			target: { taxonomyId: rightTaxonomy.id, categoryId: secondRightCategory.id },
			mappingType: 'related',
			confidence: 0.51,
			rationale: 'Secondary comparable category.',
			reviewStatus: 'draft',
		});

		const similarResponse = await app.request(
			`http://localhost/api/discovery/similar-entities?entity_id=${source.id}&limit=10`,
			{
				headers: { Cookie: memberCookie },
			},
		);
		expect(similarResponse.status).toBe(200);
		const similarBody = (await readJson(similarResponse)) as {
			data: { entity_id: string; review_status: string }[];
			meta: { count: number; limit: number; offset: number };
			caveats: string[];
		};
		expect(similarBody).toMatchObject({
			data: expect.arrayContaining([
				expect.objectContaining({ entity_id: target.id, review_status: 'pending' }),
				expect.objectContaining({ entity_id: secondTarget.id, review_status: 'pending' }),
			]),
			meta: { count: 2, limit: 10, offset: 0 },
			caveats: expect.arrayContaining(['Discovery results are research leads, not final proof.']),
		});
		expect(similarBody.data.map((item) => item.entity_id)).not.toContain(hiddenTarget.id);
		expect(similarBody.data.map((item) => item.entity_id)).not.toContain(deletedTarget.id);

		const mappingsResponse = await app.request(
			'http://localhost/api/discovery/classification-mappings?mapping_type=related&limit=1',
			{
				headers: authorizedHeaders(),
			},
		);
		expect(mappingsResponse.status).toBe(200);
		expect(await readJson(mappingsResponse)).toMatchObject({
			data: [{ id: mapping.id, mapping_type: 'related', review_status: 'draft' }],
			meta: { count: 2, limit: 1, offset: 0 },
			caveats: expect.arrayContaining(['Discovery results are research leads, not final proof.']),
		});
	});

	it('serves temporal patterns and external correlations with caveats', async () => {
		const app = createApp({ config: TEST_API_CONFIG });
		const entity = await createEntityFixture(pool, 'Pattern case');
		const start = new Date('2026-01-01T00:00:00.000Z');
		const end = new Date('2026-01-07T00:00:00.000Z');
		await replaceTemporalPatternSnapshot(pool, {
			anomalies: [
				{
					regionKey: 'global',
					timeStart: start,
					timeEnd: end,
					entityCount: 3,
					baselineRate: 1,
					observedRate: 3,
					rawSignificance: 0.02,
					comparisonCount: 2,
					correctedSignificance: 0.04,
					significanceThreshold: 0.05,
					peakDate: new Date('2026-01-03T00:00:00.000Z'),
					contributingEntityIds: [entity.id],
				},
				{
					regionKey: 'global',
					timeStart: new Date('2026-01-08T00:00:00.000Z'),
					timeEnd: new Date('2026-01-14T00:00:00.000Z'),
					entityCount: 2,
					baselineRate: 1,
					observedRate: 2,
					rawSignificance: 0.03,
					comparisonCount: 2,
					correctedSignificance: 0.05,
					significanceThreshold: 0.05,
					peakDate: new Date('2026-01-09T00:00:00.000Z'),
					contributingEntityIds: [entity.id],
				},
			],
			hotspots: [
				{
					regionKey: 'global',
					centroidLat: 52.52,
					centroidLng: 13.405,
					radiusKm: 10,
					timeStart: start,
					timeEnd: end,
					entityCount: 3,
					density: 0.8,
					persistence: 'transient',
					contributingEntityIds: [entity.id],
				},
			],
		});
		await replaceExternalCorrelationSnapshot(pool, {
			correlations: [
				{
					internalSeriesKey: 'case-count',
					externalSourceId: 'public-dataset',
					externalSeriesId: 'series-a',
					method: 'spearman',
					coefficient: 0.9,
					pValue: 0.03,
					lagDays: 0,
					timeStart: start,
					timeEnd: end,
					dataPointCount: 7,
					contributingEntityIds: [entity.id],
				},
				{
					internalSeriesKey: 'case-count',
					externalSourceId: 'public-dataset',
					externalSeriesId: 'series-b',
					method: 'cross_correlation',
					coefficient: 0.7,
					pValue: 0.04,
					lagDays: 1,
					timeStart: start,
					timeEnd: end,
					dataPointCount: 7,
					contributingEntityIds: [entity.id],
				},
			],
		});

		const patternsResponse = await app.request(
			'http://localhost/api/discovery/temporal-patterns?region_key=global&limit=1',
			{
				headers: authorizedHeaders(),
			},
		);
		expect(patternsResponse.status).toBe(200);
		expect(await readJson(patternsResponse)).toMatchObject({
			data: {
				anomalies: [{ region_key: 'global', signal_strength: 'weak' }],
				hotspots: [{ region_key: 'global', persistence: 'transient' }],
			},
			meta: { count: 3, limit: 1, offset: 0 },
			caveats: expect.arrayContaining(['Temporal and spatial patterns can reflect reporting bias or missing data.']),
		});

		const correlationsResponse = await app.request(
			'http://localhost/api/discovery/external-correlations?external_source_id=public-dataset&limit=1',
			{ headers: authorizedHeaders() },
		);
		expect(correlationsResponse.status).toBe(200);
		expect(await readJson(correlationsResponse)).toMatchObject({
			data: [{ external_source_id: 'public-dataset', method: 'spearman' }],
			meta: { count: 2, limit: 1, offset: 0 },
			caveats: expect.arrayContaining(['Correlation does not establish causation.']),
		});
	});

	it('protects the new routes and validates query contracts', async () => {
		const app = createApp({ config: TEST_API_CONFIG });

		const unauthenticatedResponse = await app.request('http://localhost/api/collections');
		expect(unauthenticatedResponse.status).toBe(401);

		const invalidDiscoveryResponse = await app.request(
			'http://localhost/api/discovery/similar-entities?entity_id=nope',
			{
				headers: authorizedHeaders(),
			},
		);
		expect(invalidDiscoveryResponse.status).toBe(400);
		expect(await readJson(invalidDiscoveryResponse)).toMatchObject({
			error: { code: 'VALIDATION_ERROR' },
		});
	});
});
