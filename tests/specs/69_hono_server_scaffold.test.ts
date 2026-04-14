import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const API_DIR = resolve(ROOT, 'apps/api');
const API_DIST_DIR = resolve(API_DIR, 'dist');
const API_INDEX = resolve(API_DIST_DIR, 'index.js');
const API_APP = resolve(API_DIST_DIR, 'app.js');

type SpawnedProcess = ReturnType<typeof spawn>;

async function buildApiPackage(): Promise<void> {
	const result = spawnSync('pnpm', ['build'], {
		cwd: API_DIR,
		encoding: 'utf-8',
		stdio: ['ignore', 'pipe', 'pipe'],
		env: {
			...process.env,
			MULDER_LOG_LEVEL: 'silent',
		},
	});

	expect(result.status ?? 1).toBe(0);
	if ((result.status ?? 1) !== 0) {
		throw new Error(`API build failed:\n${result.stdout ?? ''}\n${result.stderr ?? ''}`);
	}
}

async function findFreePort(): Promise<number> {
	return await new Promise<number>((resolvePort, rejectPort) => {
		const server = createServer();
		server.once('error', rejectPort);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			server.close(() => {
				if (address && typeof address === 'object') {
					resolvePort(address.port);
					return;
				}
				rejectPort(new Error('Could not determine free port'));
			});
		});
	});
}

async function waitForHealth(url: string, timeoutMs = 10_000): Promise<Response> {
	const deadline = Date.now() + timeoutMs;

	while (Date.now() < deadline) {
		try {
			const response = await fetch(url);
			if (response.ok) {
				return response;
			}
		} catch {
			// Keep polling until the server is ready.
		}

		await delay(100);
	}

	throw new Error(`Timed out waiting for ${url}`);
}

function startApiServer(port: number): SpawnedProcess {
	return spawn('node', [API_INDEX], {
		cwd: ROOT,
		encoding: 'utf-8',
		stdio: ['ignore', 'pipe', 'pipe'],
		env: {
			...process.env,
			NODE_ENV: 'test',
			PORT: String(port),
			MULDER_LOG_LEVEL: 'silent',
			PGHOST: '',
			PGPORT: '',
			PGDATABASE: '',
			PGUSER: '',
			PGPASSWORD: '',
			GOOGLE_APPLICATION_CREDENTIALS: '',
			GOOGLE_CLOUD_PROJECT: '',
		},
	});
}

function stopProcess(child: SpawnedProcess): Promise<void> {
	return new Promise<void>((resolveStop) => {
		if (child.exitCode === null) {
			child.once('close', () => resolveStop());
			child.kill('SIGINT');
			return;
		}

		resolveStop();
	});
}

describe('Spec 69: Hono Server Scaffold', () => {
	const originalLogLevel = process.env.MULDER_LOG_LEVEL;

	beforeAll(async () => {
		process.env.MULDER_LOG_LEVEL = 'silent';
		await buildApiPackage();
	});

	afterAll(async () => {
		if (originalLogLevel === undefined) {
			delete process.env.MULDER_LOG_LEVEL;
		} else {
			process.env.MULDER_LOG_LEVEL = originalLogLevel;
		}
		// No shared resources are created in the API scaffold test.
	});

	it('QA-01: createApp serves a healthy response at /api/health', async () => {
		const module = await import(pathToFileURL(API_APP).href);
		expect(typeof module.createApp).toBe('function');

		const app = module.createApp();
		const response = await app.request('http://localhost/api/health');

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ status: 'ok', version: '0.0.0' });
	});

	it('QA-02: the Node entrypoint boots Hono and serves /api/health', async () => {
		const port = await findFreePort();
		const child = startApiServer(port);

		try {
			const response = await waitForHealth(`http://127.0.0.1:${port}/api/health`);
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ status: 'ok', version: '0.0.0' });
		} finally {
			await stopProcess(child);
		}
	});

	it('QA-03: the health route succeeds without database or GCP connectivity', async () => {
		const port = await findFreePort();
		const child = startApiServer(port);

		try {
			const response = await waitForHealth(`http://127.0.0.1:${port}/api/health`);
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ status: 'ok', version: '0.0.0' });
		} finally {
			await stopProcess(child);
		}
	});

	it('QA-04: the api package builds successfully with the scaffolded runtime', async () => {
		const buildResult = spawnSync('pnpm', ['build'], {
			cwd: API_DIR,
			encoding: 'utf-8',
			stdio: ['ignore', 'pipe', 'pipe'],
			env: {
				...process.env,
				MULDER_LOG_LEVEL: 'silent',
			},
		});

		expect(buildResult.status ?? 1).toBe(0);
		expect(typeof (await import(pathToFileURL(API_INDEX).href)).startApiServer).toBe('function');
	});
});
