import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const CLI = resolve(ROOT, 'apps/cli/dist/index.js');
const EXAMPLE_CONFIG = resolve(ROOT, 'mulder.config.example.yaml');
const COMPOSE_FILE = resolve(ROOT, 'docker-compose.yaml');

const PG_CONTAINER = 'mulder-postgres';
const FS_CONTAINER = 'mulder-firestore';
const PG_USER = 'mulder';
const PG_DB = 'mulder';

/**
 * Black-box QA tests for Spec 12: Docker Compose — pgvector + PostGIS + Firestore Emulator
 *
 * Each `it()` maps to one QA condition from Section 5 of the spec.
 * Tests interact through system boundaries only: docker compose CLI, SQL via
 * docker exec psql, HTTP, and filesystem.
 * Never import from packages/ or src/ or apps/.
 *
 * These tests manage real Docker containers and require Docker to be running.
 * Postgres and Firestore are started independently so that network issues
 * pulling one image do not block testing of the other.
 */

/**
 * Helper: run docker compose commands.
 */
function compose(args: string[], timeout = 120_000): { stdout: string; stderr: string; exitCode: number } {
	const result = spawnSync('docker', ['compose', '-f', COMPOSE_FILE, ...args], {
		cwd: ROOT,
		encoding: 'utf-8',
		timeout,
		stdio: ['pipe', 'pipe', 'pipe'],
	});
	return {
		stdout: result.stdout ?? '',
		stderr: result.stderr ?? '',
		exitCode: result.status ?? 1,
	};
}

/**
 * Helper: run SQL via docker exec psql on the mulder-postgres container.
 */
function runSql(sql: string): string {
	const result = spawnSync(
		'docker',
		['exec', PG_CONTAINER, 'psql', '-U', PG_USER, '-d', PG_DB, '-t', '-A', '-c', sql],
		{ encoding: 'utf-8', timeout: 15_000, stdio: ['pipe', 'pipe', 'pipe'] },
	);
	if (result.status !== 0) {
		throw new Error(`psql failed (exit ${result.status}): ${result.stderr}`);
	}
	return (result.stdout ?? '').trim();
}

/**
 * Helper: wait for a container to reach healthy status.
 */
function waitForHealthy(containerName: string, timeoutMs: number): boolean {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const result = spawnSync('docker', ['inspect', '--format', '{{.State.Health.Status}}', containerName], {
			encoding: 'utf-8',
			timeout: 5_000,
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		const status = (result.stdout ?? '').trim();
		if (status === 'healthy') return true;
		// Container exited — no point waiting
		const stateResult = spawnSync('docker', ['inspect', '--format', '{{.State.Running}}', containerName], {
			encoding: 'utf-8',
			timeout: 5_000,
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		if ((stateResult.stdout ?? '').trim() === 'false') return false;
		spawnSync('sleep', ['2']);
	}
	return false;
}

/**
 * Helper: check if Docker is available.
 */
function isDockerAvailable(): boolean {
	try {
		const result = spawnSync('docker', ['info'], {
			encoding: 'utf-8',
			timeout: 10_000,
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		return result.status === 0;
	} catch {
		return false;
	}
}

/**
 * Helper: check if a Docker image is locally available.
 */
function isImageAvailable(image: string): boolean {
	const result = spawnSync('docker', ['image', 'inspect', image], {
		encoding: 'utf-8',
		timeout: 5_000,
		stdio: ['pipe', 'pipe', 'pipe'],
	});
	return result.status === 0;
}

/**
 * Helper: get container logs.
 */
function containerLogs(containerName: string): string {
	const result = spawnSync('docker', ['logs', containerName], {
		encoding: 'utf-8',
		timeout: 10_000,
		stdio: ['pipe', 'pipe', 'pipe'],
	});
	return (result.stdout ?? '') + (result.stderr ?? '');
}

let dockerAvailable = false;
let postgresStarted = false;
let firestoreStarted = false;
let firestoreImageAvailable = false;
const stoppedConflictingContainers: string[] = [];

describe('Spec 12: Docker Compose — pgvector + PostGIS + Firestore Emulator', () => {
	beforeAll(() => {
		dockerAvailable = isDockerAvailable();
		if (!dockerAvailable) {
			console.warn('SKIP: Docker is not available. Install and start Docker to run these tests.');
			return;
		}

		// Stop any conflicting containers on ports 5432 and 8080
		const psResult = spawnSync('docker', ['ps', '--format', '{{.Names}} {{.Ports}}'], {
			encoding: 'utf-8',
			timeout: 5_000,
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		const lines = (psResult.stdout ?? '').split('\n');
		for (const line of lines) {
			const containerName = line.split(' ')[0];
			if (!containerName) continue;
			if (containerName === PG_CONTAINER || containerName === FS_CONTAINER) continue;
			if (line.includes(':5432->') || line.includes(':8080->')) {
				console.warn(`Stopping conflicting container: ${containerName}`);
				spawnSync('docker', ['stop', containerName], {
					encoding: 'utf-8',
					timeout: 30_000,
				});
				stoppedConflictingContainers.push(containerName);
			}
		}

		// Clean up any prior compose state
		compose(['down', '-v'], 60_000);

		// Start postgres service (image is typically already local)
		const pgUp = compose(['up', '-d', 'postgres'], 120_000);
		if (pgUp.exitCode === 0) {
			const pgHealthy = waitForHealthy(PG_CONTAINER, 90_000);
			if (pgHealthy) {
				postgresStarted = true;
			} else {
				const logs = containerLogs(PG_CONTAINER);
				console.warn(`WARNING: mulder-postgres did not reach healthy status. Logs:\n${logs.slice(-500)}`);
			}
		} else {
			console.warn(`WARNING: docker compose up postgres failed: ${pgUp.stderr}`);
		}

		// Try to start firestore (may fail if image can't be pulled due to network)
		firestoreImageAvailable = isImageAvailable('google/cloud-sdk:emulators');
		if (!firestoreImageAvailable) {
			console.warn(
				'SKIP: google/cloud-sdk:emulators image not available locally. ' +
					'Firestore tests will be skipped. Pull with: docker pull google/cloud-sdk:emulators',
			);
		} else {
			const fsUp = compose(['up', '-d', 'firestore'], 120_000);
			if (fsUp.exitCode === 0) {
				const fsHealthy = waitForHealthy(FS_CONTAINER, 90_000);
				if (fsHealthy) {
					firestoreStarted = true;
				}
			}
		}
	}, 360_000); // 6 minute timeout for beforeAll

	afterAll(() => {
		if (dockerAvailable) {
			compose(['down', '-v'], 60_000);

			for (const container of stoppedConflictingContainers) {
				console.warn(`Restarting previously stopped container: ${container}`);
				spawnSync('docker', ['start', container], {
					encoding: 'utf-8',
					timeout: 30_000,
				});
			}
		}
	}, 120_000);

	// ─── QA-01: postgres-starts ───

	it('QA-01: postgres-starts — mulder-postgres container reaches healthy status', () => {
		if (!dockerAvailable) {
			console.warn('SKIP: Docker not available');
			return;
		}

		expect(postgresStarted).toBe(true);

		const result = spawnSync('docker', ['inspect', '--format', '{{.State.Health.Status}}', PG_CONTAINER], {
			encoding: 'utf-8',
			timeout: 5_000,
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		expect((result.stdout ?? '').trim()).toBe('healthy');
	});

	// ─── QA-02: extensions-available ───

	it('QA-02: extensions-available — vector, postgis, and pg_trgm extensions are installed', () => {
		if (!dockerAvailable) {
			console.warn('SKIP: Docker not available');
			return;
		}
		expect(postgresStarted).toBe(true);

		const extensions = runSql('SELECT extname FROM pg_extension ORDER BY extname;');
		const extList = extensions.split('\n').filter(Boolean);

		expect(extList).toContain('vector');
		expect(extList).toContain('postgis');
		expect(extList).toContain('pg_trgm');
	});

	// ─── QA-03: firestore-starts ───

	it('QA-03: firestore-starts — mulder-firestore container reaches healthy status', () => {
		if (!dockerAvailable) {
			console.warn('SKIP: Docker not available');
			return;
		}
		if (!firestoreImageAvailable) {
			console.warn('SKIP: firestore image not available locally, cannot test');
			return;
		}

		expect(firestoreStarted).toBe(true);

		const result = spawnSync('docker', ['inspect', '--format', '{{.State.Health.Status}}', FS_CONTAINER], {
			encoding: 'utf-8',
			timeout: 5_000,
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		expect((result.stdout ?? '').trim()).toBe('healthy');
	}, 120_000);

	// ─── QA-04: database-accessible ───

	it('QA-04: database-accessible — can connect and execute queries via psql', () => {
		if (!dockerAvailable) {
			console.warn('SKIP: Docker not available');
			return;
		}
		expect(postgresStarted).toBe(true);

		const queryResult = runSql('SELECT 1 AS test;');
		expect(queryResult).toBe('1');

		const dbName = runSql('SELECT current_database();');
		expect(dbName).toBe('mulder');

		const userName = runSql('SELECT current_user;');
		expect(userName).toBe('mulder');
	});

	// ─── QA-05: migrations-run-cleanly ───

	it('QA-05: migrations-run-cleanly — mulder db migrate completes with exit code 0', () => {
		if (!dockerAvailable) {
			console.warn('SKIP: Docker not available');
			return;
		}
		expect(postgresStarted).toBe(true);

		const result = spawnSync('node', [CLI, 'db', 'migrate', EXAMPLE_CONFIG], {
			cwd: ROOT,
			encoding: 'utf-8',
			timeout: 60_000,
			stdio: ['pipe', 'pipe', 'pipe'],
			env: { ...process.env, PGPASSWORD: 'mulder' },
		});

		const combined = (result.stdout ?? '') + (result.stderr ?? '');
		expect(result.status).toBe(0);
		expect(combined.toLowerCase()).toMatch(/migrat|applied|up to date/);
	}, 90_000);

	// ─── QA-06: data-persists-across-restart ───

	it('QA-06: data-persists-across-restart — data survives stop/start cycle', () => {
		if (!dockerAvailable) {
			console.warn('SKIP: Docker not available');
			return;
		}
		expect(postgresStarted).toBe(true);

		// Insert test data
		runSql('CREATE TABLE IF NOT EXISTS qa12_persist_test (id SERIAL PRIMARY KEY, val TEXT);');
		runSql("INSERT INTO qa12_persist_test (val) VALUES ('persist-check');");

		const beforeRestart = runSql("SELECT val FROM qa12_persist_test WHERE val = 'persist-check';");
		expect(beforeRestart).toBe('persist-check');

		// Stop postgres
		const stopResult = compose(['stop', 'postgres'], 60_000);
		expect(stopResult.exitCode).toBe(0);

		// Start postgres again
		const startResult = compose(['start', 'postgres'], 60_000);
		expect(startResult.exitCode).toBe(0);

		// Wait for healthy
		const healthy = waitForHealthy(PG_CONTAINER, 30_000);
		expect(healthy).toBe(true);

		// Verify data is still there
		const afterRestart = runSql("SELECT val FROM qa12_persist_test WHERE val = 'persist-check';");
		expect(afterRestart).toBe('persist-check');

		// Cleanup test table
		runSql('DROP TABLE IF EXISTS qa12_persist_test;');
	}, 120_000);

	// ─── QA-07: clean-slate ───

	it('QA-07: clean-slate — docker compose down -v removes containers and volumes', () => {
		if (!dockerAvailable) {
			console.warn('SKIP: Docker not available');
			return;
		}

		// Insert some data first (if postgres is running)
		if (postgresStarted) {
			runSql('CREATE TABLE IF NOT EXISTS qa12_clean_test (id SERIAL PRIMARY KEY);');
		}

		// Bring everything down with volume removal
		const downResult = compose(['down', '-v'], 60_000);
		expect(downResult.exitCode).toBe(0);

		// Verify postgres container is gone
		const psResult = spawnSync('docker', ['ps', '-a', '--filter', `name=${PG_CONTAINER}`, '--format', '{{.Names}}'], {
			encoding: 'utf-8',
			timeout: 5_000,
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		expect((psResult.stdout ?? '').trim()).toBe('');

		// Verify firestore container is also gone
		const fsResult = spawnSync('docker', ['ps', '-a', '--filter', `name=${FS_CONTAINER}`, '--format', '{{.Names}}'], {
			encoding: 'utf-8',
			timeout: 5_000,
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		expect((fsResult.stdout ?? '').trim()).toBe('');

		// Verify named volume is removed
		const volResult = spawnSync('docker', ['volume', 'ls', '--filter', 'name=pgdata', '--format', '{{.Name}}'], {
			encoding: 'utf-8',
			timeout: 5_000,
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		expect((volResult.stdout ?? '').trim()).toBe('');

		// Mark services as stopped so afterAll doesn't try double-down
		postgresStarted = false;
		firestoreStarted = false;
	}, 90_000);
});
