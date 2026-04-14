import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { WorkerRuntimeContext } from '@mulder/worker';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as db from '../lib/db.js';

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
const EXAMPLE_CONFIG = resolve(ROOT, 'mulder.config.yaml');
const NATIVE_TEXT_PDF = resolve(ROOT, 'fixtures/raw/native-text-sample.pdf');

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
		[
			'DELETE FROM jobs',
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
		].join('; '),
	);
}

function cleanStorageFixtures(): void {
	for (const dir of [resolve(ROOT, '.local/storage/extracted'), resolve(ROOT, '.local/storage/segments')]) {
		if (!existsSync(dir)) {
			continue;
		}
		for (const entry of readdirSync(dir)) {
			if (entry === '_schema.json') {
				continue;
			}
			rmSync(join(dir, entry), { recursive: true, force: true });
		}
	}
}

function insertSourceRow(sourceId: string): void {
	const fileHash = `${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '')}`;
	db.runSql(
		[
			'INSERT INTO sources (id, filename, storage_path, file_hash, page_count, has_native_text, native_text_ratio, status, reliability_score, tags, metadata)',
			`VALUES ('${sourceId}', 'route-test.pdf', '/tmp/route-test.pdf', '${fileHash}', 1, true, 1, 'ingested', NULL, ARRAY[]::text[], '{}'::jsonb)`,
			'ON CONFLICT (id) DO UPDATE SET updated_at = now();',
		].join(' '),
	);
}

function insertFailedPipelineStep(sourceId: string, step: string, tag = 'retry-seed'): void {
	const runId = randomUUID();
	db.runSql(
		[
			`INSERT INTO pipeline_runs (id, tag, options, status, created_at, finished_at)`,
			`VALUES ('${runId}', '${tag}', '{}'::jsonb, 'failed', now(), now());`,
			`INSERT INTO pipeline_run_sources (run_id, source_id, current_step, status, error_message, updated_at)`,
			`VALUES ('${runId}', '${sourceId}', '${step}', 'failed', 'seeded failure', now());`,
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

type ApiApp = Awaited<ReturnType<typeof loadApiApp>>;

interface PipelineAcceptedResponse {
	data: {
		job_id: string;
		status: 'pending';
		run_id: string;
	};
	links: {
		status: string;
	};
}

async function readPipelineAcceptedResponse(response: Response): Promise<PipelineAcceptedResponse> {
	return (await response.json()) as PipelineAcceptedResponse;
}

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

function readJsonCell(sql: string): Record<string, unknown> {
	return JSON.parse(db.runSql(sql)) as Record<string, unknown>;
}

describe('Spec 71 — Async Pipeline API Routes', () => {
	let app: { request: (input: string | Request, init?: RequestInit) => Promise<Response> };
	let coreModule: typeof import('@mulder/core');
	let workerModule: typeof import('@mulder/worker');

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

		coreModule = await import(pathToFileURL(CORE_DIST).href);
		workerModule = await import(pathToFileURL(WORKER_DIST).href);
		app = await loadApiApp();
	}, 600000);

	beforeEach(() => {
		cleanState();
		cleanStorageFixtures();
	});

	afterAll(() => {
		try {
			cleanState();
			cleanStorageFixtures();
		} catch {
			// Ignore cleanup failures.
		}
	});

	it('QA-01: POST /api/pipeline/run accepts a source-scoped request and enqueues a pending job', async () => {
		const sourceId = randomUUID();
		insertSourceRow(sourceId);

		const beforeJobs = db.runSql('SELECT COUNT(*) FROM jobs;');
		const beforeRuns = db.runSql('SELECT COUNT(*) FROM pipeline_runs;');

		const response = await apiPost(app, '/api/pipeline/run', {
			source_id: sourceId,
			from: 'extract',
			up_to: 'extract',
			tag: 'api-run',
		});

		expect(response.status).toBe(202);
		expect(response.headers.get('content-type')).toContain('application/json');
		const body = await readPipelineAcceptedResponse(response);
		expect(body).toMatchObject({
			data: {
				job_id: expect.any(String),
				status: 'pending',
				run_id: expect.any(String),
			},
			links: {
				status: expect.stringMatching(/^\/api\/jobs\/[0-9a-f-]+$/i),
			},
		});

		const afterJobs = db.runSql('SELECT COUNT(*) FROM jobs;');
		const afterRuns = db.runSql('SELECT COUNT(*) FROM pipeline_runs;');
		expect(Number(afterJobs)).toBe(Number(beforeJobs) + 1);
		expect(Number(afterRuns)).toBe(Number(beforeRuns) + 1);

		const runRow = readJsonCell(
			`SELECT row_to_json(run_row)::text FROM (
				SELECT id, tag, status, options
				FROM pipeline_runs
				WHERE id = '${body.data.run_id}'
			) AS run_row;`,
		);
		expect(runRow).toMatchObject({
			id: body.data.run_id,
			tag: 'api-run',
			status: 'running',
		});
		expect((runRow.options as Record<string, unknown>).source_id).toBe(sourceId);
		expect((runRow.options as Record<string, unknown>).from).toBe('extract');
		expect((runRow.options as Record<string, unknown>).up_to).toBe('extract');

		const jobRow = readJsonCell(`SELECT payload::text FROM jobs WHERE id = '${body.data.job_id}';`);
		expect(jobRow).toMatchObject({
			sourceId,
			runId: body.data.run_id,
			from: 'extract',
			upTo: 'extract',
			tag: 'api-run',
			force: false,
		});
	});

	it('QA-02: malformed pipeline-run requests fail at the HTTP edge', async () => {
		const sourceId = randomUUID();
		insertSourceRow(sourceId);

		const beforeJobs = db.runSql('SELECT COUNT(*) FROM jobs;');
		const response = await apiPost(app, '/api/pipeline/run', {
			source_id: sourceId,
			from: 'graph',
			up_to: 'extract',
		});

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			error: {
				code: 'VALIDATION_ERROR',
				message: 'Invalid request',
			},
		});
		expect(db.runSql('SELECT COUNT(*) FROM jobs;')).toBe(beforeJobs);
		expect(db.runSql('SELECT COUNT(*) FROM pipeline_runs;')).toBe('0');
	});

	it('QA-03: unknown sources are rejected without queue side effects', async () => {
		const sourceId = randomUUID();
		const beforeJobs = db.runSql('SELECT COUNT(*) FROM jobs;');
		const beforeRuns = db.runSql('SELECT COUNT(*) FROM pipeline_runs;');

		const response = await apiPost(app, '/api/pipeline/run', {
			source_id: sourceId,
			from: 'extract',
			up_to: 'extract',
		});

		expect(response.status).toBe(404);
		expect(await response.json()).toMatchObject({
			error: {
				code: 'PIPELINE_SOURCE_NOT_FOUND',
			},
		});
		expect(db.runSql('SELECT COUNT(*) FROM jobs;')).toBe(beforeJobs);
		expect(db.runSql('SELECT COUNT(*) FROM pipeline_runs;')).toBe(beforeRuns);
	});

	it('QA-04: POST /api/pipeline/retry only accepts retryable failed work', async () => {
		const sourceId = randomUUID();
		insertSourceRow(sourceId);

		const beforeJobs = db.runSql('SELECT COUNT(*) FROM jobs;');
		const response = await apiPost(app, '/api/pipeline/retry', {
			source_id: sourceId,
		});

		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({
			error: {
				code: 'PIPELINE_RETRY_CONFLICT',
			},
		});
		expect(db.runSql('SELECT COUNT(*) FROM jobs;')).toBe(beforeJobs);
	});

	it('QA-05: retry requests enqueue a forced single-step pipeline job', async () => {
		const sourceId = randomUUID();
		insertSourceRow(sourceId);
		insertFailedPipelineStep(sourceId, 'extract');

		const response = await apiPost(app, '/api/pipeline/retry', {
			source_id: sourceId,
			step: 'segment',
			tag: 'retry-api',
		});

		expect(response.status).toBe(202);
		const body = await readPipelineAcceptedResponse(response);
		expect(body.data.status).toBe('pending');
		expect(body.links.status).toMatch(/^\/api\/jobs\/[0-9a-f-]+$/i);

		const jobRow = readJsonCell(`SELECT payload::text FROM jobs WHERE id = '${body.data.job_id}';`);
		expect(jobRow).toMatchObject({
			sourceId,
			from: 'segment',
			upTo: 'segment',
			tag: 'retry-api',
			force: true,
		});

		const runRow = readJsonCell(
			`SELECT row_to_json(run_row)::text FROM (
				SELECT id, tag, status, options
				FROM pipeline_runs
				WHERE id = '${body.data.run_id}'
			) AS run_row;`,
		);
		expect(runRow).toMatchObject({
			tag: 'retry-api',
			status: 'running',
		});
		expect((runRow.options as Record<string, unknown>).source_id).toBe(sourceId);
		expect((runRow.options as Record<string, unknown>).step).toBe('segment');
		expect((runRow.options as Record<string, unknown>).retry).toBe(true);
	});

	it('QA-06: the worker can dequeue and execute an API-created pipeline job', async () => {
		const ingest = runCli(['ingest', NATIVE_TEXT_PDF], { timeout: 240_000 });
		expect(ingest.exitCode).toBe(0);

		const sourceRow = db.runSql(
			"SELECT id FROM sources WHERE filename = 'native-text-sample.pdf' ORDER BY created_at DESC LIMIT 1;",
		);
		expect(sourceRow).toMatch(/^[0-9a-f-]{36}$/);

		const response = await apiPost(app, '/api/pipeline/run', {
			source_id: sourceRow,
			from: 'extract',
			up_to: 'extract',
			tag: 'worker-integration',
		});
		expect(response.status).toBe(202);
		const body = await readPipelineAcceptedResponse(response);

		const workerConfig = coreModule.loadConfig(EXAMPLE_CONFIG);
		const workerLogger = coreModule.createLogger();
		const cloudSql = workerConfig.gcp?.cloud_sql;
		if (!cloudSql) {
			throw new Error('Expected worker config to include GCP Cloud SQL settings');
		}
		const runtimeContext: WorkerRuntimeContext = {
			config: workerConfig,
			services: coreModule.createServiceRegistry(workerConfig, workerLogger),
			pool: coreModule.getWorkerPool(cloudSql),
			logger: workerLogger,
		};

		const result = await workerModule.processNextJob(runtimeContext, 'worker-qa-71');
		expect(result.state).toBe('completed');
		expect(result.job?.id).toBe(body.data.job_id);

		const jobState = db.runSql(`SELECT status FROM jobs WHERE id = '${body.data.job_id}';`);
		expect(jobState).toBe('completed');

		const runState = db.runSql(`SELECT status FROM pipeline_runs WHERE id = '${body.data.run_id}';`);
		expect(runState).toBe('completed');

		const pipelineRunSource = db.runSql(
			`SELECT current_step || '|' || status FROM pipeline_run_sources
			 WHERE run_id = '${body.data.run_id}' AND source_id = '${sourceRow}';`,
		);
		expect(pipelineRunSource).toBe('extract|completed');
	});
});
