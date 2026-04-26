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
const CORE_DIST = resolve(CORE_DIR, 'dist/index.js');
const WORKER_DIST = resolve(WORKER_DIR, 'dist/index.js');
const EXAMPLE_CONFIG = resolve(ROOT, 'mulder.config.example.yaml');
const CORE_MIGRATIONS_DIR = resolve(ROOT, 'packages/core/src/database/migrations');

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

function cleanJobs(): void {
	db.runSql('DELETE FROM jobs;');
}

function insertStepJob(input: { id: string; maxAttempts: number }): void {
	db.runSql(
		[
			'INSERT INTO jobs (id, type, payload, status, attempts, max_attempts, created_at)',
			`VALUES ('${input.id}', 'extract', '${JSON.stringify({ sourceId: randomUUID() })}'::jsonb, 'pending', 0, ${input.maxAttempts}, now());`,
		].join(' '),
	);
}

function readJobState(jobId: string): string {
	return db.runSql(
		[
			'SELECT status || \'|\' || attempts::text || \'|\' || COALESCE(worker_id, \'\') || \'|\' ||',
			'(started_at IS NULL)::text || \'|\' || (finished_at IS NULL)::text || \'|\' || COALESCE(error_log, \'\')',
			'FROM jobs',
			`WHERE id = '${jobId}';`,
		].join(' '),
	);
}

describe('Spec 81: Automatic Queue Retry Before Dead Letter', () => {
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
			dispatch: async () => {
				throw new Error('transient failure');
			},
		};

		await coreModule.runMigrations(workerContext.pool, CORE_MIGRATIONS_DIR);
		cleanJobs();
	}, 600_000);

	beforeEach(() => {
		cleanJobs();
	});

	afterAll(() => {
		try {
			cleanJobs();
		} catch {
			// Ignore cleanup failures.
		}
	});

	it('QA-01: retryable handler failure returns the job to pending', async () => {
		const jobId = randomUUID();
		insertStepJob({ id: jobId, maxAttempts: 3 });

		const result = await workerModule.processNextJob(workerContext, 'spec-81-retry-worker');

		expect(result.state).toBe('failed');
		expect(readJobState(jobId)).toContain('pending|1||true|true|transient failure');
	});

	it('QA-02: exhausted handler failure moves the job to dead_letter', async () => {
		const jobId = randomUUID();
		insertStepJob({ id: jobId, maxAttempts: 1 });

		const result = await workerModule.processNextJob(workerContext, 'spec-81-dlq-worker');

		expect(result.state).toBe('dead_letter');
		expect(readJobState(jobId)).toContain('dead_letter|1|spec-81-dlq-worker|false|false|transient failure');
	});
});
