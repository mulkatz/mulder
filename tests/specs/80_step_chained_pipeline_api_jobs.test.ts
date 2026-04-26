import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { WorkerRuntimeContext } from '@mulder/worker';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as db from '../lib/db.js';

const ROOT = resolve(import.meta.dirname, '../..');
const CORE_DIR = resolve(ROOT, 'packages/core');
const PIPELINE_DIR = resolve(ROOT, 'packages/pipeline');
const WORKER_DIR = resolve(ROOT, 'packages/worker');
const API_DIR = resolve(ROOT, 'apps/api');
const CORE_DIST = resolve(CORE_DIR, 'dist/index.js');
const WORKER_DIST = resolve(WORKER_DIR, 'dist/index.js');
const API_APP_DIST = resolve(API_DIR, 'dist/app.js');
const EXAMPLE_CONFIG = resolve(ROOT, 'mulder.config.example.yaml');
const CORE_MIGRATIONS_DIR = resolve(ROOT, 'packages/core/src/database/migrations');

interface AcceptedResponse {
	data: {
		job_id: string;
		run_id: string;
		status: 'pending';
	};
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
}

function cleanState(): void {
	db.runSql(
		[
			'DELETE FROM monthly_budget_reservations',
			'DELETE FROM jobs',
			'DELETE FROM pipeline_run_sources',
			'DELETE FROM pipeline_runs',
			'DELETE FROM sources',
		].join('; '),
	);
}

function insertSource(sourceId: string): void {
	const fileHash = `${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '')}`;
	db.runSql(
		[
			'INSERT INTO sources (id, filename, storage_path, file_hash, page_count, has_native_text, native_text_ratio, status, reliability_score, tags, metadata)',
			`VALUES ('${sourceId}', 'step-chain.pdf', '/tmp/step-chain.pdf', '${fileHash}', 1, true, 1, 'ingested', NULL, ARRAY[]::text[], '{}'::jsonb);`,
		].join(' '),
	);
}

async function loadApiApp(): Promise<{ request: (input: string | Request, init?: RequestInit) => Promise<Response> }> {
	const module = await import(pathToFileURL(API_APP_DIST).href);
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
			budget: {
				enabled: true,
				monthly_limit_usd: 50,
				extract_per_page_usd: 0.006,
				segment_per_page_usd: 0.002,
				enrich_per_source_usd: 0.015,
				embed_per_source_usd: 0.004,
				graph_per_source_usd: 0.001,
			},
		},
	});
}

async function apiPost(app: Awaited<ReturnType<typeof loadApiApp>>, path: string, body: unknown): Promise<Response> {
	return await app.request(`http://localhost${path}`, {
		method: 'POST',
		headers: {
			Authorization: 'Bearer test-api-key',
			'Content-Type': 'application/json',
			'X-Forwarded-For': '203.0.113.80',
		},
		body: JSON.stringify(body),
	});
}

describe('Spec 80: Step-chained async pipeline API jobs', () => {
	let app: Awaited<ReturnType<typeof loadApiApp>>;
	let coreModule: typeof import('@mulder/core');
	let workerModule: typeof import('@mulder/worker');
	let workerContext: WorkerRuntimeContext;

	beforeAll(async () => {
		db.requirePg();
		process.env.MULDER_CONFIG = EXAMPLE_CONFIG;
		process.env.MULDER_LOG_LEVEL = 'silent';

		buildPackage(CORE_DIR);
		buildPackage(PIPELINE_DIR);
		buildPackage(WORKER_DIR);
		buildPackage(API_DIR);

		coreModule = await import(pathToFileURL(CORE_DIST).href);
		workerModule = await import(pathToFileURL(WORKER_DIST).href);
		const config = coreModule.loadConfig(EXAMPLE_CONFIG);
		const cloudSql = config.gcp?.cloud_sql;
		if (!cloudSql) {
			throw new Error('Expected example config to include gcp.cloud_sql');
		}

		workerContext = {
			config,
			services: {} as never,
			pool: coreModule.getWorkerPool(cloudSql),
			logger: coreModule.createLogger({ level: 'silent' }),
			dispatch: async () => ({ ok: true }),
		};

		await coreModule.runMigrations(workerContext.pool, CORE_MIGRATIONS_DIR);
		app = await loadApiApp();
		cleanState();
	}, 600_000);

	beforeEach(() => {
		cleanState();
	});

	afterAll(() => {
		try {
			cleanState();
		} catch {
			// Ignore cleanup failures.
		}
	});

	it('QA-01/05: accepted runs enqueue a first step job and no pipeline_run row', async () => {
		const sourceId = randomUUID();
		insertSource(sourceId);

		const response = await apiPost(app, '/api/pipeline/run', {
			source_id: sourceId,
			from: 'extract',
			up_to: 'segment',
			tag: 'spec-80',
		});

		expect(response.status).toBe(202);
		const body = (await response.json()) as AcceptedResponse;
		expect(db.runSql(`SELECT type FROM jobs WHERE id = '${body.data.job_id}';`)).toBe('extract');
		expect(db.runSql("SELECT COUNT(*) FROM jobs WHERE type = 'pipeline_run';")).toBe('0');
		expect(
			db.runSql(
				`SELECT current_step || '|' || status FROM pipeline_run_sources WHERE run_id = '${body.data.run_id}' AND source_id = '${sourceId}';`,
			),
		).toBe('ingest|pending');
	});

	it('QA-02/03: worker success chains the next step and stops at up_to', async () => {
		const sourceId = randomUUID();
		insertSource(sourceId);
		const accepted = await apiPost(app, '/api/pipeline/run', {
			source_id: sourceId,
			from: 'extract',
			up_to: 'segment',
			tag: 'spec-80-chain',
		});
		const body = (await accepted.json()) as AcceptedResponse;

		const first = await workerModule.processNextJob(workerContext, 'spec-80-worker-a');
		expect(first.state).toBe('completed');
		expect(first.job?.id).toBe(body.data.job_id);

		const nextJob = db.runSql(
			`SELECT type FROM jobs WHERE payload->>'runId' = '${body.data.run_id}' AND status = 'pending' ORDER BY created_at DESC LIMIT 1;`,
		);
		expect(nextJob).toBe('segment');
		expect(
			db.runSql(
				`SELECT current_step || '|' || status FROM pipeline_run_sources WHERE run_id = '${body.data.run_id}' AND source_id = '${sourceId}';`,
			),
		).toBe('extract|processing');

		const second = await workerModule.processNextJob(workerContext, 'spec-80-worker-b');
		expect(second.state).toBe('completed');
		expect(second.job?.type).toBe('segment');
		expect(db.runSql(`SELECT status FROM pipeline_runs WHERE id = '${body.data.run_id}';`)).toBe('completed');
		expect(
			db.runSql(
				`SELECT current_step || '|' || status FROM pipeline_run_sources WHERE run_id = '${body.data.run_id}' AND source_id = '${sourceId}';`,
			),
		).toBe('segment|completed');
		expect(db.runSql(`SELECT COUNT(*) FROM jobs WHERE payload->>'runId' = '${body.data.run_id}';`)).toBe('2');
	});

	it('QA-04: retry acceptance creates one explicit failed-step job', async () => {
		const sourceId = randomUUID();
		const failedRunId = randomUUID();
		insertSource(sourceId);
		db.runSql(
			[
				`INSERT INTO pipeline_runs (id, tag, options, status, created_at, finished_at) VALUES ('${failedRunId}', 'failed-seed', '{}'::jsonb, 'failed', now(), now())`,
				`INSERT INTO pipeline_run_sources (run_id, source_id, current_step, status, error_message, updated_at) VALUES ('${failedRunId}', '${sourceId}', 'embed', 'failed', 'seeded', now())`,
			].join('; '),
		);

		const response = await apiPost(app, '/api/pipeline/retry', {
			source_id: sourceId,
		});

		expect(response.status).toBe(202);
		const body = (await response.json()) as AcceptedResponse;
		expect(db.runSql(`SELECT type FROM jobs WHERE id = '${body.data.job_id}';`)).toBe('embed');
		expect(
			JSON.parse(db.runSql(`SELECT payload::text FROM jobs WHERE id = '${body.data.job_id}';`)) as Record<
				string,
				unknown
			>,
		).toMatchObject({
			sourceId,
			upTo: 'embed',
			force: true,
		});
	});
});
