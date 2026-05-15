import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { WorkerRuntimeContext } from '@mulder/worker';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as db from '../lib/db.js';
import { testStoragePath } from '../lib/storage.js';

const ROOT = resolve(import.meta.dirname, '../..');
const CORE_DIR = resolve(ROOT, 'packages/core');
const PIPELINE_DIR = resolve(ROOT, 'packages/pipeline');
const WORKER_DIR = resolve(ROOT, 'packages/worker');
const API_DIR = resolve(ROOT, 'apps/api');
const CLI_DIR = resolve(ROOT, 'apps/cli');

const CORE_DIST = resolve(CORE_DIR, 'dist/index.js');
const WORKER_DIST = resolve(WORKER_DIR, 'dist/index.js');
const API_APP_DIST = resolve(API_DIR, 'dist/app.js');
const CLI_DIST = resolve(CLI_DIR, 'dist/index.js');
const EXAMPLE_CONFIG = resolve(ROOT, 'mulder.config.example.yaml');
const STORAGE_DIR = testStoragePath();
const BLOBS_STORAGE_DIR = resolve(STORAGE_DIR, 'blobs');
const RAW_STORAGE_DIR = resolve(STORAGE_DIR, 'raw');
const FIXTURE_PDF = resolve(ROOT, 'fixtures/raw/native-text-sample.pdf');
const MAX_BODY_BYTES = 10 * 1024 * 1024;
const SESSION_SECRET = 'test-session-secret';

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

function runCli(args: string[], opts?: { timeout?: number }): { stdout: string; stderr: string; exitCode: number } {
	const result = spawnSync('node', [CLI_DIST, ...args], {
		cwd: ROOT,
		encoding: 'utf-8',
		timeout: opts?.timeout ?? 180_000,
		stdio: ['pipe', 'pipe', 'pipe'],
		env: {
			...process.env,
			PGPASSWORD: db.TEST_PG_PASSWORD,
			MULDER_LOG_LEVEL: 'silent',
		},
	});

	return {
		stdout: result.stdout ?? '',
		stderr: result.stderr ?? '',
		exitCode: result.status ?? 1,
	};
}

function cleanState(): void {
	db.runSql(
		[
			'DELETE FROM jobs',
			'DELETE FROM api_sessions',
			'DELETE FROM api_users',
			'DELETE FROM pipeline_run_sources',
			'DELETE FROM pipeline_runs',
			'DELETE FROM source_steps',
			'DELETE FROM chunks',
			'DELETE FROM story_entities',
			'DELETE FROM entity_edges',
			'DELETE FROM entity_aliases',
			'DELETE FROM entities',
			'DELETE FROM stories',
			'DELETE FROM sources',
			'DELETE FROM document_blobs',
		].join('; '),
	);
}

function cleanStorageDir(dir: string): void {
	if (!existsSync(dir)) {
		return;
	}

	for (const entry of readdirSync(dir)) {
		rmSync(join(dir, entry), { recursive: true, force: true });
	}
}

function cleanUploadStorage(): void {
	cleanStorageDir(RAW_STORAGE_DIR);
	cleanStorageDir(BLOBS_STORAGE_DIR);
}

function writeUploadedObject(sourceId: string, content: Buffer): string {
	const dir = join(RAW_STORAGE_DIR, sourceId);
	mkdirSync(dir, { recursive: true });
	const storagePath = join(dir, 'original.pdf');
	writeFileSync(storagePath, content);
	return storagePath;
}

function expectedBlobPath(content: Buffer, extension: string): string {
	const contentHash = createHash('sha256').update(content).digest('hex');
	return `blobs/sha256/${contentHash.slice(0, 2)}/${contentHash.slice(2, 4)}/${contentHash}.${extension}`;
}

async function loadApiApp(): Promise<{ request: (input: string | Request, init?: RequestInit) => Promise<Response> }> {
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

type ApiApp = Awaited<ReturnType<typeof loadApiApp>>;

async function apiPost(app: ApiApp, path: string, body: unknown): Promise<Response> {
	return await app.request(`http://localhost${path}`, {
		method: 'POST',
		headers: {
			Authorization: 'Bearer test-api-key',
			'Content-Type': 'application/json',
			'X-Forwarded-For': '203.0.113.10',
		},
		body: JSON.stringify(body),
	});
}

async function apiPut(
	app: ApiApp,
	path: string,
	body: Buffer,
	contentType = 'application/octet-stream',
): Promise<Response> {
	return await app.request(`http://localhost${path}`, {
		method: 'PUT',
		headers: {
			Authorization: 'Bearer test-api-key',
			'Content-Type': contentType,
			'X-Forwarded-For': '203.0.113.10',
		},
		body,
	});
}

async function apiGet(
	app: ApiApp,
	path: string,
	headers: Record<string, string> = {
		Authorization: 'Bearer test-api-key',
		'X-Forwarded-For': '203.0.113.10',
	},
): Promise<Response> {
	return await app.request(`http://localhost${path}`, {
		method: 'GET',
		headers,
	});
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
	return (await response.json()) as Record<string, unknown>;
}

function readJsonCell(sql: string): Record<string, unknown> {
	return JSON.parse(db.runSql(sql)) as Record<string, unknown>;
}

function hashSessionToken(token: string): string {
	return createHash('sha256').update(`${SESSION_SECRET}:${token}`).digest('hex');
}

function seedSession(role: 'member' | 'admin' = 'member'): { cookie: string; userId: string } {
	const userId = randomUUID();
	const token = `${role}-${randomUUID()}`;
	db.runSql(
		[
			'INSERT INTO api_users (id, email, password_hash, role)',
			`VALUES ('${userId}', '${role}-${randomUUID()}@example.test', 'test-hash', '${role}');`,
			'INSERT INTO api_sessions (user_id, token_hash, expires_at)',
			`VALUES ('${userId}', '${hashSessionToken(token)}', now() + interval '1 hour');`,
		].join(' '),
	);
	return { cookie: `mulder_session=${token}`, userId };
}

function sessionHeaders(session: { cookie: string }): Record<string, string> {
	return {
		Cookie: session.cookie,
		'X-Forwarded-For': '203.0.113.10',
	};
}

async function sessionPost(app: ApiApp, session: { cookie: string }, path: string, body: unknown): Promise<Response> {
	return await app.request(`http://localhost${path}`, {
		method: 'POST',
		headers: {
			...sessionHeaders(session),
			'Content-Type': 'application/json',
		},
		body: JSON.stringify(body),
	});
}

function insertJob(input: {
	id: string;
	type: string;
	status: 'pending' | 'running' | 'completed' | 'failed' | 'dead_letter';
	attempts: number;
	maxAttempts: number;
	payload: Record<string, unknown>;
	errorLog?: string | null;
	workerId?: string | null;
}): void {
	db.runSql(
		[
			'INSERT INTO jobs (id, type, payload, status, attempts, max_attempts, error_log, worker_id)',
			`VALUES ('${input.id}', '${input.type}', '${JSON.stringify(input.payload)}'::jsonb, '${input.status}', ${input.attempts}, ${input.maxAttempts},`,
			input.errorLog === undefined || input.errorLog === null ? 'NULL' : `'${input.errorLog}'`,
			`, ${input.workerId === undefined || input.workerId === null ? 'NULL' : `'${input.workerId}'`})`,
		].join(' '),
	);
}

async function processOneJob(context: WorkerRuntimeContext, workerModule: typeof import('@mulder/worker')) {
	return await workerModule.processNextJob(context, 'spec-77-worker');
}

describe('Spec 77 — Large PDF Browser Upload Flow', () => {
	let app: ApiApp;
	let coreModule: typeof import('@mulder/core');
	let workerModule: typeof import('@mulder/worker');
	let workerContext: WorkerRuntimeContext;
	let fixturePdf: Buffer;

	beforeAll(async () => {
		db.requirePg();
		process.env.MULDER_CONFIG = EXAMPLE_CONFIG;
		process.env.MULDER_LOG_LEVEL = 'silent';
		process.env.NODE_ENV = 'test';

		buildPackage(CORE_DIR);
		buildPackage(PIPELINE_DIR);
		buildPackage(WORKER_DIR);
		buildPackage(API_DIR);
		buildPackage(CLI_DIR);

		const migrate = runCli(['db', 'migrate', EXAMPLE_CONFIG], { timeout: 300_000 });
		expect(migrate.exitCode).toBe(0);

		coreModule = await import(pathToFileURL(CORE_DIST).href);
		workerModule = await import(pathToFileURL(WORKER_DIST).href);
		app = await loadApiApp();
		fixturePdf = readFileSync(FIXTURE_PDF);

		const config = coreModule.loadConfig(EXAMPLE_CONFIG);
		const logger = coreModule.createLogger({ level: 'silent' });
		const cloudSqlConfig = config.gcp?.cloud_sql;
		if (!cloudSqlConfig) {
			throw new Error('Expected example config to include gcp.cloud_sql');
		}
		workerContext = {
			config,
			services: coreModule.createServiceRegistry(config, logger),
			pool: coreModule.getWorkerPool(cloudSqlConfig),
			logger,
		};
	}, 600000);

	beforeEach(() => {
		cleanState();
		cleanUploadStorage();
	});

	afterAll(() => {
		try {
			cleanState();
			cleanUploadStorage();
		} catch {
			// Ignore cleanup failures.
		}
	});

	it('QA-01: initiate accepts large declared uploads without tripping the API body limit', async () => {
		const beforeJobs = Number(db.runSql('SELECT COUNT(*) FROM jobs;'));
		const response = await apiPost(app, '/api/uploads/documents/initiate', {
			filename: 'large-research-file.pdf',
			size_bytes: 12 * 1024 * 1024,
			content_type: 'application/pdf',
		});

		expect(response.status).toBe(201);
		const body = await readJson(response);
		expect(body).toMatchObject({
			data: {
				source_id: expect.any(String),
				storage_path: expect.stringMatching(/^raw\/[0-9a-f-]+\/original\.pdf$/i),
				upload: {
					method: 'PUT',
					transport: expect.stringMatching(/^(gcs_resumable|dev_proxy)$/),
				},
				limits: {
					max_bytes: 100 * 1024 * 1024,
				},
			},
		});
		expect(Number(db.runSql('SELECT COUNT(*) FROM jobs;'))).toBe(beforeJobs);
	});

	it('QA-01b: dev upload proxy accepts payloads above the normal API body limit', async () => {
		const storagePath = 'raw/dev-large-upload/original.pdf';
		const oversizedBody = Buffer.alloc(MAX_BODY_BYTES + 1, 0x20);
		const response = await apiPut(
			app,
			`/api/uploads/documents/dev-upload?storage_path=${encodeURIComponent(storagePath)}`,
			oversizedBody,
			'application/pdf',
		);

		expect(response.status).toBe(204);
		expect(existsSync(resolve(STORAGE_DIR, storagePath))).toBe(true);
		expect(readFileSync(resolve(STORAGE_DIR, storagePath)).byteLength).toBe(MAX_BODY_BYTES + 1);
	});

	it('QA-02: initiate rejects declared uploads above the configured ingest limit', async () => {
		const beforeJobs = Number(db.runSql('SELECT COUNT(*) FROM jobs;'));
		const response = await apiPost(app, '/api/uploads/documents/initiate', {
			filename: 'too-large.pdf',
			size_bytes: 101 * 1024 * 1024,
			content_type: 'application/pdf',
		});

		expect(response.status).toBe(413);
		expect(await response.json()).toEqual({
			error: {
				code: 'INGEST_FILE_TOO_LARGE',
				message: 'Declared upload exceeds the configured ingest limit',
				details: {
					filename: 'too-large.pdf',
					size_bytes: 101 * 1024 * 1024,
					max_bytes: 100 * 1024 * 1024,
				},
			},
		});
		expect(Number(db.runSql('SELECT COUNT(*) FROM jobs;'))).toBe(beforeJobs);
	});

	it('QA-02b: complete rejects objects whose actual stored size exceeds the ingest limit', async () => {
		const beforeJobs = Number(db.runSql('SELECT COUNT(*) FROM jobs;'));
		const initiate = await apiPost(app, '/api/uploads/documents/initiate', {
			filename: 'actual-too-large.pdf',
			size_bytes: fixturePdf.byteLength,
			content_type: 'application/pdf',
		});
		const initiateBody = await readJson(initiate);
		const sourceId = String((initiateBody.data as Record<string, unknown>).source_id);
		const storagePath = String((initiateBody.data as Record<string, unknown>).storage_path);
		const absolutePath = writeUploadedObject(sourceId, Buffer.from('%PDF-1.7\n'));
		truncateSync(absolutePath, 101 * 1024 * 1024);

		const complete = await apiPost(app, '/api/uploads/documents/complete', {
			source_id: sourceId,
			filename: 'actual-too-large.pdf',
			storage_path: storagePath,
			start_pipeline: true,
		});

		expect(complete.status).toBe(413);
		expect(await complete.json()).toEqual({
			error: {
				code: 'INGEST_FILE_TOO_LARGE',
				message: 'Uploaded object exceeds the configured ingest limit',
				details: {
					source_id: sourceId,
					storage_path: storagePath,
					size_bytes: 101 * 1024 * 1024,
					max_bytes: 100 * 1024 * 1024,
				},
			},
		});
		expect(Number(db.runSql('SELECT COUNT(*) FROM jobs;'))).toBe(beforeJobs);
	});

	it('QA-03: complete + finalize creates a source and queues the pipeline job', async () => {
		const expectedStoragePath = expectedBlobPath(fixturePdf, 'pdf');
		const initiate = await apiPost(app, '/api/uploads/documents/initiate', {
			filename: 'native-text-sample.pdf',
			size_bytes: fixturePdf.byteLength,
			content_type: 'application/pdf',
			tags: ['review'],
		});
		const initiateBody = await readJson(initiate);
		const sourceId = String((initiateBody.data as Record<string, unknown>).source_id);
		const storagePath = String((initiateBody.data as Record<string, unknown>).storage_path);

		writeUploadedObject(sourceId, fixturePdf);

		const complete = await apiPost(app, '/api/uploads/documents/complete', {
			source_id: sourceId,
			filename: 'native-text-sample.pdf',
			storage_path: storagePath,
			tags: ['review'],
			start_pipeline: true,
		});

		expect(complete.status).toBe(202);
		const completeBody = await readJson(complete);
		const jobId = String((completeBody.data as Record<string, unknown>).job_id);
		const completeLinks = completeBody.links as Record<string, unknown>;
		expect(completeLinks).toMatchObject({
			status: `/api/jobs/${jobId}`,
			upload_status: `/api/uploads/documents/finalizations/${jobId}`,
		});

		const pendingStatus = await apiGet(app, String(completeLinks.upload_status));
		expect(pendingStatus.status).toBe(200);
		expect(await readJson(pendingStatus)).toMatchObject({
			data: {
				job_id: jobId,
				requested_source_id: sourceId,
				job_status: 'pending',
				result_status: 'pending',
				source: null,
				pipeline: null,
			},
			links: {
				job: `/api/jobs/${jobId}`,
			},
		});

		const processed = await processOneJob(workerContext, workerModule);
		expect(processed.state).toBe('completed');

		const sourceRow = readJsonCell(
			`SELECT row_to_json(source_row)::text FROM (
				SELECT id, filename, storage_path, status, tags, source_type, metadata, format_metadata
				FROM sources
				WHERE id = '${sourceId}'
			) AS source_row;`,
		);
		expect(sourceRow).toMatchObject({
			id: sourceId,
			filename: 'native-text-sample.pdf',
			storage_path: expectedStoragePath,
			status: 'ingested',
			tags: ['review'],
			source_type: 'pdf',
		});
		expect(existsSync(resolve(STORAGE_DIR, expectedStoragePath))).toBe(true);
		expect(existsSync(resolve(STORAGE_DIR, storagePath))).toBe(false);
		const formatMetadata = sourceRow.format_metadata as Record<string, unknown>;
		const legacyMetadata = sourceRow.metadata as Record<string, unknown>;
		expect(formatMetadata).toEqual(legacyMetadata);
		expect(Object.keys(formatMetadata).length).toBeGreaterThan(0);
		expect(db.runSql(`SELECT status FROM source_steps WHERE source_id = '${sourceId}' AND step_name = 'ingest';`)).toBe(
			'completed',
		);
		expect(Number(db.runSql("SELECT COUNT(*) FROM jobs WHERE type = 'quality' AND status = 'pending';"))).toBe(1);
		expect(Number(db.runSql("SELECT COUNT(*) FROM jobs WHERE type = 'extract' AND status = 'pending';"))).toBe(0);
		expect(Number(db.runSql("SELECT COUNT(*) FROM jobs WHERE type = 'pipeline_run';"))).toBe(0);

		const finalizePayload = readJsonCell(`SELECT payload::text FROM jobs WHERE id = '${jobId}';`);
		expect(finalizePayload).toMatchObject({
			sourceId,
			filename: 'native-text-sample.pdf',
			storagePath,
			result_status: 'created',
			resolved_source_id: sourceId,
			pipeline_job_id: expect.any(String),
			pipeline_run_id: expect.any(String),
		});
		const pipelineJobPayload = readJsonCell(
			`SELECT payload::text FROM jobs WHERE id = '${String(finalizePayload.pipeline_job_id)}';`,
		);
		expect(pipelineJobPayload).toMatchObject({
			sourceId,
			runId: finalizePayload.pipeline_run_id,
			upTo: 'graph',
			force: false,
			tag: 'browser-upload',
		});

		const finalizedStatus = await apiGet(app, String(completeLinks.upload_status));
		expect(finalizedStatus.status).toBe(200);
		expect(await readJson(finalizedStatus)).toMatchObject({
			data: {
				job_id: jobId,
				requested_source_id: sourceId,
				job_status: 'completed',
				result_status: 'created',
				source: {
					id: sourceId,
					filename: 'native-text-sample.pdf',
					status: 'ingested',
					links: {
						document: `/api/documents/${sourceId}`,
					},
				},
				pipeline: {
					job_id: finalizePayload.pipeline_job_id,
					run_id: finalizePayload.pipeline_run_id,
					links: {
						job: `/api/jobs/${String(finalizePayload.pipeline_job_id)}`,
					},
				},
			},
			links: {
				job: `/api/jobs/${jobId}`,
				source: `/api/documents/${sourceId}`,
			},
		});
	});

	it('QA-04: duplicate finalize resolves to the existing source and removes the provisional object', async () => {
		const firstInitiate = await apiPost(app, '/api/uploads/documents/initiate', {
			filename: 'native-text-sample.pdf',
			size_bytes: fixturePdf.byteLength,
			content_type: 'application/pdf',
		});
		const firstBody = await readJson(firstInitiate);
		const firstSourceId = String((firstBody.data as Record<string, unknown>).source_id);
		const firstStoragePath = String((firstBody.data as Record<string, unknown>).storage_path);
		writeUploadedObject(firstSourceId, fixturePdf);

		const firstComplete = await apiPost(app, '/api/uploads/documents/complete', {
			source_id: firstSourceId,
			filename: 'native-text-sample.pdf',
			storage_path: firstStoragePath,
			start_pipeline: false,
		});
		expect(firstComplete.status).toBe(202);
		const firstCompleteBody = await readJson(firstComplete);
		const firstJobId = String((firstCompleteBody.data as Record<string, unknown>).job_id);
		const firstUploadStatus = String((firstCompleteBody.links as Record<string, unknown>).upload_status);
		await processOneJob(workerContext, workerModule);

		const firstStatus = await apiGet(app, firstUploadStatus);
		expect(firstStatus.status).toBe(200);
		expect(await readJson(firstStatus)).toMatchObject({
			data: {
				job_id: firstJobId,
				requested_source_id: firstSourceId,
				job_status: 'completed',
				result_status: 'created',
				source: {
					id: firstSourceId,
				},
				pipeline: null,
			},
			links: {
				source: `/api/documents/${firstSourceId}`,
			},
		});

		const secondInitiate = await apiPost(app, '/api/uploads/documents/initiate', {
			filename: 'native-text-sample.pdf',
			size_bytes: fixturePdf.byteLength,
			content_type: 'application/pdf',
		});
		const secondBody = await readJson(secondInitiate);
		const secondSourceId = String((secondBody.data as Record<string, unknown>).source_id);
		const secondStoragePath = String((secondBody.data as Record<string, unknown>).storage_path);
		writeUploadedObject(secondSourceId, fixturePdf);

		const secondComplete = await apiPost(app, '/api/uploads/documents/complete', {
			source_id: secondSourceId,
			filename: 'native-text-sample.pdf',
			storage_path: secondStoragePath,
			start_pipeline: false,
		});
		expect(secondComplete.status).toBe(202);
		const secondCompleteBody = await readJson(secondComplete);
		const secondJobId = String((secondCompleteBody.data as Record<string, unknown>).job_id);

		const processed = await processOneJob(workerContext, workerModule);
		expect(processed.state).toBe('completed');
		expect(Number(db.runSql('SELECT COUNT(*) FROM sources;'))).toBe(1);
		expect(existsSync(join(RAW_STORAGE_DIR, secondSourceId, 'original.pdf'))).toBe(false);

		const finalizePayload = readJsonCell(`SELECT payload::text FROM jobs WHERE id = '${secondJobId}';`);
		expect(finalizePayload).toMatchObject({
			sourceId: secondSourceId,
			result_status: 'duplicate',
			resolved_source_id: firstSourceId,
			duplicate_of_source_id: firstSourceId,
		});

		const duplicateStatus = await apiGet(
			app,
			String((secondCompleteBody.links as Record<string, unknown>).upload_status),
		);
		expect(duplicateStatus.status).toBe(200);
		expect(await readJson(duplicateStatus)).toMatchObject({
			data: {
				job_id: secondJobId,
				requested_source_id: secondSourceId,
				job_status: 'completed',
				result_status: 'duplicate',
				source: {
					id: firstSourceId,
					filename: 'native-text-sample.pdf',
				},
				pipeline: null,
			},
			links: {
				source: `/api/documents/${firstSourceId}`,
			},
		});
	});

	it('QA-04b: duplicate finalization hides unreadable resolved sources from member sessions', async () => {
		const firstInitiate = await apiPost(app, '/api/uploads/documents/initiate', {
			filename: 'confidential-source.pdf',
			size_bytes: fixturePdf.byteLength,
			content_type: 'application/pdf',
		});
		const firstBody = await readJson(firstInitiate);
		const firstSourceId = String((firstBody.data as Record<string, unknown>).source_id);
		const firstStoragePath = String((firstBody.data as Record<string, unknown>).storage_path);
		writeUploadedObject(firstSourceId, fixturePdf);

		const firstComplete = await apiPost(app, '/api/uploads/documents/complete', {
			source_id: firstSourceId,
			filename: 'confidential-source.pdf',
			storage_path: firstStoragePath,
			expected_sensitivity: {
				level: 'confidential',
				reason: 'restricted source silo',
			},
			start_pipeline: false,
		});
		expect(firstComplete.status).toBe(202);
		await processOneJob(workerContext, workerModule);

		const member = seedSession('member');
		const secondInitiate = await sessionPost(app, member, '/api/uploads/documents/initiate', {
			filename: 'member-duplicate.pdf',
			size_bytes: fixturePdf.byteLength,
			content_type: 'application/pdf',
		});
		expect(secondInitiate.status).toBe(201);
		const secondBody = await readJson(secondInitiate);
		const secondSourceId = String((secondBody.data as Record<string, unknown>).source_id);
		const secondStoragePath = String((secondBody.data as Record<string, unknown>).storage_path);
		writeUploadedObject(secondSourceId, fixturePdf);

		const secondComplete = await sessionPost(app, member, '/api/uploads/documents/complete', {
			source_id: secondSourceId,
			filename: 'member-duplicate.pdf',
			storage_path: secondStoragePath,
			start_pipeline: false,
		});
		expect(secondComplete.status).toBe(202);
		const secondCompleteBody = await readJson(secondComplete);
		const secondJobId = String((secondCompleteBody.data as Record<string, unknown>).job_id);
		await processOneJob(workerContext, workerModule);

		const memberStatus = await apiGet(
			app,
			String((secondCompleteBody.links as Record<string, unknown>).upload_status),
			sessionHeaders(member),
		);
		expect(memberStatus.status).toBe(200);
		const memberStatusBody = await readJson(memberStatus);
		expect(memberStatusBody).toMatchObject({
			data: {
				job_id: secondJobId,
				requested_source_id: secondSourceId,
				job_status: 'completed',
				result_status: 'completed_unavailable',
				source: null,
				pipeline: null,
			},
			links: {
				job: `/api/jobs/${secondJobId}`,
			},
		});
		expect(JSON.stringify(memberStatusBody)).not.toContain(firstSourceId);

		const otherMember = seedSession('member');
		const otherStatus = await apiGet(
			app,
			String((secondCompleteBody.links as Record<string, unknown>).upload_status),
			sessionHeaders(otherMember),
		);
		expect(otherStatus.status).toBe(404);
	});

	it('QA-04c: upload finalization status rejects non-upload jobs', async () => {
		const jobId = randomUUID();
		insertJob({
			id: jobId,
			type: 'quality',
			status: 'pending',
			attempts: 0,
			maxAttempts: 3,
			payload: { sourceId: randomUUID() },
		});

		const response = await apiGet(app, `/api/uploads/documents/finalizations/${jobId}`);
		expect(response.status).toBe(404);
	});

	it('QA-04d: failed upload finalization status stays sanitized for browser sessions', async () => {
		const member = seedSession('member');
		const jobId = randomUUID();
		const sourceId = randomUUID();
		insertJob({
			id: jobId,
			type: 'document_upload_finalize',
			status: 'failed',
			attempts: 1,
			maxAttempts: 3,
			workerId: 'worker-host-123',
			errorLog: 'raw stack with storage path gs://private/source.pdf',
			payload: {
				sourceId,
				filename: 'failed-upload.pdf',
				storagePath: `raw/${sourceId}/original.pdf`,
				submittedBy: {
					userId: member.userId,
					type: 'human',
					role: 'member',
				},
			},
		});

		const response = await apiGet(app, `/api/uploads/documents/finalizations/${jobId}`, sessionHeaders(member));
		expect(response.status).toBe(200);
		const body = await readJson(response);
		expect(body).toMatchObject({
			data: {
				job_id: jobId,
				requested_source_id: sourceId,
				job_status: 'failed',
				result_status: 'failed',
				source: null,
				pipeline: null,
			},
		});
		const serialized = JSON.stringify(body);
		expect(serialized).not.toContain('payload');
		expect(serialized).not.toContain('worker-host-123');
		expect(serialized).not.toContain('private/source.pdf');

		const jobDetail = await apiGet(app, `/api/jobs/${jobId}`);
		expect(jobDetail.status).toBe(200);
		expect(await readJson(jobDetail)).toMatchObject({
			data: {
				job: {
					id: jobId,
					error_log: 'raw stack with storage path gs://private/source.pdf',
					payload: {
						sourceId,
					},
					worker_id: 'worker-host-123',
				},
			},
		});
	});

	it('QA-05: complete fails clearly when the uploaded object is missing', async () => {
		const initiate = await apiPost(app, '/api/uploads/documents/initiate', {
			filename: 'missing.pdf',
			size_bytes: fixturePdf.byteLength,
			content_type: 'application/pdf',
		});
		const initiateBody = await readJson(initiate);
		const sourceId = String((initiateBody.data as Record<string, unknown>).source_id);
		const storagePath = String((initiateBody.data as Record<string, unknown>).storage_path);

		const complete = await apiPost(app, '/api/uploads/documents/complete', {
			source_id: sourceId,
			filename: 'missing.pdf',
			storage_path: storagePath,
		});

		expect(complete.status).toBe(404);
		expect(await complete.json()).toEqual({
			error: {
				code: 'UPLOAD_OBJECT_NOT_FOUND',
				message: `Uploaded object not found: ${storagePath}`,
				details: {
					source_id: sourceId,
					storage_path: storagePath,
				},
			},
		});
	});

	it('QA-06: non-upload routes still reject oversized request bodies', async () => {
		const oversizedBody = new TextEncoder().encode('x'.repeat(MAX_BODY_BYTES + 1));
		const request = new Request('http://localhost/api/search', {
			method: 'POST',
			headers: {
				Authorization: 'Bearer test-api-key',
				'Content-Type': 'text/plain',
			},
			body: new ReadableStream({
				start(controller) {
					controller.enqueue(oversizedBody);
					controller.close();
				},
			}),
			duplex: 'half',
		});

		const response = await app.request(request);
		expect(response.status).toBe(413);
		expect(await response.json()).toEqual({
			error: {
				code: 'REQUEST_BODY_TOO_LARGE',
				message: 'Request body exceeds the API limit',
				details: {
					content_length: MAX_BODY_BYTES + 1,
					max_bytes: MAX_BODY_BYTES,
				},
			},
		});
	});

	it('QA-07: upload routes stay behind auth', async () => {
		const response = await app.request('http://localhost/api/uploads/documents/initiate', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				filename: 'native-text-sample.pdf',
				size_bytes: fixturePdf.byteLength,
				content_type: 'application/pdf',
			}),
		});

		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({
			error: {
				code: 'AUTH_UNAUTHORIZED',
				message: 'A valid API key is required',
			},
		});
	});

	it('QA-08: repeated completion requests do not enqueue a second finalize job', async () => {
		const initiate = await apiPost(app, '/api/uploads/documents/initiate', {
			filename: 'native-text-sample.pdf',
			size_bytes: fixturePdf.byteLength,
			content_type: 'application/pdf',
		});
		const initiateBody = await readJson(initiate);
		const sourceId = String((initiateBody.data as Record<string, unknown>).source_id);
		const storagePath = String((initiateBody.data as Record<string, unknown>).storage_path);
		writeUploadedObject(sourceId, fixturePdf);

		const firstComplete = await apiPost(app, '/api/uploads/documents/complete', {
			source_id: sourceId,
			filename: 'native-text-sample.pdf',
			storage_path: storagePath,
			start_pipeline: false,
		});
		expect(firstComplete.status).toBe(202);

		const secondComplete = await apiPost(app, '/api/uploads/documents/complete', {
			source_id: sourceId,
			filename: 'native-text-sample.pdf',
			storage_path: storagePath,
			start_pipeline: false,
		});
		expect(secondComplete.status).toBe(409);
		expect(await secondComplete.json()).toEqual({
			error: {
				code: 'UPLOAD_FINALIZE_CONFLICT',
				message: `Upload finalize job already in progress for ${sourceId}`,
				details: {
					source_id: sourceId,
				},
			},
		});
		expect(
			Number(db.runSql("SELECT COUNT(*) FROM jobs WHERE type = 'document_upload_finalize' AND status = 'pending';")),
		).toBe(1);
	});
});
