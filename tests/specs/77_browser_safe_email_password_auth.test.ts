import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as db from '../lib/db.js';

const ROOT = resolve(import.meta.dirname, '../..');
const CORE_DIR = resolve(ROOT, 'packages/core');
const API_DIR = resolve(ROOT, 'apps/api');
const CORE_DIST = resolve(CORE_DIR, 'dist/index.js');
const API_APP_DIST = resolve(API_DIR, 'dist/app.js');
const EXAMPLE_CONFIG = resolve(ROOT, 'mulder.config.example.yaml');
const CORE_MIGRATIONS_DIR = resolve(ROOT, 'packages/core/src/database/migrations');
const SESSION_SECRET = 'spec-77-browser-auth-secret';

type ApiApp = { request: (input: string | Request, init?: RequestInit) => Promise<Response> };
type TestHeaders = Record<string, string>;

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

function cleanAuthState(): void {
	db.runSql(['DELETE FROM api_sessions', 'DELETE FROM api_invitations', 'DELETE FROM api_users'].join('; '));
}

function hashToken(token: string): string {
	return createHash('sha256').update(`${SESSION_SECRET}:${token}`).digest('hex');
}

function seedInvitation(input: { email: string; token: string; role?: 'owner' | 'admin' | 'member' }): void {
	db.runSql(
		[
			'INSERT INTO api_invitations (email, role, token_hash, expires_at)',
			`VALUES ('${input.email}', '${input.role ?? 'member'}', '${hashToken(input.token)}', now() + interval '1 day');`,
		].join(' '),
	);
}

function cookieHeader(response: Response): string {
	const setCookie = response.headers.get('set-cookie');
	expect(setCookie).toContain('mulder_session=');
	expect(setCookie).toContain('HttpOnly');
	return setCookie?.split(';')[0] ?? '';
}

async function loadApiApp(): Promise<ApiApp> {
	const module = await import(pathToFileURL(API_APP_DIST).href);
	return module.createApp({
		config: {
			port: 8080,
			auth: {
				api_keys: [{ name: 'operator', key: 'test-api-key' }],
				browser: {
					enabled: true,
					cookie_name: 'mulder_session',
					session_secret: SESSION_SECRET,
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

async function postJson(app: ApiApp, path: string, body: unknown, headers?: TestHeaders): Promise<Response> {
	return await app.request(`http://localhost${path}`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			...(headers ?? {}),
		},
		body: JSON.stringify(body),
	});
}

describe('Spec 77: Browser-safe email/password auth', () => {
	let app: ApiApp;

	beforeAll(async () => {
		db.requirePg();
		process.env.MULDER_CONFIG = EXAMPLE_CONFIG;
		process.env.MULDER_LOG_LEVEL = 'silent';

		buildPackage(CORE_DIR);
		buildPackage(API_DIR);

		const coreModule = await import(pathToFileURL(CORE_DIST).href);
		const config = coreModule.loadConfig(EXAMPLE_CONFIG);
		const cloudSql = config.gcp?.cloud_sql;
		if (!cloudSql) {
			throw new Error('Expected example config to include gcp.cloud_sql');
		}

		await coreModule.runMigrations(coreModule.getWorkerPool(cloudSql), CORE_MIGRATIONS_DIR);
		app = await loadApiApp();
		cleanAuthState();
	}, 600_000);

	beforeEach(() => {
		cleanAuthState();
	});

	afterAll(() => {
		try {
			cleanAuthState();
		} catch {
			// Ignore cleanup failures.
		}
	});

	it('QA-01/02/03: invite acceptance creates a cookie session usable by protected browser routes', async () => {
		seedInvitation({ email: 'admin@example.com', token: 'admin-invite', role: 'admin' });

		const accept = await postJson(app, '/api/auth/invitations/accept', {
			token: 'admin-invite',
			password: 'correct horse battery staple',
		});
		expect(accept.status).toBe(200);
		const cookie = cookieHeader(accept);
		const acceptBody = (await accept.json()) as Record<string, unknown>;
		expect(JSON.stringify(acceptBody)).not.toContain('admin-invite');

		const session = await app.request('http://localhost/api/auth/session', {
			headers: { Cookie: cookie },
		});
		expect(session.status).toBe(200);
		expect(await session.json()).toMatchObject({
			data: {
				user: {
					email: 'admin@example.com',
					role: 'admin',
				},
			},
		});

		const documents = await app.request('http://localhost/api/documents', {
			headers: { Cookie: cookie },
		});
		expect(documents.status).toBe(200);
	});

	it('QA-04: login/logout works without exposing a bearer API key', async () => {
		seedInvitation({ email: 'member@example.com', token: 'member-invite', role: 'member' });
		await postJson(app, '/api/auth/invitations/accept', {
			token: 'member-invite',
			password: 'correct horse battery staple',
		});

		const login = await postJson(app, '/api/auth/login', {
			email: 'member@example.com',
			password: 'correct horse battery staple',
		});
		expect(login.status).toBe(200);
		const cookie = cookieHeader(login);

		const logout = await postJson(app, '/api/auth/logout', {}, { Cookie: cookie });
		expect(logout.status).toBe(204);

		const session = await app.request('http://localhost/api/auth/session', {
			headers: { Cookie: cookie },
		});
		expect(session.status).toBe(401);
	});

	it('QA-05: invitation creation is API-key/admin gated and never returns raw tokens', async () => {
		const apiKeyInvite = await postJson(
			app,
			'/api/auth/invitations',
			{ email: 'new-user@example.com', role: 'member' },
			{ Authorization: 'Bearer test-api-key' },
		);
		expect(apiKeyInvite.status).toBe(201);
		const apiKeyInviteBody = await apiKeyInvite.json();
		expect(JSON.stringify(apiKeyInviteBody)).not.toContain('token');

		seedInvitation({ email: 'plain-member@example.com', token: 'plain-member-invite', role: 'member' });
		const accept = await postJson(app, '/api/auth/invitations/accept', {
			token: 'plain-member-invite',
			password: 'correct horse battery staple',
		});
		const memberCookie = cookieHeader(accept);

		const denied = await postJson(
			app,
			'/api/auth/invitations',
			{ email: 'denied@example.com', role: 'member' },
			{ Cookie: memberCookie },
		);
		expect(denied.status).toBe(403);
	});

	it('QA-05b: production invitation creation sends the raw token through the delivery provider only', async () => {
		const originalDelivery = process.env.MULDER_INVITE_DELIVERY;
		const originalBaseUrl = process.env.MULDER_APP_BASE_URL;
		const originalFrom = process.env.MULDER_MAIL_FROM;
		const originalApiKey = process.env.RESEND_API_KEY;
		const fetchCalls: Array<{ body?: unknown }> = [];
		const fetchMock = vi.fn(async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			fetchCalls.push({ body: init?.body });
			return new Response('{}', { status: 200 });
		});
		const originalFetch = globalThis.fetch;

		process.env.MULDER_INVITE_DELIVERY = 'resend';
		process.env.MULDER_APP_BASE_URL = 'https://app.example.test';
		process.env.MULDER_MAIL_FROM = 'Mulder <invites@example.com>';
		process.env.RESEND_API_KEY = 'resend-test-key';
		globalThis.fetch = fetchMock as typeof fetch;

		try {
			const response = await postJson(
				app,
				'/api/auth/invitations',
				{ email: 'owner@example.com', role: 'owner' },
				{ Authorization: 'Bearer test-api-key' },
			);
			expect(response.status).toBe(201);
			const responseBody = await response.json();
			expect(JSON.stringify(responseBody)).not.toContain('/auth/invitations/');
			expect(fetchMock).toHaveBeenCalledTimes(1);

			const deliveryBody = JSON.parse(String(fetchCalls[0]?.body)) as { to: string; html: string; text: string };
			expect(deliveryBody.to).toBe('owner@example.com');
			expect(deliveryBody.text).toContain('https://app.example.test/auth/invitations/');
			expect(deliveryBody.html).toContain('https://app.example.test/auth/invitations/');
		} finally {
			globalThis.fetch = originalFetch;
			if (originalDelivery === undefined) delete process.env.MULDER_INVITE_DELIVERY;
			else process.env.MULDER_INVITE_DELIVERY = originalDelivery;
			if (originalBaseUrl === undefined) delete process.env.MULDER_APP_BASE_URL;
			else process.env.MULDER_APP_BASE_URL = originalBaseUrl;
			if (originalFrom === undefined) delete process.env.MULDER_MAIL_FROM;
			else process.env.MULDER_MAIL_FROM = originalFrom;
			if (originalApiKey === undefined) delete process.env.RESEND_API_KEY;
			else process.env.RESEND_API_KEY = originalApiKey;
		}
	});

	it('QA-06: the app bundle source does not reference VITE_MULDER_API_KEY', () => {
		const apiClient = readFileSync(resolve(ROOT, 'apps/app/src/lib/api-client.ts'), 'utf8');
		const authGate = readFileSync(resolve(ROOT, 'apps/app/src/app/AuthGate.tsx'), 'utf8');
		expect(apiClient).not.toContain('VITE_MULDER_API_KEY');
		expect(authGate).not.toContain('VITE_MULDER_API_KEY');
	});
});
