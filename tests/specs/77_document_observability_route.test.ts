import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as db from '../lib/db.js';
import { ensureSchema } from '../lib/schema.js';

const ROOT = resolve(import.meta.dirname, '../..');
const CORE_DIR = resolve(ROOT, 'packages/core');
const PIPELINE_DIR = resolve(ROOT, 'packages/pipeline');
const WORKER_DIR = resolve(ROOT, 'packages/worker');
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
}

interface SeededSource {
	id: string;
	storagePath: string;
}

interface FirestoreState {
	records: Map<string, Record<string, unknown>>;
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

function createFirestoreState(): FirestoreState {
	return {
		records: new Map(),
	};
}

function firestoreKey(collection: string, documentId: string): string {
	return `${collection}/${documentId}`;
}

function buildMockServices(state: FirestoreState) {
	return {
		storage: {
			upload: async () => {},
			download: async () => Buffer.from(''),
			exists: async () => false,
			list: async () => ({ paths: [] }),
			delete: async () => {},
		},
		documentAi: {
			processDocument: async () => ({ document: {}, pageImages: [] }),
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
			setDocument: async (collection: string, documentId: string, data: Record<string, unknown>) => {
				state.records.set(firestoreKey(collection, documentId), data);
			},
			getDocument: async (collection: string, documentId: string) => {
				return state.records.get(firestoreKey(collection, documentId)) ?? null;
			},
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

async function seedSource(
	pool: pg.Pool,
	input: {
		filename: string;
		pageCount?: number | null;
		status?: 'ingested' | 'extracted' | 'segmented' | 'enriched' | 'embedded' | 'graphed' | 'analyzed';
		createdAt?: string;
		updatedAt?: string;
	},
): Promise<SeededSource> {
	const id = randomUUID();
	const storagePath = `raw/${id}/${input.filename}`;
	const fileHash = `${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '')}`;
	await pool.query(
		[
			'INSERT INTO sources (id, filename, storage_path, file_hash, page_count, has_native_text, native_text_ratio, status, metadata, created_at, updated_at)',
			'VALUES ($1, $2, $3, $4, $5, FALSE, 0, $6, $7::jsonb, $8, $9)',
			'ON CONFLICT (id) DO UPDATE SET',
			'filename = EXCLUDED.filename,',
			'storage_path = EXCLUDED.storage_path,',
			'file_hash = EXCLUDED.file_hash,',
			'page_count = EXCLUDED.page_count,',
			'has_native_text = EXCLUDED.has_native_text,',
			'native_text_ratio = EXCLUDED.native_text_ratio,',
			'status = EXCLUDED.status,',
			'metadata = EXCLUDED.metadata,',
			'created_at = EXCLUDED.created_at,',
			'updated_at = EXCLUDED.updated_at',
		].join(' '),
		[
			id,
			input.filename,
			storagePath,
			fileHash,
			input.pageCount ?? null,
			input.status ?? 'ingested',
			JSON.stringify({}),
			input.createdAt ?? '2026-04-15T12:00:00.000Z',
			input.updatedAt ?? '2026-04-15T12:00:00.000Z',
		],
	);

	return {
		id,
		storagePath,
	};
}

async function seedStory(
	pool: pg.Pool,
	input: {
		sourceId: string;
		title: string;
		pageStart?: number | null;
		pageEnd?: number | null;
		status?: 'segmented' | 'enriched' | 'embedded' | 'graphed' | 'analyzed';
		createdAt?: string;
		updatedAt?: string;
	},
): Promise<string> {
	const id = randomUUID();
	await pool.query(
		[
			'INSERT INTO stories (id, source_id, title, subtitle, language, category, page_start, page_end, gcs_markdown_uri, gcs_metadata_uri, chunk_count, extraction_confidence, status, metadata, created_at, updated_at)',
			'VALUES ($1, $2, $3, NULL, NULL, NULL, $4, $5, $6, $7, 0, NULL, $8, $9::jsonb, $10, $11)',
			'ON CONFLICT (id) DO UPDATE SET',
			'title = EXCLUDED.title,',
			'page_start = EXCLUDED.page_start,',
			'page_end = EXCLUDED.page_end,',
			'gcs_markdown_uri = EXCLUDED.gcs_markdown_uri,',
			'gcs_metadata_uri = EXCLUDED.gcs_metadata_uri,',
			'chunk_count = EXCLUDED.chunk_count,',
			'extraction_confidence = EXCLUDED.extraction_confidence,',
			'status = EXCLUDED.status,',
			'metadata = EXCLUDED.metadata,',
			'created_at = EXCLUDED.created_at,',
			'updated_at = EXCLUDED.updated_at',
		].join(' '),
		[
			id,
			input.sourceId,
			input.title,
			input.pageStart ?? null,
			input.pageEnd ?? null,
			`segments/${input.sourceId}/${id}.md`,
			`segments/${input.sourceId}/${id}.meta.json`,
			input.status ?? 'segmented',
			JSON.stringify({}),
			input.createdAt ?? '2026-04-15T12:00:00.000Z',
			input.updatedAt ?? '2026-04-15T12:00:00.000Z',
		],
	);

	return id;
}

async function seedSourceStep(
	pool: pg.Pool,
	input: {
		sourceId: string;
		stepName: string;
		status: 'pending' | 'completed' | 'failed' | 'partial';
		completedAt?: string | null;
		errorMessage?: string | null;
	},
): Promise<void> {
	await pool.query(
		[
			'INSERT INTO source_steps (source_id, step_name, status, error_message, completed_at)',
			'VALUES ($1, $2, $3, $4, $5)',
			'ON CONFLICT (source_id, step_name) DO UPDATE SET',
			'status = EXCLUDED.status,',
			'error_message = EXCLUDED.error_message,',
			'completed_at = EXCLUDED.completed_at',
		].join(' '),
		[input.sourceId, input.stepName, input.status, input.errorMessage ?? null, input.completedAt ?? null],
	);
}

async function seedPipelineRun(
	pool: pg.Pool,
	input: {
		id: string;
		status: 'running' | 'completed' | 'partial' | 'failed';
		createdAt: string;
		finishedAt?: string | null;
	},
): Promise<void> {
	await pool.query(
		[
			'INSERT INTO pipeline_runs (id, tag, options, status, created_at, finished_at)',
			'VALUES ($1, NULL, $2::jsonb, $3, $4, $5)',
			'ON CONFLICT (id) DO UPDATE SET',
			'status = EXCLUDED.status,',
			'created_at = EXCLUDED.created_at,',
			'finished_at = EXCLUDED.finished_at',
		].join(' '),
		[input.id, JSON.stringify({}), input.status, input.createdAt, input.finishedAt ?? null],
	);
}

async function seedPipelineRunSource(
	pool: pg.Pool,
	input: {
		runId: string;
		sourceId: string;
		currentStep: string;
		status: 'pending' | 'processing' | 'completed' | 'failed';
		updatedAt: string;
		errorMessage?: string | null;
	},
): Promise<void> {
	await pool.query(
		[
			'INSERT INTO pipeline_run_sources (run_id, source_id, current_step, status, error_message, updated_at)',
			'VALUES ($1, $2, $3, $4, $5, $6)',
			'ON CONFLICT (run_id, source_id) DO UPDATE SET',
			'current_step = EXCLUDED.current_step,',
			'status = EXCLUDED.status,',
			'error_message = EXCLUDED.error_message,',
			'updated_at = EXCLUDED.updated_at',
		].join(' '),
		[input.runId, input.sourceId, input.currentStep, input.status, input.errorMessage ?? null, input.updatedAt],
	);
}

async function seedJob(
	pool: pg.Pool,
	input: {
		id: string;
		type?: string;
		status: 'pending' | 'running' | 'completed' | 'failed' | 'dead_letter';
		attempts: number;
		maxAttempts: number;
		createdAt: string;
		startedAt?: string | null;
		finishedAt?: string | null;
		errorLog?: string | null;
		payload: Record<string, unknown>;
	},
): Promise<void> {
	await pool.query(
		[
			'INSERT INTO jobs (id, type, payload, status, attempts, max_attempts, error_log, worker_id, created_at, started_at, finished_at)',
			'VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9, $10, $11)',
			'ON CONFLICT (id) DO UPDATE SET',
			'type = EXCLUDED.type,',
			'payload = EXCLUDED.payload,',
			'status = EXCLUDED.status,',
			'attempts = EXCLUDED.attempts,',
			'max_attempts = EXCLUDED.max_attempts,',
			'error_log = EXCLUDED.error_log,',
			'worker_id = EXCLUDED.worker_id,',
			'created_at = EXCLUDED.created_at,',
			'started_at = EXCLUDED.started_at,',
			'finished_at = EXCLUDED.finished_at',
		].join(' '),
		[
			input.id,
			input.type ?? 'pipeline_run',
			JSON.stringify(input.payload),
			input.status,
			input.attempts,
			input.maxAttempts,
			input.errorLog ?? null,
			'worker-1',
			input.createdAt,
			input.startedAt ?? null,
			input.finishedAt ?? null,
		],
	);
}

async function readJson(response: Response): Promise<unknown> {
	return await response.json();
}

describe('Spec 77 — Document Observability Aggregation Route', () => {
	const originalConfig = process.env.MULDER_CONFIG;
	const originalLogLevel = process.env.MULDER_LOG_LEVEL;
	let pool: pg.Pool;
	let app: ApiApp;
	let firestore: FirestoreState;

	beforeAll(async () => {
		db.requirePg();
		process.env.MULDER_CONFIG = EXAMPLE_CONFIG;
		process.env.MULDER_LOG_LEVEL = 'silent';

		ensureSchema();
		buildPackage(CORE_DIR);
		buildPackage(PIPELINE_DIR);
		buildPackage(WORKER_DIR);
		buildPackage(API_DIR);

		pool = new pg.Pool({
			host: db.TEST_PG_HOST,
			port: db.TEST_PG_PORT,
			user: db.TEST_PG_USER,
			password: db.TEST_PG_PASSWORD,
			database: db.TEST_PG_DATABASE,
		});

		firestore = createFirestoreState();
		mocks.getQueryPool.mockReturnValue(pool);
		mocks.createServiceRegistry.mockReturnValue(buildMockServices(firestore));

		app = await loadApiApp();
	}, 600000);

	beforeEach(async () => {
		firestore.records.clear();
		mocks.getQueryPool.mockClear();
		mocks.createServiceRegistry.mockClear();
		mocks.getQueryPool.mockReturnValue(pool);
		mocks.createServiceRegistry.mockReturnValue(buildMockServices(firestore));
	});

	afterAll(async () => {
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

	it('QA-01: unknown documents return the established not-found response', async () => {
		const id = randomUUID();
		const response = await app.request(`http://localhost/api/documents/${id}/observability`, {
			headers: authorizedHeaders(),
		});

		expect(response.status).toBe(404);
		expect(await readJson(response)).toEqual({
			error: {
				code: 'DOCUMENT_NOT_FOUND',
				message: `Document not found: ${id}`,
				details: {
					id,
				},
			},
		});
	});

	it('QA-02: missing projections still return authoritative SQL-backed observability', async () => {
		const source = await seedSource(pool, {
			filename: 'missing-projections.pdf',
			pageCount: 11,
			status: 'segmented',
		});
		await seedSourceStep(pool, {
			sourceId: source.id,
			stepName: 'extract',
			status: 'completed',
			completedAt: '2026-04-15T12:01:00.000Z',
		});
		await seedSourceStep(pool, {
			sourceId: source.id,
			stepName: 'segment',
			status: 'completed',
			completedAt: '2026-04-15T12:02:00.000Z',
		});
		const storyId = await seedStory(pool, {
			sourceId: source.id,
			title: 'Missing projections story',
			pageStart: 2,
			pageEnd: 4,
			status: 'segmented',
		});
		const runId = randomUUID();
		const jobId = randomUUID();
		await seedPipelineRun(pool, {
			id: runId,
			status: 'running',
			createdAt: '2026-04-15T12:00:00.000Z',
		});
		await seedPipelineRunSource(pool, {
			runId,
			sourceId: source.id,
			currentStep: 'segment',
			status: 'processing',
			updatedAt: '2026-04-15T12:02:05.000Z',
		});
		await seedJob(pool, {
			id: jobId,
			status: 'running',
			attempts: 1,
			maxAttempts: 3,
			createdAt: '2026-04-15T12:00:00.000Z',
			startedAt: '2026-04-15T12:00:02.000Z',
			payload: {
				sourceId: source.id,
				runId,
			},
		});

		const response = await app.request(`http://localhost/api/documents/${source.id}/observability`, {
			headers: authorizedHeaders(),
		});

		expect(response.status).toBe(200);
		expect(await readJson(response)).toMatchObject({
			data: {
				source: {
					id: source.id,
					filename: 'missing-projections.pdf',
					status: 'segmented',
					page_count: 11,
					steps: [
						{
							step: 'extract',
							status: 'completed',
							completed_at: '2026-04-15T12:01:00.000Z',
							error_message: null,
						},
						{
							step: 'segment',
							status: 'completed',
							completed_at: '2026-04-15T12:02:00.000Z',
							error_message: null,
						},
					],
					projection: null,
				},
				stories: [
					{
						id: storyId,
						title: 'Missing projections story',
						status: 'segmented',
						page_start: 2,
						page_end: 4,
						projection: null,
					},
				],
				job: {
					job_id: jobId,
					status: 'running',
					attempts: 1,
					max_attempts: 3,
					error_log: null,
					created_at: '2026-04-15T12:00:00.000Z',
					started_at: '2026-04-15T12:00:02.000Z',
					finished_at: null,
				},
				progress: {
					run_id: runId,
					run_status: 'running',
					current_step: 'segment',
					source_status: 'processing',
					updated_at: '2026-04-15T12:02:05.000Z',
					error_message: null,
				},
			},
		});
	});

	it('QA-02b: newest job metadata stays separate from newest persisted progress', async () => {
		const source = await seedSource(pool, {
			filename: 'job-without-progress.pdf',
			pageCount: 8,
			status: 'extracted',
		});
		await seedSourceStep(pool, {
			sourceId: source.id,
			stepName: 'extract',
			status: 'completed',
			completedAt: '2026-04-15T12:01:00.000Z',
		});
		const staleRunId = randomUUID();
		await seedPipelineRun(pool, {
			id: staleRunId,
			status: 'running',
			createdAt: '2026-04-15T11:59:00.000Z',
		});
		await seedPipelineRunSource(pool, {
			runId: staleRunId,
			sourceId: source.id,
			currentStep: 'graph',
			status: 'failed',
			updatedAt: '2026-04-15T12:09:00.000Z',
			errorMessage: 'stale progress from an older run',
		});
		const jobId = randomUUID();
		await seedJob(pool, {
			id: jobId,
			type: 'document_observability',
			status: 'running',
			attempts: 1,
			maxAttempts: 3,
			createdAt: '2026-04-15T12:00:00.000Z',
			startedAt: '2026-04-15T12:00:02.000Z',
			payload: {
				sourceId: source.id,
			},
		});

		const response = await app.request(`http://localhost/api/documents/${source.id}/observability`, {
			headers: authorizedHeaders(),
		});

		expect(response.status).toBe(200);
		const body = (await readJson(response)) as {
			data: {
				source: {
					id: string;
					steps: Array<{
						step: string;
						status: string;
						completed_at: string | null;
						error_message: string | null;
					}>;
				};
				job: {
					job_id: string;
					status: string;
					attempts: number;
					max_attempts: number;
					error_log: string | null;
					created_at: string;
					started_at: string | null;
					finished_at: string | null;
				};
				progress: {
					run_id: string;
					run_status: string;
					current_step: string;
					source_status: string;
					updated_at: string;
					error_message: string | null;
				};
				timeline: Array<{ event: string; occurred_at: string }>;
			};
		};
		expect(body).toMatchObject({
			data: {
				source: {
					id: source.id,
					steps: [
						{
							step: 'extract',
							status: 'completed',
							completed_at: '2026-04-15T12:01:00.000Z',
							error_message: null,
						},
					],
				},
				job: {
					job_id: jobId,
					status: 'running',
					attempts: 1,
					max_attempts: 3,
					error_log: null,
					created_at: '2026-04-15T12:00:00.000Z',
					started_at: '2026-04-15T12:00:02.000Z',
					finished_at: null,
				},
				progress: {
					run_id: staleRunId,
					run_status: 'running',
					current_step: 'graph',
					source_status: 'failed',
					updated_at: '2026-04-15T12:09:00.000Z',
					error_message: 'stale progress from an older run',
				},
				timeline: expect.arrayContaining([
					expect.objectContaining({ event: 'job.created' }),
					expect.objectContaining({ event: 'job.started' }),
					expect.objectContaining({ event: 'source_step.completed' }),
					expect.objectContaining({ event: 'run.progress' }),
				]),
			},
		});
		expect(body.data.job).not.toHaveProperty('run_id');
		expect(body.data.job).not.toHaveProperty('current_step');
		expect(body.data.job).not.toHaveProperty('source_status');
		expect(body.data.progress).toMatchObject({
			run_id: staleRunId,
			run_status: 'running',
			current_step: 'graph',
			source_status: 'failed',
			updated_at: '2026-04-15T12:09:00.000Z',
			error_message: 'stale progress from an older run',
		});
		expect(body.data.timeline.map((event) => event.event)).toEqual([
			'job.created',
			'job.started',
			'source_step.completed',
			'run.progress',
		]);
	});

	it('QA-03: partial observability states remain explicit', async () => {
		const source = await seedSource(pool, {
			filename: 'partial-observability.pdf',
			pageCount: 9,
			status: 'extracted',
		});
		await seedSourceStep(pool, {
			sourceId: source.id,
			stepName: 'extract',
			status: 'completed',
			completedAt: '2026-04-15T12:01:00.000Z',
		});
		await seedSourceStep(pool, {
			sourceId: source.id,
			stepName: 'segment',
			status: 'failed',
			errorMessage: 'segmentation timed out',
		});
		const storyA = await seedStory(pool, {
			sourceId: source.id,
			title: 'Projected story',
			pageStart: 1,
			pageEnd: 3,
			status: 'enriched',
		});
		const storyB = await seedStory(pool, {
			sourceId: source.id,
			title: 'Unprojected story',
			pageStart: 4,
			pageEnd: 6,
			status: 'segmented',
		});
		firestore.records.set(firestoreKey('documents', source.id), {
			status: 'extracted',
			extractedAt: '2026-04-15T12:01:30.000Z',
			pageCount: 9,
			storyCount: 2,
		});
		firestore.records.set(firestoreKey('stories', storyA), {
			status: 'enriched',
			enrichedAt: '2026-04-15T12:03:00.000Z',
			entitiesExtracted: 7,
		});

		const response = await app.request(`http://localhost/api/documents/${source.id}/observability`, {
			headers: authorizedHeaders(),
		});

		expect(response.status).toBe(200);
		expect(await readJson(response)).toMatchObject({
			data: {
				source: {
					projection: {
						status: 'extracted',
						extracted_at: '2026-04-15T12:01:30.000Z',
						segmented_at: null,
						page_count: 9,
						story_count: 2,
						vision_fallback_count: null,
						vision_fallback_capped: null,
					},
				},
				stories: [
					{
						id: storyA,
						projection: {
							status: 'enriched',
							enriched_at: '2026-04-15T12:03:00.000Z',
							embedded_at: null,
							graphed_at: null,
							entities_extracted: 7,
							chunks_created: null,
						},
					},
					{
						id: storyB,
						projection: null,
					},
				],
				job: null,
				progress: null,
			},
		});
	});

	it('QA-04/05/06: fully populated observability aggregates the persisted records and stays read-only', async () => {
		const source = await seedSource(pool, {
			filename: 'full-observability.pdf',
			pageCount: 12,
			status: 'segmented',
		});
		const storyA = await seedStory(pool, {
			sourceId: source.id,
			title: 'First full story',
			pageStart: 2,
			pageEnd: 5,
			status: 'embedded',
		});
		const storyB = await seedStory(pool, {
			sourceId: source.id,
			title: 'Second full story',
			pageStart: 6,
			pageEnd: 8,
			status: 'enriched',
		});
		await seedSourceStep(pool, {
			sourceId: source.id,
			stepName: 'extract',
			status: 'completed',
			completedAt: '2026-04-15T12:01:00.000Z',
		});
		await seedSourceStep(pool, {
			sourceId: source.id,
			stepName: 'segment',
			status: 'completed',
			completedAt: '2026-04-15T12:02:00.000Z',
		});
		await seedSourceStep(pool, {
			sourceId: source.id,
			stepName: 'enrich',
			status: 'failed',
			errorMessage: 'entity extraction interrupted',
		});
		const runId = randomUUID();
		const jobId = randomUUID();
		await seedPipelineRun(pool, {
			id: runId,
			status: 'running',
			createdAt: '2026-04-15T12:00:00.000Z',
		});
		await seedPipelineRunSource(pool, {
			runId,
			sourceId: source.id,
			currentStep: 'enrich',
			status: 'failed',
			updatedAt: '2026-04-15T12:03:05.000Z',
			errorMessage: 'entity extraction interrupted',
		});
		await seedJob(pool, {
			id: jobId,
			status: 'running',
			attempts: 1,
			maxAttempts: 3,
			createdAt: '2026-04-15T12:00:00.000Z',
			startedAt: '2026-04-15T12:00:03.000Z',
			payload: {
				sourceId: source.id,
				runId,
			},
		});
		firestore.records.set(firestoreKey('documents', source.id), {
			status: 'segmented',
			extractedAt: '2026-04-15T12:01:10.000Z',
			segmentedAt: '2026-04-15T12:02:30.000Z',
			pageCount: 12,
			storyCount: 2,
			visionFallbackCount: 1,
			visionFallbackCapped: false,
		});
		firestore.records.set(firestoreKey('stories', storyA), {
			status: 'embedded',
			enrichedAt: '2026-04-15T12:03:20.000Z',
			embeddedAt: '2026-04-15T12:04:00.000Z',
			graphedAt: '2026-04-15T12:05:00.000Z',
			entitiesExtracted: 9,
			chunksCreated: 4,
		});
		firestore.records.set(firestoreKey('stories', storyB), {
			status: 'enriched',
			enrichedAt: '2026-04-15T12:03:40.000Z',
			entitiesExtracted: 5,
		});

		const beforeCounts = await Promise.all([
			pool.query('SELECT COUNT(*) FROM jobs'),
			pool.query('SELECT COUNT(*) FROM pipeline_runs'),
			pool.query('SELECT COUNT(*) FROM pipeline_run_sources'),
			pool.query('SELECT COUNT(*) FROM source_steps'),
			pool.query('SELECT COUNT(*) FROM stories'),
		]);

		const response = await app.request(`http://localhost/api/documents/${source.id}/observability`, {
			headers: authorizedHeaders(),
		});

		expect(response.status).toBe(200);
		const body = (await readJson(response)) as {
			data: {
				source: { id: string; projection: Record<string, unknown> | null };
				stories: Array<{ id: string; projection: Record<string, unknown> | null }>;
				job: Record<string, unknown> | null;
				progress: Record<string, unknown> | null;
				timeline: Array<{ event: string; occurred_at: string }>;
			};
		};
		expect(body).toMatchObject({
			data: {
				source: {
					id: source.id,
					projection: {
						status: 'segmented',
						extracted_at: '2026-04-15T12:01:10.000Z',
						segmented_at: '2026-04-15T12:02:30.000Z',
						page_count: 12,
						story_count: 2,
						vision_fallback_count: 1,
						vision_fallback_capped: false,
					},
				},
				stories: [
					{
						id: storyA,
						projection: {
							status: 'embedded',
							enriched_at: '2026-04-15T12:03:20.000Z',
							embedded_at: '2026-04-15T12:04:00.000Z',
							graphed_at: '2026-04-15T12:05:00.000Z',
							entities_extracted: 9,
							chunks_created: 4,
						},
					},
					{
						id: storyB,
						projection: {
							status: 'enriched',
							enriched_at: '2026-04-15T12:03:40.000Z',
							embedded_at: null,
							graphed_at: null,
							entities_extracted: 5,
							chunks_created: null,
						},
					},
				],
				job: {
					job_id: jobId,
					status: 'running',
					attempts: 1,
					max_attempts: 3,
					error_log: null,
					created_at: '2026-04-15T12:00:00.000Z',
					started_at: '2026-04-15T12:00:03.000Z',
					finished_at: null,
				},
				progress: {
					run_id: runId,
					run_status: 'running',
					current_step: 'enrich',
					source_status: 'failed',
					updated_at: '2026-04-15T12:03:05.000Z',
					error_message: 'entity extraction interrupted',
				},
			},
		});

		const afterCounts = await Promise.all([
			pool.query('SELECT COUNT(*) FROM jobs'),
			pool.query('SELECT COUNT(*) FROM pipeline_runs'),
			pool.query('SELECT COUNT(*) FROM pipeline_run_sources'),
			pool.query('SELECT COUNT(*) FROM source_steps'),
			pool.query('SELECT COUNT(*) FROM stories'),
		]);
		expect(afterCounts.map((result) => result.rows[0].count)).toEqual(
			beforeCounts.map((result) => result.rows[0].count),
		);

		expect(body.data.timeline.map((event) => event.event)).toEqual([
			'job.created',
			'job.started',
			'source_step.completed',
			'source.projection.extracted',
			'source_step.completed',
			'source.projection.segmented',
			'run.progress',
			'source_step.failed',
			'story.projection.enriched',
			'story.projection.enriched',
			'story.projection.embedded',
			'story.projection.graphed',
		]);
		expect(body.data.timeline.map((event) => event.occurred_at)).toEqual([
			'2026-04-15T12:00:00.000Z',
			'2026-04-15T12:00:03.000Z',
			'2026-04-15T12:01:00.000Z',
			'2026-04-15T12:01:10.000Z',
			'2026-04-15T12:02:00.000Z',
			'2026-04-15T12:02:30.000Z',
			'2026-04-15T12:03:05.000Z',
			'2026-04-15T12:03:05.000Z',
			'2026-04-15T12:03:20.000Z',
			'2026-04-15T12:03:40.000Z',
			'2026-04-15T12:04:00.000Z',
			'2026-04-15T12:05:00.000Z',
		]);
	});

	it('QA-07: unauthenticated and malformed requests fail at the HTTP boundary', async () => {
		const documentId = randomUUID();

		const unauthenticatedResponse = await app.request(`http://localhost/api/documents/${documentId}/observability`);
		expect(unauthenticatedResponse.status).toBe(401);
		expect(await readJson(unauthenticatedResponse)).toEqual({
			error: {
				code: 'AUTH_UNAUTHORIZED',
				message: 'A valid API key is required',
			},
		});

		const malformedResponse = await app.request('http://localhost/api/documents/not-a-uuid/observability', {
			headers: authorizedHeaders(),
		});
		expect(malformedResponse.status).toBe(400);
		expect(await readJson(malformedResponse)).toMatchObject({
			error: {
				code: 'VALIDATION_ERROR',
				message: 'Invalid request',
			},
		});
	});
});
