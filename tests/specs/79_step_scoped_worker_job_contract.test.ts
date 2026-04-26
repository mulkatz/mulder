import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import type { WorkerRuntimeContext } from '@mulder/worker';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as db from '../lib/db.js';
import { truncateMulderTables } from '../lib/schema.js';

const ROOT = resolve(import.meta.dirname, '../..');
const CORE_DIR = resolve(ROOT, 'packages/core');
const PIPELINE_DIR = resolve(ROOT, 'packages/pipeline');
const WORKER_DIR = resolve(ROOT, 'packages/worker');

const CORE_DIST = resolve(CORE_DIR, 'dist/index.js');
const PIPELINE_DIST = resolve(PIPELINE_DIR, 'dist/index.js');
const WORKER_DIST = resolve(WORKER_DIR, 'dist/index.js');
const EXAMPLE_CONFIG = resolve(ROOT, 'mulder.config.example.yaml');
const FIXTURE_PDF = resolve(ROOT, 'fixtures/raw/native-text-sample.pdf');
const STORAGE_ROOT = resolve(ROOT, '.local/storage');
const CORE_MIGRATIONS_DIR = resolve(ROOT, 'packages/core/src/database/migrations');

type JobState = {
	status: string;
	errorLog: string;
	workerId: string;
	startedAtVisible: boolean;
	finishedAtVisible: boolean;
};

let coreModule: typeof import('@mulder/core');
let pipelineModule: typeof import('@mulder/pipeline');
let workerModule: typeof import('@mulder/worker');
let workerContext: WorkerRuntimeContext;

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
	truncateMulderTables();
}

function cleanStorage(): void {
	for (const relativeDir of ['raw', 'extracted', 'segments']) {
		const dir = resolve(STORAGE_ROOT, relativeDir);
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

function sqlLiteral(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

function insertJob(opts: {
	id: string;
	type: string;
	payload: Record<string, unknown>;
	status?: string;
	attempts?: number;
	maxAttempts?: number;
}): void {
	db.runSql(
		[
			'INSERT INTO jobs (id, type, payload, status, attempts, max_attempts, created_at)',
			`VALUES (${sqlLiteral(opts.id)}, ${sqlLiteral(opts.type)}, ${sqlLiteral(JSON.stringify(opts.payload))}, ${sqlLiteral(opts.status ?? 'pending')}, ${opts.attempts ?? 0}, ${opts.maxAttempts ?? 3}, now());`,
		].join(' '),
	);
}

function readJob(jobId: string): JobState {
	const row = db.runSql(
		[
			'SELECT row_to_json(job_row)::text',
			'FROM (',
			'  SELECT',
			'    status,',
			'    COALESCE(error_log, \'\') AS "errorLog",',
			'    COALESCE(worker_id, \'\') AS "workerId",',
			'    started_at IS NOT NULL AS "startedAtVisible",',
			'    finished_at IS NOT NULL AS "finishedAtVisible"',
			'  FROM jobs',
			`  WHERE id = ${sqlLiteral(jobId)}`,
			') AS job_row;',
		].join('\n'),
	);

	return JSON.parse(row) as JobState;
}

function getLatestStoryId(sourceId: string): string {
	return db.runSql(`SELECT id FROM stories WHERE source_id = ${sqlLiteral(sourceId)} ORDER BY created_at ASC LIMIT 1;`);
}

function getSourceStatus(sourceId: string): string {
	return db.runSql(`SELECT status FROM sources WHERE id = ${sqlLiteral(sourceId)};`);
}

function getStoryStatus(storyId: string): string {
	return db.runSql(`SELECT status FROM stories WHERE id = ${sqlLiteral(storyId)};`);
}

async function prepareStepTarget(jobType: 'extract' | 'segment' | 'enrich' | 'embed' | 'graph'): Promise<{
	sourceId: string;
	storyId?: string;
}> {
	const sourceId = randomUUID();
	const pdfBuffer = readFileSync(FIXTURE_PDF);
	const storagePath = `raw/${sourceId}/original.pdf`;
	const fileHash = createHash('sha256').update(pdfBuffer).digest('hex');
	const textResult = await coreModule.detectNativeText(pdfBuffer);

	await workerContext.services.storage.upload(storagePath, pdfBuffer, 'application/pdf');
	await coreModule.createSource(workerContext.pool, {
		id: sourceId,
		filename: 'native-text-sample.pdf',
		storagePath,
		fileHash,
		pageCount: textResult.pageCount,
		hasNativeText: textResult.hasNativeText,
		nativeTextRatio: textResult.nativeTextRatio,
		tags: [],
		metadata: {},
	});
	await coreModule.upsertSourceStep(workerContext.pool, {
		sourceId,
		stepName: 'ingest',
		status: 'completed',
	});

	if (jobType === 'extract') {
		return { sourceId };
	}

	await pipelineModule.executeExtract(
		{ sourceId },
		workerContext.config,
		workerContext.services,
		workerContext.pool,
		workerContext.logger,
	);
	if (jobType === 'segment') {
		return { sourceId };
	}

	await pipelineModule.executeSegment(
		{ sourceId },
		workerContext.config,
		workerContext.services,
		workerContext.pool,
		workerContext.logger,
	);
	const storyId = getLatestStoryId(sourceId);
	if (jobType === 'enrich') {
		return { sourceId, storyId };
	}

	await pipelineModule.executeEnrich(
		{ storyId },
		workerContext.config,
		workerContext.services,
		workerContext.pool,
		workerContext.logger,
	);
	if (jobType === 'embed') {
		return { sourceId, storyId };
	}

	await pipelineModule.executeEmbed(
		{ storyId },
		workerContext.config,
		workerContext.services,
		workerContext.pool,
		workerContext.logger,
	);
	return { sourceId, storyId };
}

async function processOneJob(context: WorkerRuntimeContext, workerModule: typeof import('@mulder/worker')) {
	return await workerModule.processNextJob(context, 'spec-79-worker');
}

describe('Spec 79: Step-Scoped Worker Job Contract', () => {
	beforeAll(async () => {
		db.requirePg();
		process.env.MULDER_CONFIG = EXAMPLE_CONFIG;
		process.env.MULDER_LOG_LEVEL = 'silent';
		process.env.NODE_ENV = 'test';

		buildPackage(CORE_DIR);
		buildPackage(PIPELINE_DIR);
		buildPackage(WORKER_DIR);

		coreModule = await import(pathToFileURL(CORE_DIST).href);
		pipelineModule = await import(pathToFileURL(PIPELINE_DIST).href);
		workerModule = await import(pathToFileURL(WORKER_DIST).href);

		const config = coreModule.loadConfig(EXAMPLE_CONFIG);
		const cloudSqlConfig = config.gcp?.cloud_sql;
		if (!cloudSqlConfig) {
			throw new Error('Expected example config to include gcp.cloud_sql');
		}

		const logger = coreModule.createLogger({ level: 'silent' });
		workerContext = {
			config,
			services: coreModule.createServiceRegistry(config, logger),
			pool: coreModule.getWorkerPool(cloudSqlConfig),
			logger,
		};
		await coreModule.runMigrations(workerContext.pool, CORE_MIGRATIONS_DIR);
		cleanState();
		cleanStorage();
	}, 600_000);

	beforeEach(() => {
		cleanState();
		cleanStorage();
	});

	afterAll(() => {
		try {
			cleanState();
			cleanStorage();
		} catch {
			// Ignore cleanup failures.
		}
	});

	it('QA-01: the worker executes a step-scoped extract job', async () => {
		const { sourceId } = await prepareStepTarget('extract');
		const jobId = randomUUID();
		insertJob({ id: jobId, type: 'extract', payload: { sourceId } });

		const result = await processOneJob(workerContext, workerModule);
		expect(result.state).toBe('completed');
		expect(result.job?.type).toBe('extract');
		expect(getSourceStatus(sourceId)).toBe('extracted');

		const job = readJob(jobId);
		expect(job.status).toBe('completed');
		expect(job.errorLog).toBe('');
		expect(job.startedAtVisible).toBe(true);
		expect(job.finishedAtVisible).toBe(true);
	});

	it.each([
		['segment', 'segmented'],
		['enrich', 'enriched'],
		['embed', 'embedded'],
		['graph', 'graphed'],
	] as const)('QA-02: the worker executes a step-scoped %s job', async (jobType, expectedStatus) => {
		const { sourceId, storyId } = await prepareStepTarget(jobType);
		const jobId = randomUUID();
		const payload = storyId ? { storyId } : { sourceId };

		insertJob({ id: jobId, type: jobType, payload });

		const result = await processOneJob(workerContext, workerModule);
		expect(result.state).toBe('completed');
		expect(result.job?.type).toBe(jobType);

		if (storyId) {
			expect(getStoryStatus(storyId)).toBe(expectedStatus);
		} else {
			expect(getSourceStatus(sourceId)).toBe(expectedStatus);
		}

		const job = readJob(jobId);
		expect(job.status).toBe('completed');
		expect(job.errorLog).toBe('');
	});

	it('QA-03: malformed step payloads fail at the worker boundary', async () => {
		const jobId = randomUUID();
		insertJob({ id: jobId, type: 'extract', payload: {}, maxAttempts: 1 });

		const result = await processOneJob(workerContext, workerModule);
		expect(result.state).toBe('dead_letter');

		const job = readJob(jobId);
		expect(job.status).toBe('dead_letter');
		expect(job.errorLog).toContain('[WORKER_INVALID_JOB_PAYLOAD]');
		expect(job.errorLog).toContain('extract jobs require a non-empty sourceId');
	});

	it.each([
		['enrich', 'enriched'],
		['embed', 'embedded'],
		['graph', 'graphed'],
	] as const)('QA-03b: the worker executes a source-scoped downstream %s job', async (jobType, expectedStatus) => {
		const { sourceId, storyId } = await prepareStepTarget(jobType);
		const jobId = randomUUID();
		insertJob({ id: jobId, type: jobType, payload: { sourceId } });

		const result = await processOneJob(workerContext, workerModule);
		expect(result.state).toBe('completed');
		expect(result.job?.type).toBe(jobType);
		expect(storyId).toBeDefined();
		expect(getStoryStatus(storyId ?? '')).toBe(expectedStatus);

		const job = readJob(jobId);
		expect(job.status).toBe('completed');
		expect(job.errorLog).toBe('');
	});

	it('QA-04: legacy pipeline_run compatibility remains intact during migration', async () => {
		const { sourceId } = await prepareStepTarget('extract');
		const jobId = randomUUID();
		insertJob({
			id: jobId,
			type: 'pipeline_run',
			payload: {
				sourceId,
				from: 'extract',
				upTo: 'extract',
				tag: 'spec-79-compat',
			},
		});

		const result = await processOneJob(workerContext, workerModule);
		expect(result.state).toBe('completed');
		expect(result.job?.type).toBe('pipeline_run');
		expect(getSourceStatus(sourceId)).toBe('extracted');
		expect(Number(db.runSql('SELECT COUNT(*) FROM pipeline_runs;'))).toBeGreaterThan(0);

		const job = readJob(jobId);
		expect(job.status).toBe('completed');
		expect(job.errorLog).toBe('');
	});

	it('QA-05: step-scoped jobs do not require a long-lived transaction', async () => {
		const { sourceId } = await prepareStepTarget('extract');
		const jobId = randomUUID();
		insertJob({ id: jobId, type: 'extract', payload: { sourceId } });

		let observedWhileDispatch: JobState | null = null;
		const result = await workerModule.processNextJob(
			{
				...workerContext,
				dispatch: async () => {
					observedWhileDispatch = readJob(jobId);
					await delay(100);
					return { observed: true };
				},
			},
			'spec-79-transaction-worker',
		);

		expect(result.state).toBe('completed');
		expect(observedWhileDispatch).not.toBeNull();
		expect(observedWhileDispatch?.status).toBe('running');
		expect(observedWhileDispatch?.workerId).toBe('spec-79-transaction-worker');
		expect(observedWhileDispatch?.startedAtVisible).toBe(true);
		expect(observedWhileDispatch?.finishedAtVisible).toBe(false);

		const finalJob = readJob(jobId);
		expect(finalJob.status).toBe('completed');
		expect(finalJob.finishedAtVisible).toBe(true);
	});
});
