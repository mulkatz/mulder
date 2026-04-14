import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');
const RUNNER = resolve(import.meta.dirname, 'db-runner.mjs');

export const TEST_PG_HOST = process.env.PGHOST ?? 'localhost';
export const TEST_PG_PORT = Number.parseInt(process.env.PGPORT ?? '5432', 10);
export const TEST_PG_USER = process.env.PGUSER ?? 'mulder';
export const TEST_PG_PASSWORD = process.env.PGPASSWORD ?? 'mulder';
export const TEST_PG_DATABASE = process.env.PGDATABASE ?? 'mulder';

export const TEST_PG_ENV: Record<string, string> = {
	PGHOST: TEST_PG_HOST,
	PGPORT: String(TEST_PG_PORT),
	PGUSER: TEST_PG_USER,
	PGPASSWORD: TEST_PG_PASSWORD,
	PGDATABASE: TEST_PG_DATABASE,
};

function runDbRunner(args: string[], timeout: number): { stdout: string; stderr: string; exitCode: number } {
	const result = spawnSync('node', [RUNNER, ...args], {
		cwd: ROOT,
		encoding: 'utf-8',
		timeout,
		stdio: ['pipe', 'pipe', 'pipe'],
		env: { ...process.env, ...TEST_PG_ENV },
	});

	return {
		stdout: result.stdout ?? '',
		stderr: result.stderr ?? '',
		exitCode: result.status ?? 1,
	};
}

export function isPgAvailable(): boolean {
	return runDbRunner(['ready'], 5_000).exitCode === 0;
}

export function requirePg(): void {
	const result = runDbRunner(['ready'], 5_000);
	if (result.exitCode === 0) {
		return;
	}

	const stderr = result.stderr.trim();
	const stdout = result.stdout.trim();
	const details = [stderr, stdout].filter(Boolean).join('\n');

	throw new Error(
		[
			`PostgreSQL is required for this spec test but is not reachable.`,
			`Tried ${TEST_PG_USER}@${TEST_PG_HOST}:${TEST_PG_PORT}/${TEST_PG_DATABASE}.`,
			details ? `pg_isready output:\n${details}` : 'pg_isready returned a non-zero exit code with no output.',
		].join('\n'),
	);
}

export function runSql(sql: string): string {
	const encodedSql = Buffer.from(sql, 'utf8').toString('base64');
	const result = runDbRunner(['query', encodedSql], 15_000);
	if (result.exitCode !== 0) {
		throw new Error(`SQL failed (exit ${result.exitCode}): ${result.stderr.trim()}`);
	}
	return result.stdout.trim();
}

export function runSqlSafe(sql: string): string | null {
	try {
		return runSql(sql);
	} catch {
		return null;
	}
}
