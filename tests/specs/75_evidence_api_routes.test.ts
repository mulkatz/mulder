import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as db from '../lib/db.js';
import { ensureSchema, truncateMulderTables } from '../lib/schema.js';

const ROOT = resolve(import.meta.dirname, '../..');
const CORE_DIR = resolve(ROOT, 'packages/core');
const API_DIR = resolve(ROOT, 'apps/api');
const CORE_DIST = resolve(CORE_DIR, 'dist/index.js');
const API_APP_DIST = resolve(API_DIR, 'dist/app.js');
const EXAMPLE_CONFIG = resolve(ROOT, 'mulder.config.example.yaml');

interface ApiApp {
	request: (input: string | Request, init?: RequestInit) => Promise<Response>;
	fetch: (input: string | Request, init?: RequestInit) => Promise<Response>;
}

interface EvidenceFixtures {
	primaryEntityId: string;
	secondaryEntityId: string;
	unscoredEntityId: string;
	mergedEntityId: string;
	confirmedEdgeId: string;
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

function sqlUuidArray(values: string[]): string {
	return `ARRAY[${values.map((value) => sqlString(value)).join(', ')}]::uuid[]`;
}

function sqlJson(value: Record<string, unknown>): string {
	return `${sqlString(JSON.stringify(value))}::jsonb`;
}

function cleanState(): void {
	truncateMulderTables();
}

function seedSource(opts: { filename: string; reliabilityScore?: number | null; status?: string }): string {
	const id = randomUUID();
	const fileHash = `${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '')}`;
	const reliabilityScore =
		opts.reliabilityScore === undefined || opts.reliabilityScore === null ? 'NULL' : String(opts.reliabilityScore);
	db.runSql(
		[
			'INSERT INTO sources (id, filename, storage_path, file_hash, page_count, status, reliability_score, metadata)',
			`VALUES (${sqlString(id)}, ${sqlString(opts.filename)}, ${sqlString(`raw/${opts.filename}`)}, ${sqlString(fileHash)}, 1, ${sqlString(opts.status ?? 'analyzed')}, ${reliabilityScore}, '{}'::jsonb)`,
			'ON CONFLICT (id) DO NOTHING;',
		].join(' '),
	);
	return id;
}

function seedEntity(opts: {
	name: string;
	type: string;
	corroborationScore?: number | null;
	taxonomyStatus?: 'auto' | 'curated' | 'merged';
	canonicalId?: string | null;
}): string {
	const id = randomUUID();
	const corroborationScore =
		opts.corroborationScore === undefined || opts.corroborationScore === null
			? 'NULL'
			: String(opts.corroborationScore);
	const canonicalId =
		opts.canonicalId === undefined || opts.canonicalId === null ? 'NULL' : sqlString(opts.canonicalId);
	db.runSql(
		[
			'INSERT INTO entities (id, name, type, canonical_id, taxonomy_status, corroboration_score, source_count, attributes)',
			`VALUES (${sqlString(id)}, ${sqlString(opts.name)}, ${sqlString(opts.type)}, ${canonicalId}, ${sqlString(opts.taxonomyStatus ?? 'auto')}, ${corroborationScore}, 1, '{}'::jsonb)`,
			'ON CONFLICT (id) DO NOTHING;',
		].join(' '),
	);
	return id;
}

function seedEdge(opts: {
	sourceEntityId: string;
	targetEntityId: string;
	relationship: string;
	edgeType?:
		| 'RELATIONSHIP'
		| 'DUPLICATE_OF'
		| 'POTENTIAL_CONTRADICTION'
		| 'CONFIRMED_CONTRADICTION'
		| 'DISMISSED_CONTRADICTION';
	confidence?: number | null;
	analysis?: Record<string, unknown> | null;
	attributes?: Record<string, unknown>;
}): string {
	const id = randomUUID();
	const confidence = opts.confidence === undefined || opts.confidence === null ? 'NULL' : String(opts.confidence);
	const analysis = opts.analysis === undefined || opts.analysis === null ? 'NULL' : sqlJson(opts.analysis);
	const attributes = sqlJson(opts.attributes ?? {});
	db.runSql(
		[
			'INSERT INTO entity_edges (id, source_entity_id, target_entity_id, relationship, edge_type, confidence, analysis, attributes)',
			`VALUES (${sqlString(id)}, ${sqlString(opts.sourceEntityId)}, ${sqlString(opts.targetEntityId)}, ${sqlString(opts.relationship)}, ${sqlString(opts.edgeType ?? 'RELATIONSHIP')}, ${confidence}, ${analysis}, ${attributes})`,
			'ON CONFLICT DO NOTHING;',
		].join(' '),
	);
	return id;
}

function seedEvidenceChain(opts: {
	thesis: string;
	path: string[];
	strength: number;
	supports: boolean;
	computedAt: string;
}): string {
	const id = randomUUID();
	db.runSql(
		[
			'INSERT INTO evidence_chains (id, thesis, path, strength, supports, computed_at)',
			`VALUES (${sqlString(id)}, ${sqlString(opts.thesis)}, ${sqlUuidArray(opts.path)}, ${opts.strength}, ${opts.supports ? 'TRUE' : 'FALSE'}, ${sqlString(opts.computedAt)}::timestamptz)`,
			'ON CONFLICT DO NOTHING;',
		].join(' '),
	);
	return id;
}

function seedCluster(opts: {
	clusterType: 'temporal' | 'spatial' | 'spatio-temporal';
	centerLat?: number | null;
	centerLng?: number | null;
	timeStart?: string | null;
	timeEnd?: string | null;
	eventIds: string[];
	computedAt: string;
}): string {
	const id = randomUUID();
	const centerLat = opts.centerLat === undefined || opts.centerLat === null ? 'NULL' : String(opts.centerLat);
	const centerLng = opts.centerLng === undefined || opts.centerLng === null ? 'NULL' : String(opts.centerLng);
	const timeStart =
		opts.timeStart === undefined || opts.timeStart === null ? 'NULL' : `${sqlString(opts.timeStart)}::timestamptz`;
	const timeEnd =
		opts.timeEnd === undefined || opts.timeEnd === null ? 'NULL' : `${sqlString(opts.timeEnd)}::timestamptz`;
	db.runSql(
		[
			'INSERT INTO spatio_temporal_clusters (id, center_lat, center_lng, time_start, time_end, event_count, event_ids, cluster_type, computed_at)',
			`VALUES (${sqlString(id)}, ${centerLat}, ${centerLng}, ${timeStart}, ${timeEnd}, ${opts.eventIds.length}, ${sqlUuidArray(opts.eventIds)}, ${sqlString(opts.clusterType)}, ${sqlString(opts.computedAt)}::timestamptz)`,
			'ON CONFLICT DO NOTHING;',
		].join(' '),
	);
	return id;
}

function seedFixtures(): EvidenceFixtures {
	const primaryEntityId = seedEntity({
		name: 'Primary Entity',
		type: 'person',
		corroborationScore: 0.9,
		taxonomyStatus: 'curated',
	});
	const secondaryEntityId = seedEntity({
		name: 'Secondary Entity',
		type: 'person',
		corroborationScore: 0.6,
		taxonomyStatus: 'auto',
	});
	const unscoredEntityId = seedEntity({
		name: 'Unscored Entity',
		type: 'organization',
		corroborationScore: null,
		taxonomyStatus: 'auto',
	});
	const mergedEntityId = seedEntity({
		name: 'Merged Entity',
		type: 'organization',
		corroborationScore: 0.5,
		taxonomyStatus: 'merged',
	});

	seedSource({ filename: 'evidence-a.pdf', reliabilityScore: 0.82, status: 'analyzed' });
	seedSource({ filename: 'evidence-b.pdf', reliabilityScore: null, status: 'analyzed' });
	seedSource({ filename: 'evidence-c.pdf', reliabilityScore: 0.41, status: 'analyzed' });

	seedEdge({
		sourceEntityId: primaryEntityId,
		targetEntityId: secondaryEntityId,
		relationship: 'contradiction_status',
		edgeType: 'CONFIRMED_CONTRADICTION',
		confidence: 0.93,
		analysis: {
			verdict: 'confirmed',
			winning_claim: 'A',
			confidence: 0.93,
			explanation: 'The primary claim is supported by more reliable testimony.',
			attribute: 'status',
			valueA: 'active',
			valueB: 'inactive',
		},
		attributes: {
			attribute: 'status',
			valueA: 'active',
			valueB: 'inactive',
		},
	});
	seedEdge({
		sourceEntityId: secondaryEntityId,
		targetEntityId: unscoredEntityId,
		relationship: 'contradiction_status',
		edgeType: 'POTENTIAL_CONTRADICTION',
		confidence: 0.61,
		attributes: {
			attribute: 'location',
			valueA: 'Berlin',
			valueB: 'Munich',
		},
	});
	seedEdge({
		sourceEntityId: mergedEntityId,
		targetEntityId: primaryEntityId,
		relationship: 'contradiction_status',
		edgeType: 'DISMISSED_CONTRADICTION',
		confidence: 0.44,
		attributes: {
			attribute: 'date',
			valueA: '2024-01-01',
			valueB: '2024-01-02',
		},
	});
	seedEdge({
		sourceEntityId: primaryEntityId,
		targetEntityId: mergedEntityId,
		relationship: 'duplicate_of',
		edgeType: 'DUPLICATE_OF',
		confidence: 0.88,
	});

	seedEvidenceChain({
		thesis: 'The event was a coordinated surveillance test.',
		path: [primaryEntityId, secondaryEntityId],
		strength: 0.88,
		supports: true,
		computedAt: '2026-04-15T12:00:00.000Z',
	});
	seedEvidenceChain({
		thesis: 'The event was a coordinated surveillance test.',
		path: [secondaryEntityId, unscoredEntityId],
		strength: 0.71,
		supports: false,
		computedAt: '2026-04-15T12:05:00.000Z',
	});
	seedEvidenceChain({
		thesis: 'The witness account is internally consistent.',
		path: [primaryEntityId, mergedEntityId],
		strength: 0.66,
		supports: true,
		computedAt: '2026-04-15T12:10:00.000Z',
	});

	seedCluster({
		clusterType: 'spatio-temporal',
		centerLat: 52.52,
		centerLng: 13.405,
		timeStart: '2024-01-01T00:00:00.000Z',
		timeEnd: '2024-01-05T00:00:00.000Z',
		eventIds: [primaryEntityId, secondaryEntityId, unscoredEntityId],
		computedAt: '2026-04-15T12:15:00.000Z',
	});
	seedCluster({
		clusterType: 'temporal',
		timeStart: '2024-02-01T00:00:00.000Z',
		timeEnd: '2024-02-02T00:00:00.000Z',
		eventIds: [secondaryEntityId, unscoredEntityId],
		computedAt: '2026-04-15T12:20:00.000Z',
	});
	seedCluster({
		clusterType: 'spatial',
		centerLat: 48.137,
		centerLng: 11.575,
		eventIds: [primaryEntityId, mergedEntityId],
		computedAt: '2026-04-15T12:25:00.000Z',
	});

	return {
		primaryEntityId,
		secondaryEntityId,
		unscoredEntityId,
		mergedEntityId,
		confirmedEdgeId: seedEdge({
			sourceEntityId: secondaryEntityId,
			targetEntityId: primaryEntityId,
			relationship: 'contradiction_status',
			edgeType: 'CONFIRMED_CONTRADICTION',
			confidence: 0.79,
			analysis: {
				verdict: 'confirmed',
				winning_claim: 'B',
				confidence: 0.79,
				explanation: 'Alternative claim is better corroborated in the persisted snapshot.',
			},
			attributes: {
				attribute: 'status',
				valueA: 'open',
				valueB: 'closed',
			},
		}),
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

describe('Spec 75 — Evidence API Routes', () => {
	const originalConfig = process.env.MULDER_CONFIG;
	const originalLogLevel = process.env.MULDER_LOG_LEVEL;
	let app: ApiApp;
	let fixtures: EvidenceFixtures;
	let pgAvailable = false;

	beforeAll(async () => {
		pgAvailable = db.isPgAvailable();
		if (!pgAvailable) {
			return;
		}

		ensureSchema();
		process.env.MULDER_CONFIG = EXAMPLE_CONFIG;
		process.env.MULDER_LOG_LEVEL = 'silent';

		buildPackage(CORE_DIR);
		buildPackage(API_DIR);

		await import(pathToFileURL(CORE_DIST).href);
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

	it('QA-01: evidence routes require bearer authentication', async () => {
		if (!pgAvailable) {
			return;
		}

		const response = await app.request('http://localhost/api/evidence/summary');
		expect(response.status).toBe(401);
		expect(await response.json()).toMatchObject({
			error: {
				code: 'AUTH_UNAUTHORIZED',
			},
		});
	});

	it('QA-02: GET /api/evidence/summary aggregates persisted evidence state', async () => {
		if (!pgAvailable) {
			return;
		}

		const response = await apiGet(app, '/api/evidence/summary', '203.0.113.10');
		expect(response.status).toBe(200);

		const body = (await response.json()) as {
			data: {
				entities: {
					total: number;
					scored: number;
					avg_corroboration: number | null;
					corroboration_status: string;
				};
				contradictions: { potential: number; confirmed: number; dismissed: number };
				duplicates: { count: number };
				sources: { total: number; scored: number; data_reliability: string };
				evidence_chains: { thesis_count: number; record_count: number };
				clusters: { count: number };
			};
		};

		expect(body.data).toMatchObject({
			entities: {
				total: 4,
				scored: 0,
				avg_corroboration: null,
				corroboration_status: 'insufficient_data',
			},
			contradictions: {
				potential: 1,
				confirmed: 2,
				dismissed: 1,
			},
			duplicates: {
				count: 1,
			},
			sources: {
				total: 3,
				scored: 2,
				data_reliability: 'insufficient',
			},
			evidence_chains: {
				thesis_count: 2,
				record_count: 3,
			},
			clusters: {
				count: 3,
			},
		});
	});

	it('QA-03: GET /api/evidence/contradictions filters by status and preserves analysis payloads', async () => {
		if (!pgAvailable) {
			return;
		}

		const response = await apiGet(
			app,
			'/api/evidence/contradictions?status=confirmed&limit=20&offset=0',
			'203.0.113.11',
		);
		expect(response.status).toBe(200);

		const body = (await response.json()) as {
			data: Array<{
				id: string;
				source_entity_id: string;
				target_entity_id: string;
				edge_type: string;
				story_id: string | null;
				confidence: number | null;
				attributes: Record<string, string>;
				analysis: { verdict: string; winning_claim: string; confidence: number; explanation: string } | null;
			}>;
			meta: { count: number; limit: number; offset: number; status: string };
		};

		expect(body.meta).toEqual({
			count: 2,
			limit: 20,
			offset: 0,
			status: 'confirmed',
		});
		expect(body.data).toHaveLength(2);
		expect(body.data).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: expect.any(String),
					edge_type: 'CONFIRMED_CONTRADICTION',
					confidence: expect.any(Number),
					attributes: {
						attribute: 'status',
						valueA: 'active',
						valueB: 'inactive',
					},
					analysis: {
						verdict: 'confirmed',
						winning_claim: 'A',
						confidence: 0.93,
						explanation: 'The primary claim is supported by more reliable testimony.',
					},
				}),
				expect.objectContaining({
					edge_type: 'CONFIRMED_CONTRADICTION',
					analysis: {
						verdict: 'confirmed',
						winning_claim: 'B',
						confidence: 0.79,
						explanation: 'Alternative claim is better corroborated in the persisted snapshot.',
					},
				}),
			]),
		);
	});

	it('QA-04: GET /api/evidence/reliability/sources respects scored_only and pagination filters', async () => {
		if (!pgAvailable) {
			return;
		}

		const response = await apiGet(
			app,
			'/api/evidence/reliability/sources?scored_only=true&limit=1&offset=1',
			'203.0.113.12',
		);
		expect(response.status).toBe(200);

		const body = (await response.json()) as {
			data: Array<{
				id: string;
				filename: string;
				status: string;
				reliability_score: number | null;
				created_at: string;
				updated_at: string;
			}>;
			meta: { count: number; limit: number; offset: number; scored_only: boolean };
		};

		expect(body.meta).toEqual({
			count: 2,
			limit: 1,
			offset: 1,
			scored_only: true,
		});
		expect(body.data).toHaveLength(1);
		expect(body.data[0]).toMatchObject({
			status: 'analyzed',
			reliability_score: 0.82,
		});
	});

	it('QA-04b: malformed scored_only values are rejected at the HTTP edge', async () => {
		if (!pgAvailable) {
			return;
		}

		const response = await apiGet(app, '/api/evidence/reliability/sources?scored_only=maybe', '203.0.113.12');
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			error: {
				code: 'VALIDATION_ERROR',
				message: 'Invalid request',
			},
		});
	});

	it('QA-05: GET /api/evidence/chains groups persisted rows by thesis and returns empty snapshots for unknown theses', async () => {
		if (!pgAvailable) {
			return;
		}

		const groupedResponse = await apiGet(
			app,
			'/api/evidence/chains?thesis=The%20event%20was%20a%20coordinated%20surveillance%20test.',
			'203.0.113.13',
		);
		expect(groupedResponse.status).toBe(200);

		const groupedBody = (await groupedResponse.json()) as {
			data: Array<{
				thesis: string;
				chains: Array<{ id: string; path: string[]; supports: boolean; computed_at: string }>;
			}>;
			meta: { thesis_count: number; record_count: number };
		};

		expect(groupedBody.meta).toEqual({
			thesis_count: 1,
			record_count: 2,
		});
		expect(groupedBody.data).toHaveLength(1);
		expect(groupedBody.data[0]).toMatchObject({
			thesis: 'The event was a coordinated surveillance test.',
		});
		expect(groupedBody.data[0].chains).toHaveLength(2);

		const emptyResponse = await apiGet(app, '/api/evidence/chains?thesis=Missing%20thesis', '203.0.113.13');
		expect(emptyResponse.status).toBe(200);
		expect(await emptyResponse.json()).toMatchObject({
			data: [],
			meta: {
				thesis_count: 0,
				record_count: 0,
			},
		});
	});

	it('QA-06: GET /api/evidence/clusters filters persisted snapshots by cluster type', async () => {
		if (!pgAvailable) {
			return;
		}

		const response = await apiGet(app, '/api/evidence/clusters?cluster_type=spatio-temporal', '203.0.113.14');
		expect(response.status).toBe(200);

		const body = (await response.json()) as {
			data: Array<{
				id: string;
				cluster_type: string;
				center_lat: number | null;
				center_lng: number | null;
				time_start: string | null;
				time_end: string | null;
				event_count: number;
				event_ids: string[];
				computed_at: string;
			}>;
			meta: { count: number; cluster_type?: string };
		};

		expect(body.meta).toEqual({
			count: 1,
			cluster_type: 'spatio-temporal',
		});
		expect(body.data).toHaveLength(1);
		expect(body.data[0]).toMatchObject({
			cluster_type: 'spatio-temporal',
			event_count: 3,
			event_ids: expect.arrayContaining([
				fixtures.primaryEntityId,
				fixtures.secondaryEntityId,
				fixtures.unscoredEntityId,
			]),
		});
	});

	it('QA-07: empty datasets still return 200 with zero counts and empty arrays', async () => {
		if (!pgAvailable) {
			return;
		}

		cleanState();

		const summaryResponse = await apiGet(app, '/api/evidence/summary', '203.0.113.15');
		expect(summaryResponse.status).toBe(200);
		expect(await summaryResponse.json()).toMatchObject({
			data: {
				entities: {
					total: 0,
					scored: 0,
					avg_corroboration: null,
					corroboration_status: 'insufficient_data',
				},
				contradictions: {
					potential: 0,
					confirmed: 0,
					dismissed: 0,
				},
				duplicates: {
					count: 0,
				},
				sources: {
					total: 0,
					scored: 0,
					data_reliability: 'insufficient',
				},
				evidence_chains: {
					thesis_count: 0,
					record_count: 0,
				},
				clusters: {
					count: 0,
				},
			},
		});

		const chainsResponse = await apiGet(app, '/api/evidence/chains?thesis=Missing%20thesis', '203.0.113.15');
		expect(chainsResponse.status).toBe(200);
		expect(await chainsResponse.json()).toMatchObject({
			data: [],
			meta: {
				thesis_count: 0,
				record_count: 0,
			},
		});
	});
});
