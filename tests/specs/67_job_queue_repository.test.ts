import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as db from '../lib/db.js';

const ROOT = resolve(import.meta.dirname, '../..');
const CLI = resolve(ROOT, 'apps/cli/dist/index.js');
const EXAMPLE_CONFIG = resolve(ROOT, 'mulder.config.example.yaml');
const DB_MODULE = resolve(ROOT, 'packages/core/dist/database/index.js');
const CORE_MODULE = resolve(ROOT, 'packages/core/dist/index.js');

const DB_CONFIG_JSON = JSON.stringify({
	instance_name: 'mulder-db',
	database: 'mulder',
	tier: 'db-custom-2-8192',
	host: 'localhost',
	port: 5432,
	user: 'mulder',
});

let tmpDir: string;

function runCli(
	args: string[],
	opts?: { env?: Record<string, string>; timeout?: number },
): { stdout: string; stderr: string; exitCode: number } {
	const result = spawnSync('node', [CLI, ...args], {
		cwd: ROOT,
		encoding: 'utf-8',
		timeout: opts?.timeout ?? 30000,
		stdio: ['pipe', 'pipe', 'pipe'],
		env: { ...process.env, PGPASSWORD: db.TEST_PG_PASSWORD, ...opts?.env },
	});
	return {
		stdout: result.stdout ?? '',
		stderr: result.stderr ?? '',
		exitCode: result.status ?? 1,
	};
}

function runScript(
	scriptContent: string,
	opts?: { env?: Record<string, string>; timeout?: number },
): { stdout: string; stderr: string; exitCode: number } {
	const scriptPath = join(tmpDir, `helper-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);
	writeFileSync(scriptPath, scriptContent, 'utf-8');

	const result = spawnSync('node', [scriptPath], {
		cwd: ROOT,
		encoding: 'utf-8',
		timeout: opts?.timeout ?? 30000,
		stdio: ['pipe', 'pipe', 'pipe'],
		env: { ...process.env, PGPASSWORD: db.TEST_PG_PASSWORD, ...opts?.env },
	});
	return {
		stdout: result.stdout ?? '',
		stderr: result.stderr ?? '',
		exitCode: result.status ?? 1,
	};
}

function cleanJobData(): void {
	db.runSql('DELETE FROM jobs;');
}

describe('Spec 67: Job Queue Repository', () => {
	let pgAvailable: boolean;

	beforeAll(() => {
		pgAvailable = db.isPgAvailable();
		if (!pgAvailable) {
			console.warn('SKIP: PostgreSQL not reachable at PGHOST/PGPORT.');
			return;
		}

		tmpDir = mkdtempSync(join(tmpdir(), 'mulder-qa-67-'));

		const { exitCode, stdout, stderr } = runCli(['db', 'migrate', EXAMPLE_CONFIG]);
		if (exitCode !== 0) {
			throw new Error(`Migration failed: ${stdout} ${stderr}`);
		}

		cleanJobData();
	});

	afterAll(() => {
		if (tmpDir) {
			rmSync(tmpDir, { recursive: true, force: true });
		}
		if (pgAvailable) {
			cleanJobData();
		}
	});

	it('QA-01: enqueue creates a pending job with the expected defaults', () => {
		if (!pgAvailable) return;

		cleanJobData();

		const { stdout, stderr, exitCode } = runScript(`
			import { closeAllPools, enqueueJob, getWorkerPool } from '${DB_MODULE}';

			const config = ${DB_CONFIG_JSON};
			const pool = getWorkerPool(config);

			try {
				const job = await enqueueJob(pool, {
					type: 'pipeline_run',
					payload: { sourceId: 'qa01-source' },
				});

				process.stderr.write('ID:' + job.id + '\\n');
				process.stderr.write('STATUS:' + job.status + '\\n');
				process.stderr.write('ATTEMPTS:' + job.attempts + '\\n');
				process.stderr.write('PAYLOAD_SOURCE:' + job.payload.sourceId + '\\n');
				process.stderr.write('MAX_ATTEMPTS:' + job.maxAttempts + '\\n');
			} catch (error) {
				process.stderr.write('SCRIPT_ERROR:' + error.message + '\\n');
				process.exit(1);
			} finally {
				await closeAllPools();
			}
		`);

		const combined = stdout + stderr;
		expect(exitCode).toBe(0);
		expect(combined).not.toContain('SCRIPT_ERROR:');
		expect(combined).toMatch(/ID:[0-9a-f-]+/);
		expect(combined).toContain('STATUS:pending');
		expect(combined).toContain('ATTEMPTS:0');
		expect(combined).toContain('PAYLOAD_SOURCE:qa01-source');
		expect(combined).toContain('MAX_ATTEMPTS:3');

		const dbState = db.runSql(
			"SELECT status || '|' || attempts::text || '|' || (payload->>'sourceId') FROM jobs WHERE type = 'pipeline_run';",
		);
		expect(dbState).toBe('pending|0|qa01-source');
	});

	it('QA-02: job lookup and filtered listing expose queue state newest-first', () => {
		if (!pgAvailable) return;

		cleanJobData();
		db.runSql(`
			INSERT INTO jobs (id, type, payload, status, created_at)
			VALUES
				('00000000-0000-0000-0000-000000067201', 'pipeline_run', '{"sourceId":"oldest"}', 'pending', now() - interval '3 minutes'),
				('00000000-0000-0000-0000-000000067202', 'ground_batch', '{"sourceId":"middle"}', 'failed', now() - interval '2 minutes'),
				('00000000-0000-0000-0000-000000067203', 'pipeline_run', '{"sourceId":"newest"}', 'running', now() - interval '1 minute');
		`);

		const { stdout, stderr, exitCode } = runScript(`
			import { closeAllPools, countJobs, findJobById, findJobs, getWorkerPool } from '${DB_MODULE}';

			const config = ${DB_CONFIG_JSON};
			const pool = getWorkerPool(config);

			try {
				const found = await findJobById(pool, '00000000-0000-0000-0000-000000067202');
				const newestFirst = await findJobs(pool);
				const pipelineJobs = await findJobs(pool, { type: 'pipeline_run' });
				const failedJobs = await findJobs(pool, { status: 'failed' });
				const failedCount = await countJobs(pool, { status: 'failed' });

				process.stderr.write('FOUND_STATUS:' + found?.status + '\\n');
				process.stderr.write('FOUND_TYPE:' + found?.type + '\\n');
				process.stderr.write('ORDER:' + newestFirst.map((job) => job.id).join(',') + '\\n');
				process.stderr.write('PIPELINE_IDS:' + pipelineJobs.map((job) => job.id).join(',') + '\\n');
				process.stderr.write('FAILED_IDS:' + failedJobs.map((job) => job.id).join(',') + '\\n');
				process.stderr.write('FAILED_COUNT:' + failedCount + '\\n');
			} catch (error) {
				process.stderr.write('SCRIPT_ERROR:' + error.message + '\\n');
				process.exit(1);
			} finally {
				await closeAllPools();
			}
		`);

		const combined = stdout + stderr;
		expect(exitCode).toBe(0);
		expect(combined).not.toContain('SCRIPT_ERROR:');
		expect(combined).toContain('FOUND_STATUS:failed');
		expect(combined).toContain('FOUND_TYPE:ground_batch');
		expect(combined).toContain(
			'ORDER:00000000-0000-0000-0000-000000067203,00000000-0000-0000-0000-000000067202,00000000-0000-0000-0000-000000067201',
		);
		expect(combined).toContain(
			'PIPELINE_IDS:00000000-0000-0000-0000-000000067203,00000000-0000-0000-0000-000000067201',
		);
		expect(combined).toContain('FAILED_IDS:00000000-0000-0000-0000-000000067202');
		expect(combined).toContain('FAILED_COUNT:1');
	});

	it('QA-03: dequeue claims the oldest runnable pending job exactly once', () => {
		if (!pgAvailable) return;

		cleanJobData();
		db.runSql(`
			INSERT INTO jobs (id, type, payload, status, created_at)
			VALUES
				('00000000-0000-0000-0000-000000067301', 'pipeline_run', '{"sourceId":"first"}', 'pending', now() - interval '2 minutes'),
				('00000000-0000-0000-0000-000000067302', 'pipeline_run', '{"sourceId":"second"}', 'pending', now() - interval '1 minute');
		`);

		const { stdout, stderr, exitCode } = runScript(`
			import { closeAllPools, dequeueJob, getWorkerPool } from '${DB_MODULE}';

			const config = ${DB_CONFIG_JSON};
			const pool = getWorkerPool(config);

			try {
				const first = await dequeueJob(pool, 'worker-qa03-a');
				const second = await dequeueJob(pool, 'worker-qa03-b');

				process.stderr.write('FIRST_ID:' + first?.id + '\\n');
				process.stderr.write('FIRST_STATUS:' + first?.status + '\\n');
				process.stderr.write('FIRST_ATTEMPTS:' + first?.attempts + '\\n');
				process.stderr.write('FIRST_WORKER:' + first?.workerId + '\\n');
				process.stderr.write('SECOND_ID:' + second?.id + '\\n');
			} catch (error) {
				process.stderr.write('SCRIPT_ERROR:' + error.message + '\\n');
				process.exit(1);
			} finally {
				await closeAllPools();
			}
		`);

		const combined = stdout + stderr;
		expect(exitCode).toBe(0);
		expect(combined).not.toContain('SCRIPT_ERROR:');
		expect(combined).toContain('FIRST_ID:00000000-0000-0000-0000-000000067301');
		expect(combined).toContain('FIRST_STATUS:running');
		expect(combined).toContain('FIRST_ATTEMPTS:1');
		expect(combined).toContain('FIRST_WORKER:worker-qa03-a');
		expect(combined).toContain('SECOND_ID:00000000-0000-0000-0000-000000067302');
		expect(combined).not.toContain('SECOND_ID:00000000-0000-0000-0000-000000067301');
	});

	it('QA-04: dequeue skips unrunnable jobs', () => {
		if (!pgAvailable) return;

		cleanJobData();
		db.runSql(`
			INSERT INTO jobs (id, type, payload, status, attempts, max_attempts, worker_id, started_at, created_at)
			VALUES
				('00000000-0000-0000-0000-000000067401', 'pipeline_run', '{"state":"running"}', 'running', 1, 3, 'worker-old', now() - interval '5 minutes', now() - interval '6 minutes'),
				('00000000-0000-0000-0000-000000067402', 'pipeline_run', '{"state":"completed"}', 'completed', 1, 3, 'worker-done', now() - interval '4 minutes', now() - interval '6 minutes'),
				('00000000-0000-0000-0000-000000067403', 'pipeline_run', '{"state":"failed"}', 'failed', 1, 3, 'worker-failed', now() - interval '4 minutes', now() - interval '6 minutes'),
				('00000000-0000-0000-0000-000000067404', 'pipeline_run', '{"state":"dead"}', 'dead_letter', 3, 3, 'worker-dead', now() - interval '4 minutes', now() - interval '6 minutes'),
				('00000000-0000-0000-0000-000000067405', 'pipeline_run', '{"state":"exhausted"}', 'pending', 3, 3, NULL, NULL, now() - interval '3 minutes'),
				('00000000-0000-0000-0000-000000067406', 'pipeline_run', '{"state":"runnable"}', 'pending', 0, 3, NULL, NULL, now() - interval '2 minutes');
		`);

		const { stdout, stderr, exitCode } = runScript(`
			import { closeAllPools, dequeueJob, getWorkerPool } from '${DB_MODULE}';

			const config = ${DB_CONFIG_JSON};
			const pool = getWorkerPool(config);

			try {
				const job = await dequeueJob(pool, 'worker-qa04');
				process.stderr.write('CLAIMED_ID:' + job?.id + '\\n');
				process.stderr.write('CLAIMED_STATUS:' + job?.status + '\\n');
			} catch (error) {
				process.stderr.write('SCRIPT_ERROR:' + error.message + '\\n');
				process.exit(1);
			} finally {
				await closeAllPools();
			}
		`);

		const combined = stdout + stderr;
		expect(exitCode).toBe(0);
		expect(combined).not.toContain('SCRIPT_ERROR:');
		expect(combined).toContain('CLAIMED_ID:00000000-0000-0000-0000-000000067406');
		expect(combined).toContain('CLAIMED_STATUS:running');

		const exhaustedStatus = db.runSql("SELECT status FROM jobs WHERE id = '00000000-0000-0000-0000-000000067405';");
		const runningOwner = db.runSql("SELECT worker_id FROM jobs WHERE id = '00000000-0000-0000-0000-000000067401';");
		expect(exhaustedStatus).toBe('pending');
		expect(runningOwner).toBe('worker-old');
	});

	it('QA-05: mark completed finalizes the claimed job', () => {
		if (!pgAvailable) return;

		cleanJobData();
		db.runSql(`
			INSERT INTO jobs (id, type, payload, status, attempts, max_attempts, worker_id, started_at)
			VALUES ('00000000-0000-0000-0000-000000067501', 'pipeline_run', '{"sourceId":"qa05"}', 'running', 1, 3, 'worker-qa05', now() - interval '1 minute');
		`);

		const { stdout, stderr, exitCode } = runScript(`
			import { closeAllPools, getWorkerPool, markJobCompleted } from '${DB_MODULE}';

			const config = ${DB_CONFIG_JSON};
			const pool = getWorkerPool(config);

			try {
				const job = await markJobCompleted(pool, {
					jobId: '00000000-0000-0000-0000-000000067501',
					workerId: 'worker-qa05',
					attempts: 1,
				});
				process.stderr.write('STATUS:' + job.status + '\\n');
				process.stderr.write('WORKER:' + job.workerId + '\\n');
				process.stderr.write('HAS_FINISHED_AT:' + (job.finishedAt instanceof Date) + '\\n');
			} catch (error) {
				process.stderr.write('SCRIPT_ERROR:' + error.message + '\\n');
				process.exit(1);
			} finally {
				await closeAllPools();
			}
		`);

		const combined = stdout + stderr;
		expect(exitCode).toBe(0);
		expect(combined).not.toContain('SCRIPT_ERROR:');
		expect(combined).toContain('STATUS:completed');
		expect(combined).toContain('WORKER:worker-qa05');
		expect(combined).toContain('HAS_FINISHED_AT:true');
	});

	it('QA-06: mark failed preserves retry semantics and dead-letters exhausted jobs', () => {
		if (!pgAvailable) return;

		cleanJobData();
		db.runSql(`
			INSERT INTO jobs (id, type, payload, status, attempts, max_attempts, worker_id, started_at)
			VALUES
				('00000000-0000-0000-0000-000000067601', 'pipeline_run', '{"sourceId":"retryable"}', 'running', 1, 3, 'worker-qa06-a', now() - interval '1 minute'),
				('00000000-0000-0000-0000-000000067602', 'pipeline_run', '{"sourceId":"exhausted"}', 'running', 3, 3, 'worker-qa06-b', now() - interval '1 minute');
		`);

		const { stdout, stderr, exitCode } = runScript(`
			import { closeAllPools, getWorkerPool, markJobFailed } from '${DB_MODULE}';

			const config = ${DB_CONFIG_JSON};
			const pool = getWorkerPool(config);

			try {
				const retryable = await markJobFailed(
					pool,
					{
						jobId: '00000000-0000-0000-0000-000000067601',
						workerId: 'worker-qa06-a',
						attempts: 1,
					},
					'retryable failure',
				);
				const exhausted = await markJobFailed(
					pool,
					{
						jobId: '00000000-0000-0000-0000-000000067602',
						workerId: 'worker-qa06-b',
						attempts: 3,
					},
					'exhausted failure',
				);

				process.stderr.write('RETRYABLE_STATUS:' + retryable.status + '\\n');
				process.stderr.write('RETRYABLE_LOG:' + retryable.errorLog + '\\n');
				process.stderr.write('RETRYABLE_FINISHED:' + (retryable.finishedAt instanceof Date) + '\\n');
				process.stderr.write('EXHAUSTED_STATUS:' + exhausted.status + '\\n');
				process.stderr.write('EXHAUSTED_LOG:' + exhausted.errorLog + '\\n');
				process.stderr.write('EXHAUSTED_FINISHED:' + (exhausted.finishedAt instanceof Date) + '\\n');
			} catch (error) {
				process.stderr.write('SCRIPT_ERROR:' + error.message + '\\n');
				process.exit(1);
			} finally {
				await closeAllPools();
			}
		`);

		const combined = stdout + stderr;
		expect(exitCode).toBe(0);
		expect(combined).not.toContain('SCRIPT_ERROR:');
		expect(combined).toContain('RETRYABLE_STATUS:failed');
		expect(combined).toContain('RETRYABLE_LOG:retryable failure');
		expect(combined).toContain('RETRYABLE_FINISHED:true');
		expect(combined).toContain('EXHAUSTED_STATUS:dead_letter');
		expect(combined).toContain('EXHAUSTED_LOG:exhausted failure');
		expect(combined).toContain('EXHAUSTED_FINISHED:true');
	});

	it('review blocker: terminal updates require the active claim token', () => {
		if (!pgAvailable) return;

		cleanJobData();
		db.runSql(`
			INSERT INTO jobs (id, type, payload, status, attempts, max_attempts, created_at)
			VALUES
				('00000000-0000-0000-0000-000000067611', 'pipeline_run', '{"sourceId":"stale-complete"}', 'pending', 0, 3, now() - interval '4 minutes'),
				('00000000-0000-0000-0000-000000067612', 'pipeline_run', '{"sourceId":"stale-fail"}', 'pending', 0, 3, now() - interval '3 minutes');
		`);

		const { stdout, stderr, exitCode } = runScript(`
			import { closeAllPools, dequeueJob, findJobById, getWorkerPool, markJobCompleted, markJobFailed } from '${DB_MODULE}';

			const config = ${DB_CONFIG_JSON};
			const pool = getWorkerPool(config);

			function toClaim(job, label) {
				if (!job || !job.workerId) {
					throw new Error('Missing claim for ' + label);
				}
				return {
					jobId: job.id,
					workerId: job.workerId,
					attempts: job.attempts,
				};
			}

			function getErrorCode(error) {
				if (typeof error === 'object' && error !== null && 'code' in error) {
					return String(error.code);
				}
				return 'unknown';
			}

			try {
				const staleCompleteClaim = toClaim(await dequeueJob(pool, 'worker-stale-complete'), 'stale-complete');
				await pool.query(
					"UPDATE jobs SET status = 'pending', worker_id = NULL, started_at = NULL WHERE id = $1",
					[staleCompleteClaim.jobId],
				);
				const activeCompleteClaim = toClaim(await dequeueJob(pool, 'worker-active-complete'), 'active-complete');

				let staleCompleteCode = 'none';
				try {
					await markJobCompleted(pool, staleCompleteClaim);
				} catch (error) {
					staleCompleteCode = getErrorCode(error);
				}

				const completeState = await findJobById(pool, activeCompleteClaim.jobId);

				const staleFailClaim = toClaim(await dequeueJob(pool, 'worker-stale-fail'), 'stale-fail');
				await pool.query(
					"UPDATE jobs SET status = 'pending', worker_id = NULL, started_at = NULL WHERE id = $1",
					[staleFailClaim.jobId],
				);
				const activeFailClaim = toClaim(await dequeueJob(pool, 'worker-active-fail'), 'active-fail');
				await markJobCompleted(pool, activeFailClaim);

				let staleFailCode = 'none';
				try {
					await markJobFailed(pool, staleFailClaim, 'late failure');
				} catch (error) {
					staleFailCode = getErrorCode(error);
				}

				const failState = await findJobById(pool, activeFailClaim.jobId);

				process.stderr.write('STALE_COMPLETE_CODE:' + staleCompleteCode + '\\n');
				process.stderr.write(
					'COMPLETE_STATE:' + completeState?.status + '|' + completeState?.workerId + '|' + completeState?.attempts + '\\n',
				);
				process.stderr.write('STALE_FAIL_CODE:' + staleFailCode + '\\n');
				process.stderr.write(
					'FAIL_STATE:' +
						failState?.status +
						'|' +
						failState?.workerId +
						'|' +
						failState?.attempts +
						'|' +
						String(failState?.errorLog ?? '') +
						'\\n',
				);
			} catch (error) {
				process.stderr.write('SCRIPT_ERROR:' + error.message + '\\n');
				process.exit(1);
			} finally {
				await closeAllPools();
			}
		`);

		const combined = stdout + stderr;
		expect(exitCode).toBe(0);
		expect(combined).not.toContain('SCRIPT_ERROR:');
		expect(combined).toContain('STALE_COMPLETE_CODE:DB_NOT_FOUND');
		expect(combined).toContain('COMPLETE_STATE:running|worker-active-complete|2');
		expect(combined).toContain('STALE_FAIL_CODE:DB_NOT_FOUND');
		expect(combined).toContain('FAIL_STATE:completed|worker-active-fail|2|');
	});

	it('QA-07: reaper resets stale running jobs back to pending', () => {
		if (!pgAvailable) return;

		cleanJobData();
		db.runSql(`
			INSERT INTO jobs (id, type, payload, status, attempts, max_attempts, worker_id, started_at)
			VALUES ('00000000-0000-0000-0000-000000067701', 'pipeline_run', '{"sourceId":"stale"}', 'running', 1, 3, 'worker-stale', now() - interval '3 hours');
		`);

		const { stdout, stderr, exitCode } = runScript(`
			import { closeAllPools, getWorkerPool, reapRunningJobs } from '${DB_MODULE}';

			const config = ${DB_CONFIG_JSON};
			const pool = getWorkerPool(config);

			try {
				const result = await reapRunningJobs(pool, new Date(Date.now() - 2 * 60 * 60 * 1000));
				process.stderr.write('REAP_COUNT:' + result.count + '\\n');
				process.stderr.write('REAP_IDS:' + result.jobIds.join(',') + '\\n');
			} catch (error) {
				process.stderr.write('SCRIPT_ERROR:' + error.message + '\\n');
				process.exit(1);
			} finally {
				await closeAllPools();
			}
		`);

		const combined = stdout + stderr;
		expect(exitCode).toBe(0);
		expect(combined).not.toContain('SCRIPT_ERROR:');
		expect(combined).toContain('REAP_COUNT:1');
		expect(combined).toContain('REAP_IDS:00000000-0000-0000-0000-000000067701');

		const reapedState = db.runSql(
			"SELECT status || '|' || COALESCE(worker_id, '') || '|' || (started_at IS NULL)::text FROM jobs WHERE id = '00000000-0000-0000-0000-000000067701';",
		);
		expect(reapedState).toBe('pending||true');
	});

	it('review blocker: reaper refunds a stale final-attempt claim back to a runnable pending job', () => {
		if (!pgAvailable) return;

		cleanJobData();
		db.runSql(`
			INSERT INTO jobs (id, type, payload, status, attempts, max_attempts, worker_id, started_at, created_at)
			VALUES ('00000000-0000-0000-0000-000000067702', 'pipeline_run', '{"sourceId":"stale-exhausted"}', 'running', 1, 1, 'worker-stale', now() - interval '3 hours', now() - interval '4 hours');
		`);

		const { stdout, stderr, exitCode } = runScript(`
			import { closeAllPools, dequeueJob, getWorkerPool, reapRunningJobs } from '${DB_MODULE}';

			const config = ${DB_CONFIG_JSON};
			const pool = getWorkerPool(config);

			try {
				const result = await reapRunningJobs(pool, new Date(Date.now() - 2 * 60 * 60 * 1000));
				const next = await dequeueJob(pool, 'worker-after-reap');
				const state = await pool.query(
					'SELECT status, attempts, worker_id, (started_at IS NULL) AS started_cleared, (finished_at IS NOT NULL) AS finished_set FROM jobs WHERE id = $1',
					['00000000-0000-0000-0000-000000067702'],
				);
				const row = state.rows[0];

				process.stderr.write('REAP_COUNT:' + result.count + '\\n');
				process.stderr.write('NEXT_JOB:' + String(next?.id ?? 'null') + '\\n');
				process.stderr.write('NEXT_ATTEMPTS:' + String(next?.attempts ?? 'null') + '\\n');
				process.stderr.write(
					'STATE:' +
						row.status +
						'|' +
						String(row.attempts) +
						'|' +
						String(row.worker_id ?? '') +
						'|' +
						String(row.started_cleared) +
						'|' +
						String(row.finished_set) +
						'\\n',
				);
			} catch (error) {
				process.stderr.write('SCRIPT_ERROR:' + error.message + '\\n');
				process.exit(1);
			} finally {
				await closeAllPools();
			}
		`);

		const combined = stdout + stderr;
		expect(exitCode).toBe(0);
		expect(combined).not.toContain('SCRIPT_ERROR:');
		expect(combined).toContain('REAP_COUNT:1');
		expect(combined).toContain('NEXT_JOB:00000000-0000-0000-0000-000000067702');
		expect(combined).toContain('NEXT_ATTEMPTS:1');
		expect(combined).toContain('STATE:running|1|worker-after-reap|false|false');
	});

	it('QA-08: fresh running jobs are not reaped', () => {
		if (!pgAvailable) return;

		cleanJobData();
		db.runSql(`
			INSERT INTO jobs (id, type, payload, status, attempts, max_attempts, worker_id, started_at)
			VALUES ('00000000-0000-0000-0000-000000067801', 'pipeline_run', '{"sourceId":"fresh"}', 'running', 1, 3, 'worker-fresh', now() - interval '15 minutes');
		`);

		const { stdout, stderr, exitCode } = runScript(`
			import { closeAllPools, getWorkerPool, reapRunningJobs } from '${DB_MODULE}';

			const config = ${DB_CONFIG_JSON};
			const pool = getWorkerPool(config);

			try {
				const result = await reapRunningJobs(pool, new Date(Date.now() - 2 * 60 * 60 * 1000));
				process.stderr.write('REAP_COUNT:' + result.count + '\\n');
			} catch (error) {
				process.stderr.write('SCRIPT_ERROR:' + error.message + '\\n');
				process.exit(1);
			} finally {
				await closeAllPools();
			}
		`);

		const combined = stdout + stderr;
		expect(exitCode).toBe(0);
		expect(combined).not.toContain('SCRIPT_ERROR:');
		expect(combined).toContain('REAP_COUNT:0');

		const freshStatus = db.runSql(
			"SELECT status || '|' || worker_id FROM jobs WHERE id = '00000000-0000-0000-0000-000000067801';",
		);
		expect(freshStatus).toBe('running|worker-fresh');
	});

	it('QA-09: repository exports are available through the public @mulder/core barrel', () => {
		if (!pgAvailable) return;

		cleanJobData();

		const { stdout, stderr, exitCode } = runScript(`
			import { closeAllPools, enqueueJob, findJobById, getWorkerPool } from '${CORE_MODULE}';

			const config = ${DB_CONFIG_JSON};
			const pool = getWorkerPool(config);

			try {
				const job = await enqueueJob(pool, {
					type: 'barrel-test',
					payload: { sourceId: 'qa09-source' },
				});
				const found = await findJobById(pool, job.id);

				process.stderr.write('ENQUEUE_TYPE:' + typeof enqueueJob + '\\n');
				process.stderr.write('LOOKUP_TYPE:' + typeof findJobById + '\\n');
				process.stderr.write('FOUND_MATCH:' + (found?.id === job.id) + '\\n');
			} catch (error) {
				process.stderr.write('SCRIPT_ERROR:' + error.message + '\\n');
				process.exit(1);
			} finally {
				await closeAllPools();
			}
		`);

		const combined = stdout + stderr;
		expect(exitCode).toBe(0);
		expect(combined).not.toContain('SCRIPT_ERROR:');
		expect(combined).toContain('ENQUEUE_TYPE:function');
		expect(combined).toContain('LOOKUP_TYPE:function');
		expect(combined).toContain('FOUND_MATCH:true');
	});
});
