import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const CORE_DIR = resolve(ROOT, 'packages/core');
const CORE_DIST = resolve(CORE_DIR, 'dist/index.js');
const API_DIR = resolve(ROOT, 'apps/api');
const API_DIST = resolve(API_DIR, 'dist/index.js');
const API_APP_DIST = resolve(API_DIR, 'dist/app.js');
const MAX_BODY_BYTES = 10 * 1024 * 1024;

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

function writeTempConfig(dir: string, yaml: string): string {
	const filePath = resolve(dir, 'mulder.config.yaml');
	writeFileSync(filePath, yaml, 'utf-8');
	return filePath;
}

describe('Spec 70: API Middleware Stack', () => {
	let tmpDir = '';
	let loadConfig!: (path?: string) => unknown;
	let createApp!: (options?: { config?: unknown }) => Hono;
	let MulderError!: new (message: string, code: string, options?: { context?: Record<string, unknown> }) => Error;

	beforeAll(async () => {
		process.env.MULDER_LOG_LEVEL = 'silent';
		buildPackage(CORE_DIR);
		buildPackage(API_DIR);

		const core = await import(pathToFileURL(CORE_DIST).href);
		const api = await import(pathToFileURL(API_DIST).href);
		const apiApp = await import(pathToFileURL(API_APP_DIST).href);

		loadConfig = core.loadConfig;
		MulderError = core.MulderError;
		createApp = apiApp.createApp ?? api.createApp;

		tmpDir = mkdtempSync(resolve(tmpdir(), 'mulder-qa-70-'));
	});

	afterAll(() => {
		if (tmpDir) {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it('QA-01: public health checks stay unauthenticated and traceable', async () => {
		const app = createApp();
		const response = await app.request('http://localhost/api/health');

		expect(response.status).toBe(200);
		expect(response.headers.get('x-request-id')).toMatch(/.+/);
		expect(await response.json()).toEqual({ status: 'ok', version: '0.0.0' });
	});

	it('QA-02: protected routes reject missing or invalid bearer tokens', async () => {
		const app = createApp({
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
			},
		});

		app.get('/api/protected', (c) => c.json({ ok: true }, 200));

		const missingAuth = await app.request('http://localhost/api/protected');
		expect(missingAuth.status).toBe(401);
		expect(await missingAuth.json()).toEqual({
			error: {
				code: 'AUTH_UNAUTHORIZED',
				message: 'A valid API key is required',
			},
		});

		const invalidAuth = await app.request('http://localhost/api/protected', {
			headers: {
				Authorization: 'Bearer wrong-key',
			},
		});
		expect(invalidAuth.status).toBe(401);
	});

	it('QA-03: rate-limited routes return 429 with retry guidance', async () => {
		const app = createApp({
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
			},
		});

		app.get('/api/evidence/ping', (c) => c.json({ ok: true }, 200));

		for (let index = 0; index < 60; index += 1) {
			const response = await app.request('http://localhost/api/evidence/ping', {
				method: 'GET',
				headers: {
					Authorization: 'Bearer test-api-key',
					'X-Forwarded-For': `203.0.113.${index + 1}`,
				},
			});

			expect(response.status).toBe(200);
		}

		const throttled = await app.request('http://localhost/api/evidence/ping', {
			method: 'GET',
			headers: {
				Authorization: 'Bearer test-api-key',
				'X-Forwarded-For': '198.51.100.250',
			},
		});

		expect(throttled.status).toBe(429);
		expect(throttled.headers.get('retry-after')).toMatch(/^[1-9]\d*$/);
		expect(await throttled.json()).toEqual({
			error: {
				code: 'RATE_LIMIT_EXCEEDED',
				message: 'Too many requests',
				details: {
					retry_after_seconds: expect.any(Number),
					tier: 'standard',
				},
			},
		});
	});

	it('QA-04: oversized request bodies are rejected before handler logic', async () => {
		const app = createApp({
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
			},
		});

		let handlerInvoked = false;
		app.post('/api/search', () => {
			handlerInvoked = true;
			return new Response('should not run', { status: 200 });
		});

		const oversizedBody = new TextEncoder().encode('x'.repeat(MAX_BODY_BYTES + 1));
		const request = new Request('http://localhost/api/search', {
			method: 'POST',
			headers: {
				Authorization: 'Bearer test-api-key',
				'Content-Type': 'text/plain',
			},
			body: new ReadableStream({
				start(controller) {
					controller.enqueue(oversizedBody);
					controller.close();
				},
			}),
			duplex: 'half',
		});
		const response = await app.request(request);

		expect(response.status).toBe(413);
		expect(handlerInvoked).toBe(false);
		expect(await response.json()).toEqual({
			error: {
				code: 'REQUEST_BODY_TOO_LARGE',
				message: 'Request body exceeds the API limit',
				details: {
					content_length: MAX_BODY_BYTES + 1,
					max_bytes: MAX_BODY_BYTES,
				},
			},
		});
	});

	it('QA-05: known application and validation errors are normalized', async () => {
		const app = createApp({
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
			},
		});

		app.get('/api/mulder-error', () => {
			throw new MulderError('boom', 'CONFIG_INVALID', {
				context: {
					field: 'api.port',
				},
			});
		});

		app.get('/api/config-validation-error', () => {
			const invalidConfigPath = writeTempConfig(
				tmpDir,
				`
project:
  description: "missing required project name"

gcp:
  project_id: "test-gcp-project"
  region: "europe-west1"
  cloud_sql:
    instance_name: "test-db"
    database: "testdb"
  storage:
    bucket: "test-bucket"
  document_ai:
    processor_id: "test-processor"

ontology:
  entity_types:
    - name: "person"
      description: "A named individual"
  relationships: []
`,
			);

			loadConfig(invalidConfigPath);
			return new Response('unreachable', { status: 200 });
		});

		app.get('/api/unexpected-error', () => {
			throw new Error('kaboom');
		});

		const authHeaders = {
			Authorization: 'Bearer test-api-key',
		};

		const mulderErrorResponse = await app.request('http://localhost/api/mulder-error', {
			headers: authHeaders,
		});
		expect(mulderErrorResponse.status).toBe(400);
		expect(await mulderErrorResponse.json()).toEqual({
			error: {
				code: 'CONFIG_INVALID',
				message: 'boom',
				details: {
					field: 'api.port',
				},
			},
		});

		const validationErrorResponse = await app.request('http://localhost/api/config-validation-error', {
			headers: authHeaders,
		});
		expect(validationErrorResponse.status).toBe(400);
		expect(validationErrorResponse.headers.get('x-request-id')).toMatch(/.+/);
		expect(await validationErrorResponse.json()).toEqual({
			error: {
				code: 'CONFIG_INVALID',
				message: expect.any(String),
				details: {
					issueCount: 1,
				},
			},
		});

		const unexpectedErrorResponse = await app.request('http://localhost/api/unexpected-error', {
			headers: authHeaders,
		});
		expect(unexpectedErrorResponse.status).toBe(500);
		expect(await unexpectedErrorResponse.json()).toEqual({
			error: {
				code: 'INTERNAL_ERROR',
				message: 'Internal server error',
			},
		});
	});

	it('QA-06: the API config schema supplies api defaults without requiring an api block', () => {
		const configDir = mkdtempSync(resolve(tmpdir(), 'mulder-qa-70-config-'));
		try {
			const configPath = writeTempConfig(
				configDir,
				`
project:
  name: "test-project"

gcp:
  project_id: "test-gcp-project"
  region: "europe-west1"
  cloud_sql:
    instance_name: "test-db"
    database: "testdb"
  storage:
    bucket: "test-bucket"
  document_ai:
    processor_id: "test-processor"

ontology:
  entity_types:
    - name: "person"
      description: "A named individual"
  relationships: []
`,
			);

			const config = loadConfig(configPath) as {
				api: {
					port: number;
					auth: {
						api_keys: Array<{ name: string; key: string }>;
						browser: { enabled: boolean; cookie_name: string };
					};
					rate_limiting: { enabled: boolean };
				};
			};
			expect(config.api.port).toBe(8080);
			expect(config.api.auth.api_keys).toEqual([]);
			expect(config.api.auth.browser.enabled).toBe(true);
			expect(config.api.auth.browser.cookie_name).toBe('mulder_session');
			expect(config.api.rate_limiting.enabled).toBe(true);
		} finally {
			rmSync(configDir, { recursive: true, force: true });
		}
	});

	it('QA-07: configured browser origins get credentialed CORS preflight headers', async () => {
		const originalOrigins = process.env.MULDER_CORS_ORIGINS;
		process.env.MULDER_CORS_ORIGINS = 'https://app.example.test';

		try {
			const app = createApp();
			const allowed = await app.request('http://localhost/api/documents', {
				method: 'OPTIONS',
				headers: {
					Origin: 'https://app.example.test',
					'Access-Control-Request-Method': 'GET',
				},
			});
			expect(allowed.status).toBe(204);
			expect(allowed.headers.get('access-control-allow-origin')).toBe('https://app.example.test');
			expect(allowed.headers.get('access-control-allow-credentials')).toBe('true');
			expect(allowed.headers.get('access-control-allow-headers')).toContain('Authorization');

			const blocked = await app.request('http://localhost/api/documents', {
				method: 'OPTIONS',
				headers: {
					Origin: 'https://example.invalid',
					'Access-Control-Request-Method': 'GET',
				},
			});
			expect(blocked.status).toBe(403);
			expect(blocked.headers.get('access-control-allow-origin')).toBeNull();
		} finally {
			if (originalOrigins === undefined) {
				delete process.env.MULDER_CORS_ORIGINS;
			} else {
				process.env.MULDER_CORS_ORIGINS = originalOrigins;
			}
		}
	});
});
