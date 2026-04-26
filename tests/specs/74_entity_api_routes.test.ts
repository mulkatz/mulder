import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as db from '../lib/db.js';
import { ensureSchema, truncateMulderTables } from '../lib/schema.js';

const ROOT = resolve(import.meta.dirname, '../..');
const CORE_DIR = resolve(ROOT, 'packages/core');
const RETRIEVAL_DIR = resolve(ROOT, 'packages/retrieval');
const TAXONOMY_DIR = resolve(ROOT, 'packages/taxonomy');
const EVIDENCE_DIR = resolve(ROOT, 'packages/evidence');
const WORKER_DIR = resolve(ROOT, 'packages/worker');
const API_DIR = resolve(ROOT, 'apps/api');
const CORE_DIST = resolve(CORE_DIR, 'dist/index.js');
const RETRIEVAL_DIST = resolve(RETRIEVAL_DIR, 'dist/index.js');
const API_APP_DIST = resolve(API_DIR, 'dist/app.js');
const EXAMPLE_CONFIG = resolve(ROOT, 'mulder.config.example.yaml');

interface ApiApp {
	request: (input: string | Request, init?: RequestInit) => Promise<Response>;
	fetch: (input: string | Request, init?: RequestInit) => Promise<Response>;
}

interface EntityFixtures {
	listPersonId: string;
	listLocationId: string;
	listOtherPersonId: string;
	detailEntityId: string;
	detailMergedChildId: string;
	detailStoryOneId: string;
	detailStoryTwoId: string;
	detailIncomingEntityId: string;
	mergeTargetId: string;
	mergeSourceId: string;
	mergeStoryOneId: string;
	mergeStoryTwoId: string;
	mergeEdgePartnerId: string;
	alreadyMergedEntityId: string;
	aliasEntityId: string;
}

function buildPackage(packageDir: string): void {
	const result = spawnSync('pnpm', ['build'], {
		cwd: packageDir,
		stdio: ['ignore', 'pipe', 'pipe'],
		env: {
			...process.env,
			MULDER_LOG_LEVEL: 'silent',
		},
	});

	expect(result.status ?? 1).toBe(0);
	if ((result.status ?? 1) !== 0) {
		throw new Error(
			`Build failed in ${packageDir}:\n${result.stdout?.toString() ?? ''}\n${result.stderr?.toString() ?? ''}`,
		);
	}
}

function sqlString(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

function cleanState(): void {
	truncateMulderTables();
}

function seedSource(filename: string): string {
	const id = randomUUID();
	const fileHash = `${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '')}`;
	db.runSql(
		[
			'INSERT INTO sources (id, filename, storage_path, file_hash, page_count, status, metadata)',
			`VALUES (${sqlString(id)}, ${sqlString(filename)}, ${sqlString(`raw/${filename}`)}, ${sqlString(fileHash)}, 1, 'ingested', '{}'::jsonb)`,
			'ON CONFLICT (id) DO NOTHING;',
		].join(' '),
	);
	return id;
}

function seedStory(opts: { id?: string; sourceId: string; title: string; status?: string }): string {
	const id = opts.id ?? randomUUID();
	const slug = id.replace(/-/g, '');
	db.runSql(
		[
			'INSERT INTO stories (id, source_id, title, gcs_markdown_uri, gcs_metadata_uri, status, metadata)',
			`VALUES (${sqlString(id)}, ${sqlString(opts.sourceId)}, ${sqlString(opts.title)}, ${sqlString(`gs://test/${slug}.md`)}, ${sqlString(`gs://test/${slug}.meta.json`)}, ${sqlString(opts.status ?? 'enriched')}, '{}'::jsonb)`,
			'ON CONFLICT (id) DO NOTHING;',
		].join(' '),
	);
	return id;
}

function seedEntity(opts: {
	id?: string;
	name: string;
	type: string;
	canonicalId?: string | null;
	taxonomyStatus?: 'auto' | 'curated' | 'merged';
	taxonomyId?: string | null;
	sourceCount?: number;
	corroborationScore?: number | null;
}): string {
	const id = opts.id ?? randomUUID();
	const canonicalId =
		opts.canonicalId === undefined || opts.canonicalId === null ? 'NULL' : sqlString(opts.canonicalId);
	const taxonomyId = opts.taxonomyId === undefined || opts.taxonomyId === null ? 'NULL' : sqlString(opts.taxonomyId);
	const sourceCount = opts.sourceCount ?? 0;
	const corroborationScore =
		opts.corroborationScore === undefined || opts.corroborationScore === null
			? 'NULL'
			: String(opts.corroborationScore);
	db.runSql(
		[
			'INSERT INTO entities (id, name, type, canonical_id, taxonomy_status, taxonomy_id, corroboration_score, source_count, attributes)',
			`VALUES (${sqlString(id)}, ${sqlString(opts.name)}, ${sqlString(opts.type)}, ${canonicalId}, ${sqlString(opts.taxonomyStatus ?? 'auto')}, ${taxonomyId}, ${corroborationScore}, ${sourceCount}, '{}'::jsonb)`,
			'ON CONFLICT (id) DO NOTHING;',
		].join(' '),
	);
	return id;
}

function seedAlias(opts: { entityId: string; alias: string; source?: string }): string {
	const id = randomUUID();
	db.runSql(
		[
			'INSERT INTO entity_aliases (id, entity_id, alias, source)',
			`VALUES (${sqlString(id)}, ${sqlString(opts.entityId)}, ${sqlString(opts.alias)}, ${opts.source ? sqlString(opts.source) : `'manual'`})`,
			'ON CONFLICT DO NOTHING;',
		].join(' '),
	);
	return id;
}

function seedStoryEntity(storyId: string, entityId: string, confidence: number, mentionCount: number): void {
	db.runSql(
		[
			'INSERT INTO story_entities (story_id, entity_id, confidence, mention_count)',
			`VALUES (${sqlString(storyId)}, ${sqlString(entityId)}, ${confidence}, ${mentionCount})`,
			'ON CONFLICT DO NOTHING;',
		].join(' '),
	);
}

function seedEdge(opts: {
	sourceEntityId: string;
	targetEntityId: string;
	relationship: string;
	storyId?: string | null;
	edgeType?:
		| 'RELATIONSHIP'
		| 'DUPLICATE_OF'
		| 'POTENTIAL_CONTRADICTION'
		| 'CONFIRMED_CONTRADICTION'
		| 'DISMISSED_CONTRADICTION';
	confidence?: number | null;
}): string {
	const id = randomUUID();
	const storyId = opts.storyId === undefined || opts.storyId === null ? 'NULL' : sqlString(opts.storyId);
	const confidence = opts.confidence === undefined || opts.confidence === null ? 'NULL' : String(opts.confidence);
	db.runSql(
		[
			'INSERT INTO entity_edges (id, source_entity_id, target_entity_id, relationship, attributes, confidence, story_id, edge_type)',
			`VALUES (${sqlString(id)}, ${sqlString(opts.sourceEntityId)}, ${sqlString(opts.targetEntityId)}, ${sqlString(opts.relationship)}, '{}'::jsonb, ${confidence}, ${storyId}, ${sqlString(opts.edgeType ?? 'RELATIONSHIP')})`,
			'ON CONFLICT DO NOTHING;',
		].join(' '),
	);
	return id;
}

function seedFixtures(): EntityFixtures {
	const sourceId = seedSource('spec74-entities.pdf');
	const detailStoryOneId = seedStory({
		sourceId,
		title: 'Project Blue Book notes',
		status: 'enriched',
	});
	const detailStoryTwoId = seedStory({
		sourceId,
		title: 'Hynek interview transcript',
		status: 'enriched',
	});
	const mergeStoryOneId = seedStory({
		sourceId,
		title: 'Merge source evidence one',
		status: 'graphed',
	});
	const mergeStoryTwoId = seedStory({
		sourceId,
		title: 'Merge source evidence two',
		status: 'graphed',
	});

	const listPersonId = seedEntity({
		name: 'Josef Allen Hynek',
		type: 'person',
		taxonomyStatus: 'curated',
		sourceCount: 3,
		corroborationScore: 0.85,
	});
	const listLocationId = seedEntity({
		name: 'Area 51',
		type: 'location',
		taxonomyStatus: 'auto',
		sourceCount: 5,
	});
	const listOtherPersonId = seedEntity({
		name: 'Kenneth Arnold',
		type: 'person',
		taxonomyStatus: 'auto',
		sourceCount: 1,
	});

	const detailEntityId = listPersonId;
	const detailMergedChildId = seedEntity({
		name: 'Hynek Alias Cluster',
		type: 'person',
		canonicalId: detailEntityId,
		taxonomyStatus: 'merged',
	});
	seedAlias({ entityId: detailEntityId, alias: 'Dr. Hynek', source: 'manual' });
	seedAlias({ entityId: detailEntityId, alias: 'J. Allen Hynek', source: 'extraction' });
	seedStoryEntity(detailStoryOneId, detailEntityId, 0.9, 2);
	seedStoryEntity(detailStoryTwoId, detailEntityId, 0.8, 1);
	seedEdge({
		sourceEntityId: detailEntityId,
		targetEntityId: listLocationId,
		relationship: 'INVESTIGATED_AT',
		storyId: detailStoryOneId,
		confidence: 0.84,
	});
	seedEdge({
		sourceEntityId: listOtherPersonId,
		targetEntityId: detailEntityId,
		relationship: 'WITNESSED',
		storyId: detailStoryTwoId,
		confidence: 0.77,
	});

	const mergeTargetId = seedEntity({
		name: 'Merge Target',
		type: 'person',
		taxonomyStatus: 'curated',
	});
	const mergeSourceId = seedEntity({
		name: 'Merge Source',
		type: 'person',
		taxonomyStatus: 'curated',
	});
	const mergeEdgePartnerId = listLocationId;
	seedAlias({ entityId: mergeSourceId, alias: 'Source Alias', source: 'extraction' });
	seedStoryEntity(mergeStoryOneId, mergeSourceId, 0.95, 1);
	seedStoryEntity(mergeStoryTwoId, mergeSourceId, 0.88, 3);
	seedEdge({
		sourceEntityId: mergeSourceId,
		targetEntityId: mergeEdgePartnerId,
		relationship: 'VISITED',
		storyId: mergeStoryOneId,
		confidence: 0.9,
	});

	const alreadyMergedEntityId = seedEntity({
		name: 'Already Merged',
		type: 'person',
		canonicalId: listLocationId,
		taxonomyStatus: 'merged',
	});

	const aliasEntityId = seedEntity({
		name: 'Alias Entity',
		type: 'organization',
		taxonomyStatus: 'auto',
	});
	seedAlias({ entityId: aliasEntityId, alias: 'Alias One', source: 'extraction' });
	seedAlias({ entityId: aliasEntityId, alias: 'Alias Two', source: 'manual' });

	return {
		listPersonId,
		listLocationId,
		listOtherPersonId,
		detailEntityId,
		detailMergedChildId,
		detailStoryOneId,
		detailStoryTwoId,
		detailIncomingEntityId: listOtherPersonId,
		mergeTargetId,
		mergeSourceId,
		mergeStoryOneId,
		mergeStoryTwoId,
		mergeEdgePartnerId,
		alreadyMergedEntityId,
		aliasEntityId,
	};
}

function authorizedHeaders(ip: string): Record<string, string> {
	return {
		Authorization: 'Bearer test-api-key',
		'Content-Type': 'application/json',
		'X-Forwarded-For': ip,
	};
}

async function loadApiApp(): Promise<ApiApp> {
	const module = await import(pathToFileURL(API_APP_DIST).href);
	if (typeof module.createApp !== 'function') {
		throw new Error('API app module did not export createApp');
	}

	return module.createApp({
		config: {
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
					same_site: 'Lax',
				},
			},
			rate_limiting: {
				enabled: true,
			},
		},
	});
}

async function apiGet(app: ApiApp, path: string, ip: string): Promise<Response> {
	return app.request(`http://localhost${path}`, {
		method: 'GET',
		headers: authorizedHeaders(ip),
	});
}

async function apiPost(app: ApiApp, path: string, body: unknown, ip: string): Promise<Response> {
	return app.request(`http://localhost${path}`, {
		method: 'POST',
		headers: authorizedHeaders(ip),
		body: JSON.stringify(body),
	});
}

describe('Spec 74 — Entity API Routes', () => {
	const originalConfig = process.env.MULDER_CONFIG;
	const originalLogLevel = process.env.MULDER_LOG_LEVEL;
	let app: ApiApp;
	let pgAvailable = false;
	let fixtures: EntityFixtures;

	beforeAll(async () => {
		pgAvailable = db.isPgAvailable();
		if (!pgAvailable) {
			return;
		}

		ensureSchema();
		process.env.MULDER_CONFIG = EXAMPLE_CONFIG;
		process.env.MULDER_LOG_LEVEL = 'silent';

		buildPackage(CORE_DIR);
		buildPackage(RETRIEVAL_DIR);
		buildPackage(TAXONOMY_DIR);
		buildPackage(EVIDENCE_DIR);
		buildPackage(WORKER_DIR);
		buildPackage(API_DIR);

		await import(pathToFileURL(CORE_DIST).href);
		await import(pathToFileURL(RETRIEVAL_DIST).href);

		app = await loadApiApp();
	}, 600000);

	beforeEach(() => {
		if (!pgAvailable) {
			return;
		}

		cleanState();
		fixtures = seedFixtures();
	});

	afterAll(() => {
		if (pgAvailable) {
			try {
				cleanState();
			} catch {
				// Ignore cleanup failures.
			}
		}

		if (originalConfig === undefined) {
			delete process.env.MULDER_CONFIG;
		} else {
			process.env.MULDER_CONFIG = originalConfig;
		}

		if (originalLogLevel === undefined) {
			delete process.env.MULDER_LOG_LEVEL;
		} else {
			process.env.MULDER_LOG_LEVEL = originalLogLevel;
		}
	});

	it('QA-01: GET /api/entities lists entities for an authenticated request', async () => {
		if (!pgAvailable) {
			return;
		}

		const response = await apiGet(app, '/api/entities', '203.0.113.10');
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body).toMatchObject({
			meta: {
				count: expect.any(Number),
				limit: 20,
				offset: 0,
			},
		});

		const names = (body as { data: Array<{ name: string }> }).data.map((item) => item.name);
		expect(names).toEqual([...names].sort((left, right) => left.localeCompare(right)));
		expect((body as { data: unknown[]; meta: { count: number } }).data.length).toBe(
			(body as { meta: { count: number } }).meta.count,
		);
	});

	it('QA-02: list filters narrow the entity result set without mutating data', async () => {
		if (!pgAvailable) {
			return;
		}

		const beforeCount = Number(db.runSql('SELECT COUNT(*) FROM entities;'));
		const response = await apiGet(
			app,
			'/api/entities?type=person&taxonomy_status=curated&search=hynek',
			'203.0.113.11',
		);
		expect(response.status).toBe(200);

		const body = (await response.json()) as { data: Array<{ id: string; name: string }>; meta: { count: number } };
		expect(body.meta.count).toBe(1);
		expect(body.data).toHaveLength(1);
		expect(body.data[0]).toMatchObject({
			id: fixtures.detailEntityId,
			name: 'Josef Allen Hynek',
		});
		expect(Number(db.runSql('SELECT COUNT(*) FROM entities;'))).toBe(beforeCount);
	});

	it('QA-03: GET /api/entities/:id returns the entity with aliases, linked stories, and merged lineage', async () => {
		if (!pgAvailable) {
			return;
		}

		const response = await apiGet(app, `/api/entities/${fixtures.detailEntityId}`, '203.0.113.12');
		expect(response.status).toBe(200);

		const body = (await response.json()) as {
			data: {
				entity: { id: string; name: string };
				aliases: Array<{ alias: string }>;
				stories: Array<{ title: string; confidence: number | null; mention_count: number }>;
				merged_entities: Array<{ id: string; name: string }>;
			};
		};

		expect(body.data.entity).toMatchObject({
			id: fixtures.detailEntityId,
			name: 'Josef Allen Hynek',
		});
		expect(body.data.aliases.map((alias) => alias.alias).sort()).toEqual(['Dr. Hynek', 'J. Allen Hynek']);
		expect(body.data.stories).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					title: 'Project Blue Book notes',
					confidence: 0.9,
					mention_count: 2,
				}),
				expect.objectContaining({
					title: 'Hynek interview transcript',
					confidence: 0.8,
					mention_count: 1,
				}),
			]),
		);
		expect(body.data.merged_entities).toEqual([
			expect.objectContaining({
				id: fixtures.detailMergedChildId,
				name: 'Hynek Alias Cluster',
			}),
		]);
	});

	it('QA-04: unknown entity IDs fail with a JSON not-found response', async () => {
		if (!pgAvailable) {
			return;
		}

		const missingId = randomUUID();
		for (const path of [`/api/entities/${missingId}`, `/api/entities/${missingId}/edges`]) {
			const response = await apiGet(app, path, '203.0.113.13');
			expect(response.status).toBe(404);
			expect(await response.json()).toMatchObject({
				error: {
					code: 'DB_NOT_FOUND',
					message: expect.stringContaining('Entity not found'),
				},
			});
		}
	});

	it('QA-05: GET /api/entities/:id/edges returns relationship rows for the entity', async () => {
		if (!pgAvailable) {
			return;
		}

		const response = await apiGet(app, `/api/entities/${fixtures.detailEntityId}/edges`, '203.0.113.14');
		expect(response.status).toBe(200);

		const body = (await response.json()) as {
			data: Array<{
				id: string;
				source_entity_id: string;
				target_entity_id: string;
				relationship: string;
				edge_type: string;
				confidence: number | null;
				story_id: string | null;
			}>;
		};

		expect(body.data).toHaveLength(2);
		expect(body.data).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					source_entity_id: fixtures.detailEntityId,
					target_entity_id: fixtures.listLocationId,
					relationship: 'INVESTIGATED_AT',
					edge_type: 'RELATIONSHIP',
				}),
				expect.objectContaining({
					source_entity_id: fixtures.listOtherPersonId,
					target_entity_id: fixtures.detailEntityId,
					relationship: 'WITNESSED',
					edge_type: 'RELATIONSHIP',
				}),
			]),
		);
	});

	it('QA-06: POST /api/entities/merge performs the shipped merge workflow synchronously', async () => {
		if (!pgAvailable) {
			return;
		}

		const beforeJobs = Number(db.runSql('SELECT COUNT(*) FROM jobs;'));
		const beforeRuns = Number(db.runSql('SELECT COUNT(*) FROM pipeline_runs;'));
		const response = await apiPost(
			app,
			'/api/entities/merge',
			{
				target_id: fixtures.mergeTargetId,
				source_id: fixtures.mergeSourceId,
			},
			'203.0.113.15',
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			data: {
				target: {
					id: fixtures.mergeTargetId,
				},
				merged: {
					id: fixtures.mergeSourceId,
					canonical_id: fixtures.mergeTargetId,
				},
				edges_reassigned: 1,
				stories_reassigned: 2,
				aliases_copied: 2,
			},
		});

		expect(Number(db.runSql('SELECT COUNT(*) FROM jobs;'))).toBe(beforeJobs);
		expect(Number(db.runSql('SELECT COUNT(*) FROM pipeline_runs;'))).toBe(beforeRuns);
		expect(
			Number(db.runSql(`SELECT COUNT(*) FROM story_entities WHERE entity_id = ${sqlString(fixtures.mergeTargetId)};`)),
		).toBe(2);
		expect(
			Number(db.runSql(`SELECT COUNT(*) FROM story_entities WHERE entity_id = ${sqlString(fixtures.mergeSourceId)};`)),
		).toBe(0);
		expect(
			Number(
				db.runSql(
					`SELECT COUNT(*) FROM entity_edges WHERE source_entity_id = ${sqlString(fixtures.mergeSourceId)} OR target_entity_id = ${sqlString(fixtures.mergeSourceId)};`,
				),
			),
		).toBe(0);
		expect(
			Number(db.runSql(`SELECT COUNT(*) FROM entity_aliases WHERE entity_id = ${sqlString(fixtures.mergeTargetId)};`)),
		).toBe(2);
		expect(db.runSql(`SELECT canonical_id FROM entities WHERE id = ${sqlString(fixtures.mergeSourceId)};`)).toBe(
			fixtures.mergeTargetId,
		);
		expect(db.runSql(`SELECT taxonomy_status FROM entities WHERE id = ${sqlString(fixtures.mergeSourceId)};`)).toBe(
			'merged',
		);
	});

	it('QA-07: same-ID merges return a validation error', async () => {
		if (!pgAvailable) {
			return;
		}

		const response = await apiPost(
			app,
			'/api/entities/merge',
			{
				target_id: fixtures.mergeTargetId,
				source_id: fixtures.mergeTargetId,
			},
			'203.0.113.16',
		);

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			error: {
				code: 'VALIDATION_ERROR',
			},
		});
	});

	it('QA-08: already-merged source entities return a validation error', async () => {
		if (!pgAvailable) {
			return;
		}

		const response = await apiPost(
			app,
			'/api/entities/merge',
			{
				target_id: fixtures.mergeTargetId,
				source_id: fixtures.alreadyMergedEntityId,
			},
			'203.0.113.17',
		);

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			error: {
				code: 'VALIDATION_ERROR',
			},
		});
	});

	it('QA-09: the entity routes stay behind the existing auth middleware', async () => {
		if (!pgAvailable) {
			return;
		}

		const response = await app.request('http://localhost/api/entities', {
			method: 'GET',
		});

		expect(response.status).toBe(401);
		expect(await response.json()).toMatchObject({
			error: {
				code: 'AUTH_UNAUTHORIZED',
			},
		});
	});
});
