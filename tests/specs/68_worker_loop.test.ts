import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as db from '../lib/db.js';
import { ensureSchema, truncateMulderTables } from '../lib/schema.js';

const ROOT = resolve(import.meta.dirname, '../..');
const CLI = resolve(ROOT, 'apps/cli/dist/index.js');
const EXAMPLE_CONFIG = resolve(ROOT, 'mulder.config.example.yaml');
const NATIVE_TEXT_PDF = resolve(ROOT, 'fixtures/raw/native-text-sample.pdf');

type JobRecord = {
	status: string;
	worker_id: string;
	attempts: number;
	error_log: string;
	has_started_at: boolean;
	has_finished_at: boolean;
};

type CliResult = {
	stdout: string;
	stderr: string;
	exitCode: number;
};

function runCli(args: string[], opts?: { env?: Record<string, string>; timeout?: number }): CliResult {
	const result = spawnSync('node', [CLI, ...args], {
		cwd: ROOT,
		encoding: 'utf-8',
		timeout: opts?.timeout ?? 30_000,
		stdio: ['pipe', 'pipe', 'pipe'],
		env: {
			...process.env,
			PGPASSWORD: db.TEST_PG_PASSWORD,
			MULDER_LOG_LEVEL: 'silent',
			...opts?.env,
		},
	});

	return {
		stdout: result.stdout ?? '',
		stderr: result.stderr ?? '',
		exitCode: result.status ?? 1,
	};
}

function runPackageTypecheck(dir: string): CliResult {
	const result = spawnSync('pnpm', ['typecheck'], {
		cwd: resolve(ROOT, dir),
		encoding: 'utf-8',
		timeout: 180_000,
		stdio: ['pipe', 'pipe', 'pipe'],
		env: { ...process.env, PGPASSWORD: db.TEST_PG_PASSWORD },
	});

	return {
		stdout: result.stdout ?? '',
		stderr: result.stderr ?? '',
		exitCode: result.status ?? 1,
	};
}

function cleanTables(): void {
	truncateMulderTables();
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
	workerId?: string | null;
	startedAt?: string | null;
	finishedAt?: string | null;
	errorLog?: string | null;
	createdAt?: string | null;
}): void {
	const payload = sqlLiteral(JSON.stringify(opts.payload));
	const status = sqlLiteral(opts.status ?? 'pending');
	const attempts = opts.attempts ?? 0;
	const maxAttempts = opts.maxAttempts ?? 3;
	const workerId = opts.workerId === undefined || opts.workerId === null ? 'NULL' : sqlLiteral(opts.workerId);
	const startedAt = opts.startedAt === undefined || opts.startedAt === null ? 'NULL' : opts.startedAt;
	const finishedAt = opts.finishedAt === undefined || opts.finishedAt === null ? 'NULL' : opts.finishedAt;
	const errorLog = opts.errorLog === undefined || opts.errorLog === null ? 'NULL' : sqlLiteral(opts.errorLog);
	const createdAt = opts.createdAt === undefined || opts.createdAt === null ? 'now()' : opts.createdAt;

	db.runSql(
		[
			'INSERT INTO jobs (id, type, payload, status, attempts, max_attempts, worker_id, started_at, finished_at, error_log, created_at)',
			`VALUES (${sqlLiteral(opts.id)}, ${sqlLiteral(opts.type)}, ${payload}, ${status}, ${attempts}, ${maxAttempts}, ${workerId}, ${startedAt}, ${finishedAt}, ${errorLog}, ${createdAt});`,
		].join(' '),
	);
}

function readJob(jobId: string): JobRecord {
	const row = db.runSql(
		[
			'SELECT row_to_json(job_row)::text',
			'FROM (',
			'  SELECT',
			'    status,',
			"    COALESCE(worker_id, '') AS worker_id,",
			'    attempts,',
			"    COALESCE(error_log, '') AS error_log,",
			'    started_at IS NOT NULL AS has_started_at,',
			'    finished_at IS NOT NULL AS has_finished_at',
			'  FROM jobs',
			`  WHERE id = ${sqlLiteral(jobId)}`,
			') AS job_row;',
		].join('\n'),
	);

	if (!row) {
		throw new Error(`Missing job row: ${jobId}`);
	}

	return JSON.parse(row) as JobRecord;
}

async function waitForJob(
	child: ReturnType<typeof spawn>,
	jobId: string,
	statuses: string[],
	timeoutMs: number,
): Promise<JobRecord> {
	const deadline = Date.now() + timeoutMs;
	let lastRecord: JobRecord | null = null;

	while (Date.now() < deadline) {
		if (child.exitCode !== null) {
			throw new Error(
				`worker exited early with code ${child.exitCode}${child.signalCode ? ` (${child.signalCode})` : ''}`,
			);
		}

		const record = readJob(jobId);
		lastRecord = record;
		if (statuses.includes(record.status)) {
			return record;
		}

		await delay(100);
	}

	throw new Error(`Timed out waiting for job ${jobId}; last state: ${JSON.stringify(lastRecord)}`);
}

function startWorker(args: string[] = []): {
	child: ReturnType<typeof spawn>;
	combinedOutput: () => string;
	closePromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
} {
	const child = spawn('node', [CLI, 'worker', 'start', ...args], {
		cwd: ROOT,
		encoding: 'utf-8',
		stdio: ['ignore', 'pipe', 'pipe'],
		env: {
			...process.env,
			PGPASSWORD: db.TEST_PG_PASSWORD,
			MULDER_LOG_LEVEL: 'info',
		},
	});

	let stdout = '';
	let stderr = '';
	child.stdout?.on('data', (chunk) => {
		stdout += String(chunk);
	});
	child.stderr?.on('data', (chunk) => {
		stderr += String(chunk);
	});

	const closePromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveClose) => {
		child.once('close', (code, signal) => {
			resolveClose({ code, signal });
		});
	});

	return {
		child,
		combinedOutput: () => stdout + stderr,
		closePromise,
	};
}

async function stopWorker(worker: {
	child: ReturnType<typeof spawn>;
	combinedOutput: () => string;
	closePromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
	if (worker.child.exitCode === null) {
		worker.child.kill('SIGINT');
	}
	return worker.closePromise;
}

function expectLabelWithCount(output: string, label: string, count: number): void {
	const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const pattern = new RegExp(`(?:${escaped}[\\s\\S]{0,80}\\b${count}\\b|\\b${count}\\b[\\s\\S]{0,80}${escaped})`, 'i');
	expect(output).toMatch(pattern);
}

describe('Spec 68: Worker Loop', () => {
	const pgAvailable = db.isPgAvailable();

	beforeAll(() => {
		if (!pgAvailable) {
			console.warn('SKIP: PostgreSQL not reachable at PGHOST/PGPORT.');
			return;
		}

		ensureSchema();
		cleanTables();

		const migrate = runCli(['db', 'migrate', EXAMPLE_CONFIG]);
		if (migrate.exitCode !== 0) {
			throw new Error(`Migration failed: ${migrate.stdout}\n${migrate.stderr}`);
		}

		cleanTables();
	});

	afterAll(() => {
		if (pgAvailable) {
			cleanTables();
		}
	});

	it('QA-01: worker start claims and completes a runnable job', async () => {
		if (!pgAvailable) return;

		cleanTables();

		const ingest = runCli(['ingest', NATIVE_TEXT_PDF], { timeout: 120_000 });
		expect(ingest.exitCode, `${ingest.stdout}\n${ingest.stderr}`).toBe(0);

		const sourceId = db.runSql(
			"SELECT id FROM sources WHERE filename = 'native-text-sample.pdf' ORDER BY created_at DESC LIMIT 1;",
		);
		expect(sourceId).toMatch(/^[a-f0-9-]{36}$/);

		const jobId = randomUUID();
		insertJob({
			id: jobId,
			type: 'pipeline_run',
			payload: { sourceId },
			status: 'pending',
			attempts: 0,
			maxAttempts: 3,
		});

		const worker = startWorker();

		try {
			await waitForJob(worker.child, jobId, ['completed'], 120_000);
			const final = readJob(jobId);

			expect(final.status).toBe('completed');
			expect(final.worker_id).not.toBe('');
			expect(final.attempts).toBe(1);
			expect(final.has_started_at).toBe(true);
			expect(final.has_finished_at).toBe(true);
			expect(worker.combinedOutput()).toContain(final.worker_id);
		} finally {
			await stopWorker(worker);
		}
	}, 180_000);

	it('QA-02: failed handlers mark the job failed or dead-letter according to retry state', async () => {
		if (!pgAvailable) return;

		async function runFailureCase(maxAttempts: number): Promise<JobRecord> {
			cleanTables();

			const jobId = randomUUID();
			insertJob({
				id: jobId,
				type: 'pipeline_run',
				payload: {},
				status: 'pending',
				attempts: 0,
				maxAttempts,
			});

			const worker = startWorker(['--poll-interval', '100']);

			try {
				await waitForJob(worker.child, jobId, ['failed', 'dead_letter'], 60_000);
				return readJob(jobId);
			} finally {
				await stopWorker(worker);
			}
		}

		const retryable = await runFailureCase(3);
		expect(retryable.status).toBe('failed');
		expect(retryable.error_log).not.toBe('');
		expect(retryable.has_finished_at).toBe(true);

		const exhausted = await runFailureCase(1);
		expect(exhausted.status).toBe('dead_letter');
		expect(exhausted.error_log).not.toBe('');
		expect(exhausted.has_finished_at).toBe(true);
	}, 180_000);

	it('QA-03: idle polling does not mutate the queue', async () => {
		if (!pgAvailable) return;

		cleanTables();

		const worker = startWorker(['--poll-interval', '100']);

		try {
			await delay(350);
			expect(worker.child.exitCode).toBeNull();

			const before = db.runSql('SELECT count(*) FROM jobs;');
			expect(before).toBe('0');
		} finally {
			await stopWorker(worker);
		}
	}, 30_000);

	it('QA-04: the worker never requires a long-lived transaction around step execution', async () => {
		if (!pgAvailable) return;

		cleanTables();

		const ingest = runCli(['ingest', NATIVE_TEXT_PDF], { timeout: 120_000 });
		expect(ingest.exitCode, `${ingest.stdout}\n${ingest.stderr}`).toBe(0);

		const sourceId = db.runSql(
			"SELECT id FROM sources WHERE filename = 'native-text-sample.pdf' ORDER BY created_at DESC LIMIT 1;",
		);
		expect(sourceId).toMatch(/^[a-f0-9-]{36}$/);

		const jobId = randomUUID();
		insertJob({
			id: jobId,
			type: 'pipeline_run',
			payload: { sourceId },
			status: 'pending',
			attempts: 0,
			maxAttempts: 3,
		});

		const worker = startWorker(['--poll-interval', '100']);

		try {
			await waitForJob(worker.child, jobId, ['running', 'completed', 'failed', 'dead_letter'], 60_000);
			const inFlight = readJob(jobId);
			expect(inFlight.status).toBe('running');
			expect(inFlight.worker_id).not.toBe('');
			expect(inFlight.has_started_at).toBe(true);
			expect(inFlight.has_finished_at).toBe(false);
		} finally {
			await stopWorker(worker);
		}
	}, 180_000);

	it('QA-05: worker status reports running and pending queue state', async () => {
		if (!pgAvailable) return;

		cleanTables();

		insertJob({
			id: randomUUID(),
			type: 'pipeline_run',
			payload: { sourceId: 'pending-a' },
			status: 'pending',
		});
		insertJob({
			id: randomUUID(),
			type: 'pipeline_run',
			payload: { sourceId: 'pending-b' },
			status: 'pending',
		});
		insertJob({
			id: randomUUID(),
			type: 'pipeline_run',
			payload: { sourceId: 'running-a' },
			status: 'running',
			attempts: 1,
			maxAttempts: 3,
			workerId: 'worker-status-a',
			startedAt: "now() - interval '30 minutes'",
		});
		insertJob({
			id: randomUUID(),
			type: 'pipeline_run',
			payload: { sourceId: 'completed-a' },
			status: 'completed',
			attempts: 1,
			maxAttempts: 3,
			workerId: 'worker-status-b',
			startedAt: "now() - interval '2 hours'",
			finishedAt: "now() - interval '1 hour'",
		});
		insertJob({
			id: randomUUID(),
			type: 'pipeline_run',
			payload: { sourceId: 'failed-a' },
			status: 'failed',
			attempts: 1,
			maxAttempts: 3,
			workerId: 'worker-status-c',
			startedAt: "now() - interval '2 hours'",
			finishedAt: "now() - interval '90 minutes'",
			errorLog: 'boom',
		});
		insertJob({
			id: randomUUID(),
			type: 'pipeline_run',
			payload: { sourceId: 'dead-a' },
			status: 'dead_letter',
			attempts: 3,
			maxAttempts: 3,
			workerId: 'worker-status-d',
			startedAt: "now() - interval '3 hours'",
			finishedAt: "now() - interval '2 hours'",
			errorLog: 'exhausted',
		});

		const { stdout, stderr, exitCode } = runCli(['worker', 'status']);
		const combined = stdout + stderr;

		expect(exitCode, combined).toBe(0);
		expect(combined).toContain('worker-status-a');
		expect(combined).toContain('pending');
		expect(combined).toContain('running');
		expect(combined).toContain('completed');
		expect(combined).toContain('failed');
		expect(combined).toContain('dead_letter');
		expectLabelWithCount(combined, 'pending', 2);
		expectLabelWithCount(combined, 'running', 1);
		expectLabelWithCount(combined, 'completed', 1);
		expectLabelWithCount(combined, 'failed', 1);
		expectLabelWithCount(combined, 'dead_letter', 1);
	}, 30_000);

	it('QA-06: worker reap resets stale running jobs and leaves fresh jobs alone', async () => {
		if (!pgAvailable) return;

		cleanTables();

		const staleJobId = randomUUID();
		const freshJobId = randomUUID();

		insertJob({
			id: staleJobId,
			type: 'pipeline_run',
			payload: { sourceId: 'stale' },
			status: 'running',
			attempts: 1,
			maxAttempts: 3,
			workerId: 'worker-stale',
			startedAt: "now() - interval '3 hours'",
		});
		insertJob({
			id: freshJobId,
			type: 'pipeline_run',
			payload: { sourceId: 'fresh' },
			status: 'running',
			attempts: 1,
			maxAttempts: 3,
			workerId: 'worker-fresh',
			startedAt: "now() - interval '20 minutes'",
		});

		const { stdout, stderr, exitCode } = runCli(['worker', 'reap']);
		const combined = stdout + stderr;
		expect(exitCode, combined).toBe(0);

		const stale = readJob(staleJobId);
		const fresh = readJob(freshJobId);

		expect(stale.status).toBe('pending');
		expect(stale.worker_id).toBe('');
		expect(stale.has_started_at).toBe(false);
		expect(fresh.status).toBe('running');
		expect(fresh.worker_id).toBe('worker-fresh');
		expect(fresh.has_started_at).toBe(true);
	}, 30_000);

	it('QA-07: graceful shutdown stops polling without corrupting the claimed job state', async () => {
		if (!pgAvailable) return;

		cleanTables();

		const worker = startWorker(['--poll-interval', '100']);

		try {
			await delay(250);
			const close = stopWorker(worker);
			const result = await close;
			const output = worker.combinedOutput().toLowerCase();

			expect(result.code).toBe(0);
			expect(output).toMatch(/stop|shutdown|sigint|shutting down/);
			expect(db.runSql('SELECT count(*) FROM jobs;')).toBe('0');
		} finally {
			await stopWorker(worker);
		}
	}, 30_000);

	it('QA-08: public package exports and CLI registration compile cleanly', () => {
		const workerTypecheck = runPackageTypecheck('packages/worker');
		expect(workerTypecheck.exitCode, `${workerTypecheck.stdout}\n${workerTypecheck.stderr}`).toBe(0);

		const cliTypecheck = runPackageTypecheck('apps/cli');
		expect(cliTypecheck.exitCode, `${cliTypecheck.stdout}\n${cliTypecheck.stderr}`).toBe(0);
	});

	describe('CLI smoke', () => {
		it('worker --help lists the worker subcommands', () => {
			const { stdout, stderr, exitCode } = runCli(['worker', '--help']);
			const combined = stdout + stderr;

			expect(exitCode, combined).toBe(0);
			expect(combined).toContain('start');
			expect(combined).toContain('status');
			expect(combined).toContain('reap');
		});

		it('worker start --help lists runtime flags', () => {
			const { stdout, stderr, exitCode } = runCli(['worker', 'start', '--help']);
			const combined = stdout + stderr;

			expect(exitCode, combined).toBe(0);
			expect(combined).toContain('--concurrency');
			expect(combined).toContain('--poll-interval');
		});
	});
});
