import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { EmbeddingService, LlmService, Services } from '@mulder/core';
import type { HybridRetrievalResult } from '@mulder/retrieval';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as db from '../lib/db.js';

const ROOT = resolve(import.meta.dirname, '../..');
const CORE_DIR = resolve(ROOT, 'packages/core');
const RETRIEVAL_DIR = resolve(ROOT, 'packages/retrieval');
const API_DIR = resolve(ROOT, 'apps/api');
const CORE_DIST = resolve(CORE_DIR, 'dist/index.js');
const RETRIEVAL_DIST = resolve(RETRIEVAL_DIR, 'dist/index.js');
const API_APP_DIST = resolve(API_DIR, 'dist/app.js');
const EXAMPLE_CONFIG = resolve(ROOT, 'mulder.config.example.yaml');

const mocks = vi.hoisted(() => ({
	hybridRetrieve: vi.fn(),
	getQueryPool: vi.fn(),
	createServiceRegistry: vi.fn(),
}));

vi.mock('@mulder/retrieval', async () => {
	const actual = await vi.importActual<typeof import('@mulder/retrieval')>('@mulder/retrieval');
	return {
		...actual,
		hybridRetrieve: mocks.hybridRetrieve,
	};
});

vi.mock('@mulder/core', async () => {
	const actual = await vi.importActual<typeof import('@mulder/core')>('@mulder/core');
	return {
		...actual,
		getQueryPool: mocks.getQueryPool,
		createServiceRegistry: mocks.createServiceRegistry,
	};
});

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

function cleanState(): void {
	db.runSql('DELETE FROM pipeline_run_sources; DELETE FROM pipeline_runs; DELETE FROM jobs;');
}

function buildMockServices(): Services {
	const embedding: EmbeddingService = {
		embed: async () => [],
	};
	const llm: LlmService = {
		generateStructured: async <T>() => ({}) as T,
		generateText: async () => '',
		groundedGenerate: async () => ({
			text: '',
			groundingMetadata: {},
		}),
		countTokens: async () => 0,
	};

	return {
		storage: {
			upload: async () => {},
			createUploadSession: async () => ({
				url: '/api/uploads/documents/dev-upload?storage_path=raw/test/original.pdf',
				method: 'PUT',
				headers: {},
				transport: 'dev_proxy',
				expiresAt: null,
			}),
			download: async () => Buffer.alloc(0),
			getMetadata: async () => null,
			exists: async () => false,
			list: async () => ({ paths: [] }),
			delete: async () => {},
		},
		documentAi: {
			processDocument: async () => ({
				document: {},
				pageImages: [],
			}),
		},
		officeDocuments: {
			extractDocx: async () => ({
				markdown: '',
				extractionEngine: 'mammoth',
				messages: [],
			}),
		},
		spreadsheets: {
			extractSpreadsheet: async () => ({
				tabularFormat: 'csv',
				parserEngine: 'mulder-csv',
				delimiter: ',',
				sheets: [],
				sheetSummaries: [],
				warnings: [],
			}),
		},
		emails: {
			extractEmail: async () => ({
				emailFormat: 'eml',
				container: 'rfc822_mime',
				parserEngine: 'mailparser',
				headers: {
					messageId: null,
					threadId: '',
					subject: null,
					from: [],
					to: [],
					cc: [],
					bcc: [],
					replyTo: [],
					sentAt: null,
					inReplyTo: null,
					references: [],
				},
				bodyText: '',
				bodyHtmlText: null,
				attachments: [],
				warnings: [],
			}),
		},
		urls: {
			fetchUrl: async () => ({
				originalUrl: 'https://example.com/article',
				normalizedUrl: 'https://example.com/article',
				finalUrl: 'https://example.com/article',
				httpStatus: 200,
				headers: {},
				html: Buffer.from('<html><body></body></html>'),
				contentType: 'text/html',
				redirectCount: 0,
				fetchedAt: new Date(0).toISOString(),
				robots: {
					allowed: true,
					robotsUrl: 'https://example.com/robots.txt',
					matchedUserAgent: null,
					matchedRule: null,
				},
				snapshotEncoding: 'utf-8',
			}),
		},
		urlExtractors: {
			extractUrl: async () => ({
				title: 'Example Article',
				byline: null,
				excerpt: null,
				siteName: null,
				canonicalUrl: null,
				publishedTime: null,
				modifiedTime: null,
				markdown: '# Example Article\n',
				textLength: 15,
				parserEngine: 'mozilla-readability-jsdom-turndown',
				warnings: [],
				entityHints: [],
			}),
		},
		llm,
		embedding,
		firestore: {
			setDocument: async () => {},
			getDocument: async () => null,
		},
	};
}

function createHybridResult(overrides?: Partial<HybridRetrievalResult>): HybridRetrievalResult {
	return {
		query: 'ufo sighting',
		strategy: 'hybrid',
		topK: 10,
		results: [
			{
				chunkId: randomUUID(),
				storyId: randomUUID(),
				content: 'Observed lights moved silently across the sky before vanishing.',
				score: 0.82,
				rerankScore: 0.91,
				rank: 1,
				contributions: [
					{
						strategy: 'vector',
						rank: 1,
						score: 0.82,
					},
				],
				metadata: {},
			},
		],
		confidence: {
			corpus_size: 12,
			taxonomy_status: 'bootstrapping',
			corroboration_reliability: 'low',
			graph_density: 0.03,
			degraded: false,
			message: undefined,
		},
		explain: {
			counts: {
				vector: 20,
				fulltext: 8,
			},
			skipped: [],
			failures: {},
			seedEntityIds: [],
			contributions: [],
		},
		...overrides,
	};
}

function authorizedHeaders(ip: string): Record<string, string> {
	return {
		Authorization: 'Bearer test-api-key',
		'Content-Type': 'application/json',
		'X-Forwarded-For': ip,
	};
}

type ApiApp = {
	request: (input: string | Request, init?: RequestInit) => Promise<Response>;
	fetch: (input: string | Request, init?: RequestInit) => Promise<Response>;
};

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

describe('Spec 73 — Search API Routes', () => {
	const originalConfig = process.env.MULDER_CONFIG;
	const originalLogLevel = process.env.MULDER_LOG_LEVEL;
	let app: Awaited<ReturnType<typeof loadApiApp>>;
	let mockServices: Services;
	let mockPool: object;
	let currentHybridResult: HybridRetrievalResult;

	beforeAll(async () => {
		db.requirePg();
		process.env.MULDER_CONFIG = EXAMPLE_CONFIG;
		process.env.MULDER_LOG_LEVEL = 'silent';

		buildPackage(CORE_DIR);
		buildPackage(RETRIEVAL_DIR);
		buildPackage(API_DIR);

		await import(pathToFileURL(CORE_DIST).href);
		await import(pathToFileURL(RETRIEVAL_DIST).href);

		mockServices = buildMockServices();
		mockPool = {};
		mocks.getQueryPool.mockReturnValue(mockPool);
		mocks.createServiceRegistry.mockReturnValue(mockServices);

		currentHybridResult = createHybridResult();
		mocks.hybridRetrieve.mockImplementation(async () => currentHybridResult);

		app = await loadApiApp();
	}, 600000);

	beforeEach(() => {
		cleanState();
		currentHybridResult = createHybridResult();
		mocks.hybridRetrieve.mockClear();
		mocks.getQueryPool.mockClear();
		mocks.createServiceRegistry.mockClear();
		mocks.hybridRetrieve.mockImplementation(async () => currentHybridResult);
		mocks.getQueryPool.mockReturnValue(mockPool);
		mocks.createServiceRegistry.mockReturnValue(mockServices);
	});

	afterAll(() => {
		cleanState();
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

	it('QA-01: POST /api/search returns a synchronous retrieval response for an authenticated request', async () => {
		const response = await app.request('http://localhost/api/search', {
			method: 'POST',
			headers: authorizedHeaders('203.0.113.10'),
			body: JSON.stringify({
				query: 'ufo sighting',
				strategy: 'hybrid',
				top_k: 10,
				explain: false,
			}),
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			data: {
				query: 'ufo sighting',
				strategy: 'hybrid',
				top_k: 10,
				results: [
					{
						chunk_id: expect.any(String),
						story_id: expect.any(String),
						content: 'Observed lights moved silently across the sky before vanishing.',
						score: 0.82,
						rerank_score: 0.91,
						rank: 1,
						contributions: [
							{
								strategy: 'vector',
								rank: 1,
								score: 0.82,
							},
						],
						metadata: {},
					},
				],
				confidence: {
					corpus_size: 12,
					taxonomy_status: 'bootstrapping',
					corroboration_reliability: 'low',
					graph_density: 0.03,
					degraded: false,
					message: null,
				},
				explain: {
					counts: {
						vector: 20,
						fulltext: 8,
					},
					skipped: [],
					failures: {},
					seed_entity_ids: [],
					contributions: [],
				},
			},
		});
	});

	it('QA-02: malformed search requests fail at the HTTP edge', async () => {
		const invalidRequests = [
			{},
			{
				query: 'ufo sighting',
				strategy: 'bad-strategy',
			},
			{
				query: 'ufo sighting',
				top_k: 0,
			},
		];

		for (let index = 0; index < invalidRequests.length; index += 1) {
			const response = await app.request(`http://localhost/api/search?case=${index}`, {
				method: 'POST',
				headers: authorizedHeaders(`203.0.113.${20 + index}`),
				body: JSON.stringify(invalidRequests[index]),
			});

			expect(response.status).toBe(400);
			expect(mocks.hybridRetrieve).not.toHaveBeenCalled();
			expect(await response.json()).toMatchObject({
				error: {
					code: 'VALIDATION_ERROR',
					message: 'Invalid request',
				},
			});
		}
	});

	it('QA-03: the search route stays synchronous and read-only', async () => {
		const beforeJobs = Number(db.runSql('SELECT COUNT(*) FROM jobs;'));
		const beforeRuns = Number(db.runSql('SELECT COUNT(*) FROM pipeline_runs;'));

		const response = await app.request('http://localhost/api/search', {
			method: 'POST',
			headers: authorizedHeaders('203.0.113.30'),
			body: JSON.stringify({
				query: 'ufo sighting',
				strategy: 'hybrid',
				top_k: 10,
			}),
		});

		expect(response.status).toBe(200);
		expect(Number(db.runSql('SELECT COUNT(*) FROM jobs;'))).toBe(beforeJobs);
		expect(Number(db.runSql('SELECT COUNT(*) FROM pipeline_runs;'))).toBe(beforeRuns);
		expect(mocks.hybridRetrieve).toHaveBeenCalledTimes(1);
	});

	it('QA-04: no_rerank and rerank=false disable re-ranking for the request', async () => {
		const noRerankResponse = await app.request('http://localhost/api/search?no_rerank=true', {
			method: 'POST',
			headers: authorizedHeaders('203.0.113.40'),
			body: JSON.stringify({
				query: 'ufo sighting',
				strategy: 'hybrid',
				top_k: 10,
			}),
		});

		expect(noRerankResponse.status).toBe(200);
		expect(mocks.hybridRetrieve).toHaveBeenCalledTimes(1);
		expect(mocks.hybridRetrieve.mock.calls[0]?.[5]).toMatchObject({
			noRerank: true,
			strategy: 'hybrid',
			topK: 10,
		});

		mocks.hybridRetrieve.mockClear();

		const aliasResponse = await app.request('http://localhost/api/search?rerank=false', {
			method: 'POST',
			headers: authorizedHeaders('203.0.113.41'),
			body: JSON.stringify({
				query: 'ufo sighting',
				strategy: 'hybrid',
				top_k: 10,
			}),
		});

		expect(aliasResponse.status).toBe(200);
		expect(mocks.hybridRetrieve).toHaveBeenCalledTimes(1);
		expect(mocks.hybridRetrieve.mock.calls[0]?.[5]).toMatchObject({
			noRerank: true,
			strategy: 'hybrid',
			topK: 10,
		});
	});

	it('QA-05: explain mode exposes strategy provenance', async () => {
		currentHybridResult = createHybridResult({
			explain: {
				counts: {
					vector: 20,
					fulltext: 8,
				},
				skipped: [],
				failures: {},
				seedEntityIds: [randomUUID()],
				contributions: [
					{
						chunkId: randomUUID(),
						rerankScore: 0.91,
						rrfScore: 0.024,
						strategies: [
							{
								strategy: 'vector',
								rank: 1,
								score: 0.82,
							},
							{
								strategy: 'fulltext',
								rank: 2,
								score: 0.44,
							},
						],
					},
				],
			},
		});

		const response = await app.request('http://localhost/api/search', {
			method: 'POST',
			headers: authorizedHeaders('203.0.113.50'),
			body: JSON.stringify({
				query: 'ufo sighting',
				strategy: 'hybrid',
				top_k: 10,
				explain: true,
			}),
		});

		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body).toMatchObject({
			data: {
				explain: {
					counts: {
						vector: 20,
						fulltext: 8,
					},
					seed_entity_ids: [expect.any(String)],
					contributions: [
						{
							chunk_id: expect.any(String),
							rerank_score: 0.91,
							rrf_score: 0.024,
							strategies: [
								{
									strategy: 'vector',
									rank: 1,
									score: 0.82,
								},
								{
									strategy: 'fulltext',
									rank: 2,
									score: 0.44,
								},
							],
						},
					],
				},
			},
		});
	});

	it('QA-06: no-match searches remain successful and observable', async () => {
		currentHybridResult = createHybridResult({
			results: [],
			confidence: {
				corpus_size: 12,
				taxonomy_status: 'bootstrapping',
				corroboration_reliability: 'low',
				graph_density: 0.03,
				degraded: true,
				message: 'no_meaningful_matches',
			},
			explain: {
				counts: {},
				skipped: ['graph:no_seeds'],
				failures: {},
				seedEntityIds: [],
				contributions: [],
			},
		});

		const response = await app.request('http://localhost/api/search', {
			method: 'POST',
			headers: authorizedHeaders('203.0.113.60'),
			body: JSON.stringify({
				query: 'totally unmatched query',
				strategy: 'hybrid',
				top_k: 10,
			}),
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			data: {
				results: [],
				confidence: {
					degraded: true,
					message: 'no_meaningful_matches',
				},
				explain: {
					contributions: [],
					skipped: ['graph:no_seeds'],
				},
			},
		});
	});

	it('QA-07: the search route stays behind the existing auth middleware', async () => {
		const response = await app.request('http://localhost/api/search', {
			method: 'POST',
			body: JSON.stringify({
				query: 'ufo sighting',
				strategy: 'hybrid',
				top_k: 10,
			}),
		});

		expect(response.status).toBe(401);
		expect(mocks.hybridRetrieve).not.toHaveBeenCalled();
		expect(await response.json()).toMatchObject({
			error: {
				code: 'AUTH_UNAUTHORIZED',
				message: 'A valid API key is required',
			},
		});
	});

	it('QA-08: the API package compiles with the new search route surface', () => {
		expect(typeof app.request).toBe('function');
		expect(typeof app.fetch).toBe('function');
	});
});
