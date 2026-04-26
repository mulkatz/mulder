import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as db from '../lib/db.js';

const ROOT = resolve(import.meta.dirname, '../..');
const CORE_DIR = resolve(ROOT, 'packages/core');
const PIPELINE_DIR = resolve(ROOT, 'packages/pipeline');
const WORKER_DIR = resolve(ROOT, 'packages/worker');
const API_DIR = resolve(ROOT, 'apps/api');
const CLI_DIR = resolve(ROOT, 'apps/cli');

const CORE_DIST = resolve(CORE_DIR, 'dist/index.js');
const API_APP_DIST = resolve(API_DIR, 'dist/app.js');
const CLI_DIST = resolve(CLI_DIR, 'dist/index.js');
const EXAMPLE_CONFIG = resolve(ROOT, 'mulder.config.example.yaml');

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
		timeout: opts?.timeout ?? 120_000,
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
		['DELETE FROM jobs', 'DELETE FROM pipeline_run_sources', 'DELETE FROM pipeline_runs', 'DELETE FROM sources'].join(
			'; ',
		),
	);
}

function seedJobProgressState(input: {
	runId: string;
	sourceId: string;
	currentStep: string;
	sourceStatus: 'pending' | 'processing' | 'completed' | 'failed';
	updatedAt: string;
}): void {
	const fileHash = `${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '')}`;
	db.runSql(
		[
			'INSERT INTO sources (id, filename, storage_path, file_hash, page_count, has_native_text, native_text_ratio, status, reliability_score, tags, metadata)',
			`VALUES ('${input.sourceId}', 'route-test.pdf', '/tmp/route-test.pdf', '${fileHash}', 1, true, 1, 'ingested', NULL, ARRAY[]::text[], '{}'::jsonb)`,
			'ON CONFLICT (id) DO UPDATE SET updated_at = now();',
			`INSERT INTO pipeline_runs (id, tag, options, status, created_at, finished_at) VALUES ('${input.runId}', 'status-test', '{}'::jsonb, 'running', TIMESTAMPTZ '2026-04-14T12:00:02.000Z', NULL);`,
			'INSERT INTO pipeline_run_sources (run_id, source_id, current_step, status, error_message, updated_at)',
			`VALUES ('${input.runId}', '${input.sourceId}', '${input.currentStep}', '${input.sourceStatus}', NULL, TIMESTAMPTZ '${input.updatedAt}');`,
		].join(' '),
	);
}

function insertJob(input: {
	id: string;
	type: string;
	status: 'pending' | 'running' | 'completed' | 'failed' | 'dead_letter';
	attempts: number;
	maxAttempts: number;
	workerId: string | null;
	createdAt: string;
	startedAt?: string | null;
	finishedAt?: string | null;
	errorLog?: string | null;
	payload: Record<string, unknown>;
}): void {
	const startedAt = input.startedAt === undefined ? null : input.startedAt;
	const finishedAt = input.finishedAt === undefined ? null : input.finishedAt;
	const errorLog = input.errorLog === undefined ? null : input.errorLog;

	db.runSql(
		[
			'INSERT INTO jobs (id, type, payload, status, attempts, max_attempts, error_log, worker_id, created_at, started_at, finished_at)',
			`VALUES ('${input.id}', '${input.type}', '${JSON.stringify(input.payload)}'::jsonb, '${input.status}', ${input.attempts}, ${input.maxAttempts},`,
			errorLog === null ? 'NULL' : `'${errorLog}'`,
			`, ${input.workerId === null ? 'NULL' : `'${input.workerId}'`}, TIMESTAMPTZ '${input.createdAt}',`,
			startedAt === null ? 'NULL' : `TIMESTAMPTZ '${startedAt}'`,
			`, ${finishedAt === null ? 'NULL' : `TIMESTAMPTZ '${finishedAt}'`})`,
			'ON CONFLICT (id) DO UPDATE SET type = EXCLUDED.type, payload = EXCLUDED.payload, status = EXCLUDED.status, attempts = EXCLUDED.attempts, max_attempts = EXCLUDED.max_attempts, error_log = EXCLUDED.error_log, worker_id = EXCLUDED.worker_id, created_at = EXCLUDED.created_at, started_at = EXCLUDED.started_at, finished_at = EXCLUDED.finished_at;',
		].join(' '),
	);
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

function authorizedHeaders(): Record<string, string> {
	return {
		Authorization: 'Bearer test-api-key',
		'X-Forwarded-For': '203.0.113.10',
	};
}

describe('Spec 72 — Job Status API', () => {
	let app: { request: (input: string | Request, init?: RequestInit) => Promise<Response> };
	let deadLetterJobId: string;
	let runningJobId: string;
	let pendingJobId: string;
	let runId: string;
	let sourceId: string;

	beforeAll(async () => {
		db.requirePg();
		process.env.MULDER_CONFIG = EXAMPLE_CONFIG;
		process.env.MULDER_LOG_LEVEL = 'silent';

		buildPackage(CORE_DIR);
		buildPackage(PIPELINE_DIR);
		buildPackage(WORKER_DIR);
		buildPackage(API_DIR);
		buildPackage(CLI_DIR);

		const migrate = runCli(['db', 'migrate', EXAMPLE_CONFIG], { timeout: 300_000 });
		expect(migrate.exitCode).toBe(0);

		await import(pathToFileURL(CORE_DIST).href);
		app = await loadApiApp();
	}, 600000);

	beforeEach(() => {
		deadLetterJobId = randomUUID();
		runningJobId = randomUUID();
		pendingJobId = randomUUID();
		runId = randomUUID();
		sourceId = randomUUID();
		cleanState();
		seedJobProgressState({
			runId,
			sourceId,
			currentStep: 'extract',
			sourceStatus: 'processing',
			updatedAt: '2026-04-14T12:00:05.000Z',
		});
		insertJob({
			id: deadLetterJobId,
			type: 'manual_review',
			status: 'dead_letter',
			attempts: 3,
			maxAttempts: 3,
			workerId: 'worker-host-999',
			createdAt: '2026-04-14T12:03:00.000Z',
			startedAt: '2026-04-14T12:03:10.000Z',
			finishedAt: '2026-04-14T12:03:20.000Z',
			errorLog: 'worker crashed before persisting output',
			payload: {},
		});
		insertJob({
			id: runningJobId,
			type: 'pipeline_run',
			status: 'running',
			attempts: 1,
			maxAttempts: 3,
			workerId: 'worker-host-123',
			createdAt: '2026-04-14T12:02:00.000Z',
			startedAt: '2026-04-14T12:02:03.000Z',
			finishedAt: null,
			payload: {
				sourceId,
				runId,
			},
		});
		insertJob({
			id: pendingJobId,
			type: 'pipeline_run',
			status: 'pending',
			attempts: 0,
			maxAttempts: 3,
			workerId: null,
			createdAt: '2026-04-14T12:01:00.000Z',
			payload: {
				sourceId,
				runId,
			},
		});
	});

	afterAll(() => {
		try {
			cleanState();
		} catch {
			// Ignore cleanup failures.
		}
	});

	it('QA-01: lists recent jobs newest-first with filter support', async () => {
		const response = await app.request('http://localhost/api/jobs', {
			headers: authorizedHeaders(),
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			data: [
				{
					id: deadLetterJobId,
					type: 'manual_review',
					status: 'dead_letter',
					attempts: 3,
					max_attempts: 3,
					worker_id: 'worker-host-999',
					created_at: '2026-04-14T12:03:00.000Z',
					started_at: '2026-04-14T12:03:10.000Z',
					finished_at: '2026-04-14T12:03:20.000Z',
					links: {
						self: `/api/jobs/${deadLetterJobId}`,
					},
				},
				{
					id: runningJobId,
					type: 'pipeline_run',
					status: 'running',
					attempts: 1,
					max_attempts: 3,
					worker_id: 'worker-host-123',
					created_at: '2026-04-14T12:02:00.000Z',
					started_at: '2026-04-14T12:02:03.000Z',
					finished_at: null,
					links: {
						self: `/api/jobs/${runningJobId}`,
					},
				},
				{
					id: pendingJobId,
					type: 'pipeline_run',
					status: 'pending',
					attempts: 0,
					max_attempts: 3,
					worker_id: null,
					created_at: '2026-04-14T12:01:00.000Z',
					started_at: null,
					finished_at: null,
					links: {
						self: `/api/jobs/${pendingJobId}`,
					},
				},
			],
			meta: {
				count: 3,
				limit: 20,
			},
		});

		const limited = await app.request('http://localhost/api/jobs?limit=1', {
			headers: authorizedHeaders(),
		});

		expect(limited.status).toBe(200);
		expect(await limited.json()).toEqual({
			data: [
				{
					id: deadLetterJobId,
					type: 'manual_review',
					status: 'dead_letter',
					attempts: 3,
					max_attempts: 3,
					worker_id: 'worker-host-999',
					created_at: '2026-04-14T12:03:00.000Z',
					started_at: '2026-04-14T12:03:10.000Z',
					finished_at: '2026-04-14T12:03:20.000Z',
					links: {
						self: `/api/jobs/${deadLetterJobId}`,
					},
				},
			],
			meta: {
				count: 3,
				limit: 1,
			},
		});

		const runningOnly = await app.request('http://localhost/api/jobs?status=running', {
			headers: authorizedHeaders(),
		});
		expect(runningOnly.status).toBe(200);
		expect(await runningOnly.json()).toEqual({
			data: [
				{
					id: runningJobId,
					type: 'pipeline_run',
					status: 'running',
					attempts: 1,
					max_attempts: 3,
					worker_id: 'worker-host-123',
					created_at: '2026-04-14T12:02:00.000Z',
					started_at: '2026-04-14T12:02:03.000Z',
					finished_at: null,
					links: {
						self: `/api/jobs/${runningJobId}`,
					},
				},
			],
			meta: {
				count: 1,
				limit: 20,
			},
		});

		const pipelineOnly = await app.request('http://localhost/api/jobs?type=pipeline_run', {
			headers: authorizedHeaders(),
		});
		expect(pipelineOnly.status).toBe(200);
		expect((await pipelineOnly.json()) as { meta: { count: number } }).toEqual({
			data: [
				{
					id: runningJobId,
					type: 'pipeline_run',
					status: 'running',
					attempts: 1,
					max_attempts: 3,
					worker_id: 'worker-host-123',
					created_at: '2026-04-14T12:02:00.000Z',
					started_at: '2026-04-14T12:02:03.000Z',
					finished_at: null,
					links: {
						self: `/api/jobs/${runningJobId}`,
					},
				},
				{
					id: pendingJobId,
					type: 'pipeline_run',
					status: 'pending',
					attempts: 0,
					max_attempts: 3,
					worker_id: null,
					created_at: '2026-04-14T12:01:00.000Z',
					started_at: null,
					finished_at: null,
					links: {
						self: `/api/jobs/${pendingJobId}`,
					},
				},
			],
			meta: {
				count: 2,
				limit: 20,
			},
		});

		const workerOnly = await app.request('http://localhost/api/jobs?worker_id=worker-host-123', {
			headers: authorizedHeaders(),
		});
		expect(workerOnly.status).toBe(200);
		expect(await workerOnly.json()).toEqual({
			data: [
				{
					id: runningJobId,
					type: 'pipeline_run',
					status: 'running',
					attempts: 1,
					max_attempts: 3,
					worker_id: 'worker-host-123',
					created_at: '2026-04-14T12:02:00.000Z',
					started_at: '2026-04-14T12:02:03.000Z',
					finished_at: null,
					links: {
						self: `/api/jobs/${runningJobId}`,
					},
				},
			],
			meta: {
				count: 1,
				limit: 20,
			},
		});
	});

	it('QA-02: returns queue state and pipeline progress for a known job', async () => {
		const response = await app.request(`http://localhost/api/jobs/${runningJobId}`, {
			headers: authorizedHeaders(),
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			data: {
				job: {
					id: runningJobId,
					type: 'pipeline_run',
					status: 'running',
					attempts: 1,
					max_attempts: 3,
					worker_id: 'worker-host-123',
					created_at: '2026-04-14T12:02:00.000Z',
					started_at: '2026-04-14T12:02:03.000Z',
					finished_at: null,
					error_log: null,
					payload: {
						sourceId,
						runId,
					},
				},
				progress: {
					run_id: runId,
					run_status: 'running',
					source_counts: {
						pending: 0,
						processing: 1,
						completed: 0,
						failed: 0,
					},
					sources: [
						{
							source_id: sourceId,
							current_step: 'extract',
							status: 'processing',
							error_message: null,
							updated_at: '2026-04-14T12:00:05.000Z',
						},
					],
				},
			},
		});
	});

	it('QA-03: failed and dead-letter jobs expose error_log while remaining inspectable', async () => {
		const response = await app.request(`http://localhost/api/jobs/${deadLetterJobId}`, {
			headers: authorizedHeaders(),
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			data: {
				job: {
					id: deadLetterJobId,
					type: 'manual_review',
					status: 'dead_letter',
					attempts: 3,
					max_attempts: 3,
					worker_id: 'worker-host-999',
					created_at: '2026-04-14T12:03:00.000Z',
					started_at: '2026-04-14T12:03:10.000Z',
					finished_at: '2026-04-14T12:03:20.000Z',
					error_log: 'worker crashed before persisting output',
					payload: {},
				},
				progress: null,
			},
		});
	});

	it('QA-04: unknown jobs return a not-found JSON error', async () => {
		const missingJobId = randomUUID();
		const response = await app.request(`http://localhost/api/jobs/${missingJobId}`, {
			headers: authorizedHeaders(),
		});

		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({
			error: {
				code: 'DB_NOT_FOUND',
				message: `Job not found: ${missingJobId}`,
				details: {
					id: missingJobId,
				},
			},
		});
	});

	it('QA-05: jobs routes stay behind the existing auth middleware', async () => {
		const response = await app.request('http://localhost/api/jobs');

		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({
			error: {
				code: 'AUTH_UNAUTHORIZED',
				message: 'A valid API key is required',
			},
		});
	});

	it('QA-05: malformed job ids return a validation error before the repository layer', async () => {
		const response = await app.request('http://localhost/api/jobs/not-a-uuid', {
			headers: authorizedHeaders(),
		});

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			error: {
				code: 'VALIDATION_ERROR',
				message: 'Invalid request',
			},
		});
	});
});
