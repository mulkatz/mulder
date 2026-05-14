import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../apps/api/src/app.js';
import * as db from '../lib/db.js';
import { ensureSchema, truncateMulderTables } from '../lib/schema.js';

const mocks = vi.hoisted(() => ({
	getWorkerPool: vi.fn(),
}));

vi.mock('@mulder/core', async () => {
	const actual = await vi.importActual<typeof import('@mulder/core')>('@mulder/core');
	return {
		...actual,
		getWorkerPool: mocks.getWorkerPool,
	};
});

const TEST_API_CONFIG = {
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
			same_site: 'Lax' as const,
		},
	},
	rate_limiting: {
		enabled: true,
	},
};

function hashSessionToken(token: string): string {
	return createHash('sha256').update(`${TEST_API_CONFIG.auth.browser.session_secret}:${token}`).digest('hex');
}

async function seedSession(pool: pg.Pool): Promise<string> {
	const userId = randomUUID();
	const token = `member-${randomUUID()}`;
	await pool.query(
		['INSERT INTO api_users (id, email, password_hash, role)', 'VALUES ($1, $2, $3, $4)', 'RETURNING id'].join(' '),
		[userId, `member-${randomUUID()}@example.test`, 'test-hash', 'member'],
	);
	await pool.query(
		"INSERT INTO api_sessions (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
		[userId, hashSessionToken(token)],
	);
	return `mulder_session=${token}`;
}

async function seedRunScopedJob(pool: pg.Pool) {
	const sourceId = randomUUID();
	const runId = randomUUID();
	const jobId = randomUUID();
	await pool.query(
		[
			'INSERT INTO sources (id, filename, storage_path, file_hash, page_count, has_native_text, native_text_ratio, status, metadata, sensitivity_level, sensitivity_metadata)',
			'VALUES ($1, $2, $3, $4, 1, true, 1, $5, $6::jsonb, $7, $8::jsonb)',
		].join(' '),
		[
			sourceId,
			'run-scoped.pdf',
			`raw/${sourceId}/run-scoped.pdf`,
			randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', ''),
			'ingested',
			JSON.stringify({ language: 'de' }),
			'public',
			JSON.stringify({
				level: 'public',
				reason: 'run_scope_test',
				assigned_by: 'policy_rule',
				assigned_at: new Date(0).toISOString(),
				pii_types: [],
				declassify_date: null,
			}),
		],
	);
	await pool.query(
		'INSERT INTO pipeline_runs (id, tag, options, status, created_at) VALUES ($1, $2, $3::jsonb, $4, $5)',
		[runId, 'run-scoped-access', '{}', 'running', '2026-05-14T10:00:00.000Z'],
	);
	await pool.query(
		[
			'INSERT INTO pipeline_run_sources (run_id, source_id, current_step, status, error_message, updated_at)',
			'VALUES ($1, $2, $3, $4, NULL, $5)',
		].join(' '),
		[runId, sourceId, 'segment', 'processing', '2026-05-14T10:01:00.000Z'],
	);
	await pool.query(
		[
			'INSERT INTO jobs (id, type, payload, status, attempts, max_attempts, created_at, started_at)',
			'VALUES ($1, $2, $3::jsonb, $4, 1, 3, $5, $6)',
		].join(' '),
		[
			jobId,
			'pipeline_run',
			JSON.stringify({ run_id: runId }),
			'running',
			'2026-05-14T10:00:30.000Z',
			'2026-05-14T10:00:40.000Z',
		],
	);
	return { jobId, runId, sourceId };
}

describe('Job status run-scoped access', () => {
	let pool: pg.Pool;
	const originalConfig = process.env.MULDER_CONFIG;

	beforeAll(() => {
		db.requirePg();
		process.env.MULDER_CONFIG = 'mulder.config.example.yaml';
		ensureSchema();
		pool = new pg.Pool({
			host: db.TEST_PG_HOST,
			port: db.TEST_PG_PORT,
			user: db.TEST_PG_USER,
			password: db.TEST_PG_PASSWORD,
			database: db.TEST_PG_DATABASE,
		});
	});

	beforeEach(() => {
		truncateMulderTables();
		mocks.getWorkerPool.mockReset();
		mocks.getWorkerPool.mockReturnValue(pool);
	});

	afterAll(async () => {
		truncateMulderTables();
		await pool?.end();
		if (originalConfig === undefined) {
			delete process.env.MULDER_CONFIG;
		} else {
			process.env.MULDER_CONFIG = originalConfig;
		}
	});

	it('allows session users to inspect jobs scoped only by a visible run', async () => {
		const app = createApp({ config: TEST_API_CONFIG });
		const cookie = await seedSession(pool);
		const { jobId, runId, sourceId } = await seedRunScopedJob(pool);
		const seeded = await pool.query<{ count: string }>('SELECT COUNT(*) AS count FROM jobs WHERE id = $1', [jobId]);
		expect(seeded.rows[0]?.count).toBe('1');

		const operatorResponse = await app.request(`http://localhost/api/jobs/${jobId}`, {
			headers: {
				Authorization: 'Bearer test-api-key',
				'X-Forwarded-For': '203.0.113.116',
			},
		});
		expect(operatorResponse.status).toBe(200);
		expect(await operatorResponse.json()).toMatchObject({
			data: {
				progress: {
					run_id: runId,
					sources: [
						{
							source: {
								filename: 'run-scoped.pdf',
							},
						},
					],
				},
			},
		});

		const detailResponse = await app.request(`http://localhost/api/jobs/${jobId}`, {
			headers: {
				Cookie: cookie,
				'X-Forwarded-For': '203.0.113.117',
			},
		});

		expect(detailResponse.status).toBe(200);
		const detailBody = (await detailResponse.json()) as {
			data: {
				job: Record<string, unknown>;
				progress: {
					run_id: string;
					sources: Array<{ source_id: string; source: { filename: string } | null; error_message: string | null }>;
				};
			};
		};
		expect(detailBody.data.job).toMatchObject({
			id: jobId,
			subject: {
				kind: 'source',
				label: 'run-scoped.pdf',
				source_id: sourceId,
			},
		});
		expect(detailBody.data.job).not.toHaveProperty('payload');
		expect(detailBody.data.progress).toMatchObject({
			run_id: runId,
			sources: [
				{
					source_id: sourceId,
					source: {
						filename: 'run-scoped.pdf',
					},
					error_message: null,
				},
			],
		});

		const listResponse = await app.request('http://localhost/api/jobs', {
			headers: {
				Cookie: cookie,
				'X-Forwarded-For': '203.0.113.118',
			},
		});
		expect(listResponse.status).toBe(200);
		expect(await listResponse.json()).toMatchObject({
			data: [
				{
					id: jobId,
					subject: {
						label: 'run-scoped.pdf',
					},
				},
			],
			meta: {
				count: 1,
			},
		});
	});
});
