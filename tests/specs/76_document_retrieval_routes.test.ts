import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as db from '../lib/db.js';
import { ensureSchema, truncateMulderTables } from '../lib/schema.js';

const ROOT = resolve(import.meta.dirname, '../..');
const CORE_DIR = resolve(ROOT, 'packages/core');
const TAXONOMY_DIR = resolve(ROOT, 'packages/taxonomy');
const RETRIEVAL_DIR = resolve(ROOT, 'packages/retrieval');
const PIPELINE_DIR = resolve(ROOT, 'packages/pipeline');
const WORKER_DIR = resolve(ROOT, 'packages/worker');
const EVIDENCE_DIR = resolve(ROOT, 'packages/evidence');
const API_DIR = resolve(ROOT, 'apps/api');
const API_APP_DIST = resolve(API_DIR, 'dist/app.js');
const EXAMPLE_CONFIG = resolve(ROOT, 'mulder.config.example.yaml');

const mocks = vi.hoisted(() => ({
	getQueryPool: vi.fn(),
	createServiceRegistry: vi.fn(),
}));

vi.mock('@mulder/core', async () => {
	const actual = await vi.importActual<typeof import('@mulder/core')>('@mulder/core');
	return {
		...actual,
		getQueryPool: mocks.getQueryPool,
		createServiceRegistry: mocks.createServiceRegistry,
	};
});

interface ApiApp {
	request: (input: string | Request, init?: RequestInit) => Promise<Response>;
	fetch: (input: string | Request, init?: RequestInit) => Promise<Response>;
}

interface StorageState {
	objects: Map<string, Buffer>;
}

interface SeededSource {
	id: string;
	storagePath: string;
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

function authorizedHeaders(ip = '203.0.113.10'): Record<string, string> {
	return {
		Authorization: 'Bearer test-api-key',
		'X-Forwarded-For': ip,
	};
}

function createStorageState(): StorageState {
	return {
		objects: new Map<string, Buffer>(),
	};
}

function putStorageObject(state: StorageState, path: string, content: Buffer | string): void {
	state.objects.set(path, Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf-8'));
}

function buildMockServices(state: StorageState) {
	return {
		storage: {
			upload: async (path: string, content: Buffer | string) => {
				putStorageObject(state, path, content);
			},
			createUploadSession: async (path: string) => ({
				url: `/api/uploads/documents/dev-upload?storage_path=${encodeURIComponent(path)}`,
				method: 'PUT',
				headers: {},
				transport: 'dev_proxy',
				expiresAt: null,
			}),
			download: async (path: string) => {
				const value = state.objects.get(path);
				if (!value) {
					throw new Error(`Storage object not found: ${path}`);
				}
				return value;
			},
			getMetadata: async (path: string) => {
				const value = state.objects.get(path);
				return value
					? {
							sizeBytes: value.byteLength,
							contentType: path.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream',
						}
					: null;
			},
			exists: async (path: string) => state.objects.has(path),
			list: async (prefix: string) => ({
				paths: [...state.objects.keys()].filter((path) => path.startsWith(prefix)).sort(),
			}),
			delete: async (path: string) => {
				state.objects.delete(path);
			},
		},
		documentAi: {
			processDocument: async () => ({
				document: {},
				pageImages: [],
			}),
		},
		llm: {
			generateStructured: async () => {
				throw new Error('generateStructured is not used in this test');
			},
			generateText: async () => '',
			groundedGenerate: async () => {
				throw new Error('groundedGenerate is not used in this test');
			},
			countTokens: async () => 0,
		},
		embedding: {
			embed: async () => [],
		},
		firestore: {
			setDocument: async () => {},
			getDocument: async () => null,
		},
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
			},
			rate_limiting: {
				enabled: true,
			},
			explorer: {
				enabled: false,
			},
		},
	});
}

function seedSource(
	pool: pg.Pool,
	input: {
		filename: string;
		fileHash?: string;
		pageCount?: number | null;
		hasNativeText?: boolean;
		nativeTextRatio?: number;
		status?: 'ingested' | 'extracted' | 'segmented' | 'enriched' | 'embedded' | 'graphed' | 'analyzed';
		storagePath?: string;
	},
): Promise<SeededSource> {
	const id = randomUUID();
	const fileHash = input.fileHash ?? randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
	const storagePath = input.storagePath ?? `raw/${id}/${input.filename}`;
	return pool
		.query(
			[
				'INSERT INTO sources (id, filename, storage_path, file_hash, page_count, has_native_text, native_text_ratio, status, metadata)',
				'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)',
			].join(' '),
			[
				id,
				input.filename,
				storagePath,
				fileHash,
				input.pageCount ?? null,
				input.hasNativeText ?? false,
				input.nativeTextRatio ?? 0,
				input.status ?? 'ingested',
				JSON.stringify({}),
			],
		)
		.then(() => ({
			id,
			storagePath,
		}));
}

async function readJson(response: Response): Promise<unknown> {
	return await response.json();
}

async function responseBytes(response: Response): Promise<Buffer> {
	return Buffer.from(await response.arrayBuffer());
}

describe('Spec 76 — Document Retrieval Routes', () => {
	const originalConfig = process.env.MULDER_CONFIG;
	const originalLogLevel = process.env.MULDER_LOG_LEVEL;
	let pool: pg.Pool;
	let app: ApiApp;
	let storageState: StorageState;
	let sourceA: SeededSource;
	let sourceB: SeededSource;
	let sourceC: SeededSource;
	const rawPdf = Buffer.from('%PDF-1.4\ncase file pdf\n%%EOF', 'utf-8');
	const layoutMarkdown = Buffer.from('# Case File\n\nDerived layout markdown.\n', 'utf-8');
	const pageOne = Buffer.from('page-one-bytes', 'utf-8');
	const pageTwo = Buffer.from('page-two-bytes', 'utf-8');

	beforeAll(async () => {
		db.requirePg();
		process.env.MULDER_CONFIG = EXAMPLE_CONFIG;
		process.env.MULDER_LOG_LEVEL = 'silent';

		ensureSchema();
		buildPackage(CORE_DIR);
		buildPackage(TAXONOMY_DIR);
		buildPackage(RETRIEVAL_DIR);
		buildPackage(PIPELINE_DIR);
		buildPackage(WORKER_DIR);
		buildPackage(EVIDENCE_DIR);
		buildPackage(API_DIR);

		pool = new pg.Pool({
			host: db.TEST_PG_HOST,
			port: db.TEST_PG_PORT,
			user: db.TEST_PG_USER,
			password: db.TEST_PG_PASSWORD,
			database: db.TEST_PG_DATABASE,
		});

		storageState = createStorageState();
		mocks.getQueryPool.mockReturnValue(pool);
		mocks.createServiceRegistry.mockReturnValue(buildMockServices(storageState));

		app = await loadApiApp();
	}, 600000);

	beforeEach(async () => {
		truncateMulderTables();
		storageState.objects.clear();
		mocks.getQueryPool.mockClear();
		mocks.createServiceRegistry.mockClear();
		mocks.getQueryPool.mockReturnValue(pool);
		mocks.createServiceRegistry.mockReturnValue(buildMockServices(storageState));

		sourceA = await seedSource(pool, {
			filename: 'case-file.pdf',
			pageCount: 12,
			hasNativeText: true,
			nativeTextRatio: 0.94,
			status: 'extracted',
		});
		sourceB = await seedSource(pool, {
			filename: 'missing-layout.pdf',
			pageCount: 3,
			hasNativeText: false,
			nativeTextRatio: 0.1,
			status: 'extracted',
		});
		sourceC = await seedSource(pool, {
			filename: 'missing-pdf.pdf',
			pageCount: 1,
			hasNativeText: false,
			nativeTextRatio: 0,
			status: 'extracted',
		});

		putStorageObject(storageState, sourceA.storagePath, rawPdf);
		putStorageObject(storageState, `extracted/${sourceA.id}/layout.md`, layoutMarkdown);
		putStorageObject(storageState, `extracted/${sourceA.id}/pages/page-001.png`, pageOne);
		putStorageObject(storageState, `extracted/${sourceA.id}/pages/page-002.png`, pageTwo);
		putStorageObject(storageState, sourceB.storagePath, Buffer.from('raw-only', 'utf-8'));
	}, 600000);

	afterAll(async () => {
		truncateMulderTables();
		await pool?.end();
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

	it('QA-01: GET /api/documents returns viewer-ready metadata with search and status filtering', async () => {
		const response = await app.request('http://localhost/api/documents?status=extracted&search=case', {
			headers: authorizedHeaders(),
		});

		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toContain('application/json');

		expect(await readJson(response)).toEqual({
			data: [
				{
					id: sourceA.id,
					filename: 'case-file.pdf',
					status: 'extracted',
					page_count: 12,
					has_native_text: true,
					layout_available: true,
					page_image_count: 2,
					created_at: expect.any(String),
					updated_at: expect.any(String),
					links: {
						pdf: `/api/documents/${sourceA.id}/pdf`,
						layout: `/api/documents/${sourceA.id}/layout`,
						pages: `/api/documents/${sourceA.id}/pages`,
					},
				},
			],
			meta: {
				count: 1,
				limit: 20,
				offset: 0,
			},
		});

		const counts = await Promise.all([
			pool.query('SELECT COUNT(*) FROM jobs'),
			pool.query('SELECT COUNT(*) FROM pipeline_runs'),
			pool.query('SELECT COUNT(*) FROM pipeline_run_sources'),
		]);
		expect(counts.map((result) => Number.parseInt(result.rows[0].count, 10))).toEqual([0, 0, 0]);
	});

	it('QA-02: PDF, layout, and page-image routes stream exact artifact bytes and content types', async () => {
		const pdfResponse = await app.request(`http://localhost/api/documents/${sourceA.id}/pdf`, {
			headers: authorizedHeaders(),
		});
		expect(pdfResponse.status).toBe(200);
		expect(pdfResponse.headers.get('content-type')).toBe('application/pdf');
		expect(pdfResponse.headers.get('content-disposition')).toBe(`inline; filename="case-file.pdf"`);
		expect(await responseBytes(pdfResponse)).toEqual(rawPdf);

		const layoutResponse = await app.request(`http://localhost/api/documents/${sourceA.id}/layout`, {
			headers: authorizedHeaders(),
		});
		expect(layoutResponse.status).toBe(200);
		expect(layoutResponse.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
		expect(await responseBytes(layoutResponse)).toEqual(layoutMarkdown);

		const pageResponse = await app.request(`http://localhost/api/documents/${sourceA.id}/pages/2`, {
			headers: authorizedHeaders(),
		});
		expect(pageResponse.status).toBe(200);
		expect(pageResponse.headers.get('content-type')).toBe('image/png');
		expect(await responseBytes(pageResponse)).toEqual(pageTwo);
	});

	it('QA-03: page listing reflects stored images and empty extracted folders', async () => {
		const pageListResponse = await app.request(`http://localhost/api/documents/${sourceA.id}/pages`, {
			headers: authorizedHeaders(),
		});

		expect(pageListResponse.status).toBe(200);
		expect(await readJson(pageListResponse)).toEqual({
			data: {
				source_id: sourceA.id,
				pages: [
					{
						page_number: 1,
						image_url: `/api/documents/${sourceA.id}/pages/1`,
					},
					{
						page_number: 2,
						image_url: `/api/documents/${sourceA.id}/pages/2`,
					},
				],
			},
			meta: {
				count: 2,
			},
		});

		const emptyPageListResponse = await app.request(`http://localhost/api/documents/${sourceB.id}/pages`, {
			headers: authorizedHeaders(),
		});

		expect(emptyPageListResponse.status).toBe(200);
		expect(await readJson(emptyPageListResponse)).toEqual({
			data: {
				source_id: sourceB.id,
				pages: [],
			},
			meta: {
				count: 0,
			},
		});
	});

	it('QA-04: missing artifacts, auth protection, and malformed page input fail at the edge', async () => {
		const missingPdfResponse = await app.request(`http://localhost/api/documents/${sourceC.id}/pdf`, {
			headers: authorizedHeaders(),
		});
		expect(missingPdfResponse.status).toBe(404);
		expect(await readJson(missingPdfResponse)).toEqual({
			error: {
				code: 'DOCUMENT_NOT_FOUND',
				message: `PDF not found for document ${sourceC.id}`,
				details: {
					source_id: sourceC.id,
					artifact_kind: 'pdf',
					storage_path: sourceC.storagePath,
				},
			},
		});

		const missingLayoutResponse = await app.request(`http://localhost/api/documents/${sourceB.id}/layout`, {
			headers: authorizedHeaders(),
		});
		expect(missingLayoutResponse.status).toBe(404);
		expect(await readJson(missingLayoutResponse)).toEqual({
			error: {
				code: 'DOCUMENT_NOT_FOUND',
				message: `layout.md not found for document ${sourceB.id}`,
				details: {
					source_id: sourceB.id,
					artifact_kind: 'layout',
					storage_path: `extracted/${sourceB.id}/layout.md`,
				},
			},
		});

		const missingPageResponse = await app.request(`http://localhost/api/documents/${sourceB.id}/pages/1`, {
			headers: authorizedHeaders(),
		});
		expect(missingPageResponse.status).toBe(404);
		expect(await readJson(missingPageResponse)).toEqual({
			error: {
				code: 'DOCUMENT_NOT_FOUND',
				message: `page 1 not found for document ${sourceB.id}`,
				details: {
					source_id: sourceB.id,
					artifact_kind: 'page_image',
					storage_path: `extracted/${sourceB.id}/pages/page-001.png`,
				},
			},
		});

		const unauthenticatedResponse = await app.request('http://localhost/api/documents');
		expect(unauthenticatedResponse.status).toBe(401);
		expect(await readJson(unauthenticatedResponse)).toEqual({
			error: {
				code: 'AUTH_UNAUTHORIZED',
				message: 'A valid API key is required',
			},
		});

		const malformedPageResponse = await app.request(`http://localhost/api/documents/${randomUUID()}/pages/0`, {
			headers: authorizedHeaders(),
		});
		expect(malformedPageResponse.status).toBe(400);
		expect(await readJson(malformedPageResponse)).toMatchObject({
			error: {
				code: 'VALIDATION_ERROR',
				message: 'Invalid request',
			},
		});
	});
});
