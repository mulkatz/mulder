import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as db from '../lib/db.js';

const ROOT = resolve(import.meta.dirname, '../..');
const CLI = resolve(ROOT, 'apps/cli/dist/index.js');
const CORE_MODULE = resolve(ROOT, 'packages/core/dist/index.js');
const EXAMPLE_CONFIG = resolve(ROOT, 'mulder.config.example.yaml');

const DB_CONFIG_JSON = JSON.stringify({
	instance_name: 'mulder-db',
	database: 'mulder',
	tier: 'db-custom-2-8192',
	host: 'localhost',
	port: 5432,
	user: 'mulder',
});

function runCli(
	args: string[],
	opts?: { env?: Record<string, string>; timeout?: number },
): { stdout: string; stderr: string; exitCode: number } {
	const result = spawnSync('node', [CLI, ...args], {
		cwd: ROOT,
		encoding: 'utf-8',
		timeout: opts?.timeout ?? 30_000,
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
	const result = spawnSync('node', ['--input-type=module', '-e', scriptContent], {
		cwd: ROOT,
		encoding: 'utf-8',
		timeout: opts?.timeout ?? 30_000,
		stdio: ['pipe', 'pipe', 'pipe'],
		env: { ...process.env, PGPASSWORD: db.TEST_PG_PASSWORD, ...opts?.env },
	});

	return {
		stdout: result.stdout ?? '',
		stderr: result.stderr ?? '',
		exitCode: result.status ?? 1,
	};
}

function cleanJobs(): void {
	db.runSql('DELETE FROM jobs;');
}

function jobState(jobId: string): string {
	return db.runSql(
		`SELECT status || '|' || attempts::text || '|' || COALESCE(worker_id, '') || '|' || COALESCE(error_log, '')
		 FROM jobs
		 WHERE id = '${jobId}';`,
	);
}

describe('Spec 78: Dead Letter Queue Retry CLI', () => {
	let pgAvailable = false;

	beforeAll(() => {
		db.requirePg();
		pgAvailable = true;

		const migrate = runCli(['db', 'migrate', EXAMPLE_CONFIG]);
		if (migrate.exitCode !== 0) {
			throw new Error(`Migration failed: ${migrate.stdout} ${migrate.stderr}`);
		}

		cleanJobs();
	});

	afterAll(() => {
		if (pgAvailable) {
			cleanJobs();
		}
	});

	it('QA-01/04/05: document-scoped retry resets only matching dead-letter jobs and clears queue metadata', () => {
		cleanJobs();
		db.runSql(`
			INSERT INTO jobs (id, type, payload, status, attempts, max_attempts, worker_id, started_at, finished_at, error_log, created_at)
			VALUES
				('00000000-0000-0000-0000-000000078101', 'extract', '{"sourceId":"doc-a"}', 'dead_letter', 3, 3, 'worker-a', now() - interval '5 minutes', now() - interval '4 minutes', 'extract-a', now() - interval '10 minutes'),
				('00000000-0000-0000-0000-000000078102', 'segment', '{"source_id":"doc-a"}', 'dead_letter', 2, 3, 'worker-b', now() - interval '4 minutes', now() - interval '3 minutes', 'segment-a', now() - interval '9 minutes'),
				('00000000-0000-0000-0000-000000078103', 'pipeline_run', '{"sourceId":"doc-a","from":"graph","upTo":"graph"}', 'dead_letter', 3, 3, 'worker-c', now() - interval '3 minutes', now() - interval '2 minutes', 'pipeline-a', now() - interval '8 minutes'),
				('00000000-0000-0000-0000-000000078104', 'enrich', '{"storyId":"story-a"}', 'dead_letter', 3, 3, 'worker-d', now() - interval '2 minutes', now() - interval '1 minute', 'story-only', now() - interval '7 minutes'),
				('00000000-0000-0000-0000-000000078105', 'extract', '{"sourceId":"doc-a"}', 'pending', 0, 3, NULL, NULL, NULL, NULL, now() - interval '6 minutes'),
				('00000000-0000-0000-0000-000000078106', 'segment', '{"sourceId":"doc-a"}', 'running', 1, 3, 'worker-live', now() - interval '1 minute', NULL, NULL, now() - interval '5 minutes'),
				('00000000-0000-0000-0000-000000078107', 'pipeline_run', '{"sourceId":"doc-b","from":"graph","upTo":"graph"}', 'dead_letter', 3, 3, 'worker-e', now() - interval '6 minutes', now() - interval '5 minutes', 'other-doc', now() - interval '4 minutes');
		`);

		const result = runScript(`
			import { closeAllPools, getWorkerPool, resetDeadLetterJobs } from '${CORE_MODULE}';

			const config = ${DB_CONFIG_JSON};
			const pool = getWorkerPool(config);

			try {
				const result = await resetDeadLetterJobs(pool, { documentId: 'doc-a' });
				process.stderr.write('RESET_COUNT:' + result.count + '\\n');
				process.stderr.write('RESET_IDS:' + result.jobIds.join(',') + '\\n');
			} finally {
				await closeAllPools();
			}
		`);

		const combined = result.stdout + result.stderr;
		expect(result.exitCode).toBe(0);
		expect(combined).toContain('RESET_COUNT:3');
		expect(combined).toContain(
			'RESET_IDS:00000000-0000-0000-0000-000000078101,00000000-0000-0000-0000-000000078102,00000000-0000-0000-0000-000000078103',
		);

		expect(jobState('00000000-0000-0000-0000-000000078101')).toBe('pending|0||');
		expect(jobState('00000000-0000-0000-0000-000000078102')).toBe('pending|0||');
		expect(jobState('00000000-0000-0000-0000-000000078103')).toBe('pending|0||');
		expect(jobState('00000000-0000-0000-0000-000000078104')).toBe('dead_letter|3|worker-d|story-only');
		expect(jobState('00000000-0000-0000-0000-000000078105')).toBe('pending|0||');
		expect(jobState('00000000-0000-0000-0000-000000078106')).toBe('running|1|worker-live|');
		expect(jobState('00000000-0000-0000-0000-000000078107')).toBe('dead_letter|3|worker-e|other-doc');
	});

	it('QA-02: step-scoped retry resets only the requested dead-letter step', () => {
		cleanJobs();
		db.runSql(`
			INSERT INTO jobs (id, type, payload, status, attempts, max_attempts, worker_id, started_at, finished_at, error_log, created_at)
			VALUES
				('00000000-0000-0000-0000-000000078201', 'graph', '{"storyId":"story-a"}', 'dead_letter', 3, 3, 'worker-a', now() - interval '5 minutes', now() - interval '4 minutes', 'graph-a', now() - interval '10 minutes'),
				('00000000-0000-0000-0000-000000078202', 'pipeline_run', '{"sourceId":"doc-a","from":"graph","upTo":"graph"}', 'dead_letter', 3, 3, 'worker-b', now() - interval '4 minutes', now() - interval '3 minutes', 'pipeline-a', now() - interval '9 minutes'),
				('00000000-0000-0000-0000-000000078203', 'pipeline_run', '{"sourceId":"doc-b","from":"enrich","upTo":"enrich"}', 'dead_letter', 3, 3, 'worker-c', now() - interval '3 minutes', now() - interval '2 minutes', 'pipeline-b', now() - interval '8 minutes'),
				('00000000-0000-0000-0000-000000078204', 'enrich', '{"storyId":"story-b"}', 'dead_letter', 3, 3, 'worker-d', now() - interval '2 minutes', now() - interval '1 minute', 'enrich-a', now() - interval '7 minutes'),
				('00000000-0000-0000-0000-000000078205', 'extract', '{"sourceId":"doc-c"}', 'dead_letter', 3, 3, 'worker-e', now() - interval '1 minute', now() - interval '30 seconds', 'extract-a', now() - interval '6 minutes'),
				('00000000-0000-0000-0000-000000078206', 'graph', '{"storyId":"story-c"}', 'running', 1, 3, 'worker-live', now() - interval '15 seconds', NULL, NULL, now() - interval '5 minutes');
		`);

		const result = runScript(`
			import { closeAllPools, getWorkerPool, resetDeadLetterJobs } from '${CORE_MODULE}';

			const config = ${DB_CONFIG_JSON};
			const pool = getWorkerPool(config);

			try {
				const result = await resetDeadLetterJobs(pool, { step: 'graph' });
				process.stderr.write('RESET_COUNT:' + result.count + '\\n');
				process.stderr.write('RESET_IDS:' + result.jobIds.join(',') + '\\n');
			} finally {
				await closeAllPools();
			}
		`);

		const combined = result.stdout + result.stderr;
		expect(result.exitCode).toBe(0);
		expect(combined).toContain('RESET_COUNT:2');
		expect(combined).toContain('RESET_IDS:00000000-0000-0000-0000-000000078201,00000000-0000-0000-0000-000000078202');
		expect(jobState('00000000-0000-0000-0000-000000078201')).toBe('pending|0||');
		expect(jobState('00000000-0000-0000-0000-000000078202')).toBe('pending|0||');
		expect(jobState('00000000-0000-0000-0000-000000078203')).toBe('dead_letter|3|worker-c|pipeline-b');
		expect(jobState('00000000-0000-0000-0000-000000078204')).toBe('dead_letter|3|worker-d|enrich-a');
		expect(jobState('00000000-0000-0000-0000-000000078205')).toBe('dead_letter|3|worker-e|extract-a');
		expect(jobState('00000000-0000-0000-0000-000000078206')).toBe('running|1|worker-live|');
	});

	it('QA-03/06: combined selectors intersect and zero-match retries succeed as a no-op', () => {
		cleanJobs();
		db.runSql(`
			INSERT INTO jobs (id, type, payload, status, attempts, max_attempts, worker_id, started_at, finished_at, error_log, created_at)
			VALUES
				('00000000-0000-0000-0000-000000078301', 'pipeline_run', '{"sourceId":"doc-a","from":"graph","upTo":"graph"}', 'dead_letter', 3, 3, 'worker-a', now() - interval '5 minutes', now() - interval '4 minutes', 'graph-a', now() - interval '10 minutes'),
				('00000000-0000-0000-0000-000000078302', 'pipeline_run', '{"sourceId":"doc-a","from":"segment","upTo":"segment"}', 'dead_letter', 3, 3, 'worker-b', now() - interval '4 minutes', now() - interval '3 minutes', 'segment-a', now() - interval '9 minutes'),
				('00000000-0000-0000-0000-000000078303', 'pipeline_run', '{"sourceId":"doc-b","from":"graph","upTo":"graph"}', 'dead_letter', 3, 3, 'worker-c', now() - interval '3 minutes', now() - interval '2 minutes', 'graph-b', now() - interval '8 minutes');
		`);

		const result = runScript(`
			import { closeAllPools, getWorkerPool, resetDeadLetterJobs } from '${CORE_MODULE}';

			const config = ${DB_CONFIG_JSON};
			const pool = getWorkerPool(config);

			try {
				const result = await resetDeadLetterJobs(pool, { documentId: 'doc-a', step: 'graph' });
				process.stderr.write('RESET_COUNT:' + result.count + '\\n');
				process.stderr.write('RESET_IDS:' + result.jobIds.join(',') + '\\n');
			} finally {
				await closeAllPools();
			}
		`);

		const combined = result.stdout + result.stderr;
		expect(result.exitCode).toBe(0);
		expect(combined).toContain('RESET_COUNT:1');
		expect(combined).toContain('RESET_IDS:00000000-0000-0000-0000-000000078301');
		expect(jobState('00000000-0000-0000-0000-000000078301')).toBe('pending|0||');
		expect(jobState('00000000-0000-0000-0000-000000078302')).toBe('dead_letter|3|worker-b|segment-a');
		expect(jobState('00000000-0000-0000-0000-000000078303')).toBe('dead_letter|3|worker-c|graph-b');

		const noMatch = runCli(['retry', '--document', 'missing-doc', '--step', 'graph', '--json'], {
			env: { MULDER_CONFIG: EXAMPLE_CONFIG },
		});
		expect(noMatch.exitCode).toBe(0);
		const payload = JSON.parse(noMatch.stdout) as {
			selectors: { documentId: string | null; step: string | null };
			resetCount: number;
			jobIds: string[];
		};
		expect(payload.selectors).toEqual({ documentId: 'missing-doc', step: 'graph' });
		expect(payload.resetCount).toBe(0);
		expect(payload.jobIds).toEqual([]);
	});

	it('QA-07/08: retry requires at least one selector and exposes stable JSON/help output', () => {
		const missingSelectors = runCli(['retry'], { env: { MULDER_CONFIG: EXAMPLE_CONFIG } });
		expect(missingSelectors.exitCode).toBe(1);
		expect(missingSelectors.stderr).toContain('At least one selector is required');

		const help = runCli(['retry', '--help'], { env: { MULDER_CONFIG: EXAMPLE_CONFIG } });
		expect(help.exitCode).toBe(0);
		expect(help.stdout).toContain('--document');
		expect(help.stdout).toContain('--step');

		cleanJobs();
		db.runSql(`
			INSERT INTO jobs (id, type, payload, status, attempts, max_attempts, worker_id, started_at, finished_at, error_log, created_at)
			VALUES
				('00000000-0000-0000-0000-000000078401', 'extract', '{"sourceId":"doc-json"}', 'dead_letter', 3, 3, 'worker-json', now() - interval '2 minutes', now() - interval '1 minute', 'json-a', now() - interval '5 minutes');
		`);

		const jsonResult = runCli(['retry', '--document', 'doc-json', '--json'], {
			env: { MULDER_CONFIG: EXAMPLE_CONFIG },
		});
		expect(jsonResult.exitCode).toBe(0);
		const payload = JSON.parse(jsonResult.stdout) as {
			selectors: { documentId: string | null; step: string | null };
			resetCount: number;
			jobIds: string[];
		};
		expect(payload).toEqual({
			selectors: { documentId: 'doc-json', step: null },
			resetCount: 1,
			jobIds: ['00000000-0000-0000-0000-000000078401'],
		});
		expect(jobState('00000000-0000-0000-0000-000000078401')).toBe('pending|0||');
	});
});
