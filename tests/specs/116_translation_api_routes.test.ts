import { randomUUID } from 'node:crypto';
import { createApp } from '@mulder/api';
import { isSupportedJobType, parseWorkerJobPayload } from '@mulder/worker';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
	budget: {
		enabled: true,
		monthly_limit_usd: 50,
		extract_per_page_usd: 0.006,
		segment_per_page_usd: 0.002,
		enrich_per_source_usd: 0.015,
		embed_per_source_usd: 0.004,
		graph_per_source_usd: 0.001,
	},
};

function authorizedHeaders(): Record<string, string> {
	return {
		Authorization: 'Bearer test-api-key',
	};
}

async function readJson(response: Response): Promise<unknown> {
	return await response.json();
}

async function seedSource(pool: pg.Pool): Promise<string> {
	const id = randomUUID();
	await pool.query(
		[
			'INSERT INTO sources (id, filename, storage_path, file_hash, page_count, has_native_text, native_text_ratio, status, metadata)',
			'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)',
		].join(' '),
		[
			id,
			'translation-source.pdf',
			`raw/${id}/translation-source.pdf`,
			randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', ''),
			1,
			true,
			1,
			'analyzed',
			JSON.stringify({ language: 'de' }),
		],
	);
	return id;
}

async function seedTranslation(pool: pg.Pool, sourceId: string): Promise<string> {
	const result = await pool.query<{ id: string }>(
		`
			INSERT INTO translated_documents (
				source_document_id,
				source_language,
				target_language,
				translation_engine,
				content,
				content_hash,
				status,
				pipeline_path,
				output_format,
				sensitivity_level,
				sensitivity_metadata
			)
			VALUES ($1, 'de', 'en', 'fixture', 'Translated content', 'content-hash', 'current', 'translation_only', 'markdown', 'internal', $2::jsonb)
			RETURNING id
		`,
		[
			sourceId,
			JSON.stringify({
				level: 'internal',
				reason: 'test',
				assigned_by: 'policy_rule',
				assigned_at: new Date(0).toISOString(),
				pii_types: [],
				declassify_date: null,
			}),
		],
	);
	return result.rows[0].id;
}

async function seedStory(pool: pg.Pool, sourceId: string): Promise<string> {
	const result = await pool.query<{ id: string }>(
		`
			INSERT INTO stories (
				source_id,
				title,
				language,
				page_start,
				page_end,
				gcs_markdown_uri,
				gcs_metadata_uri,
				status
			)
			VALUES ($1, 'Story', 'de', 1, 1, 'stories/story.md', 'stories/story.json', 'enriched')
			RETURNING id
		`,
		[sourceId],
	);
	return result.rows[0].id;
}

async function seedTranslatedStory(
	pool: pg.Pool,
	translationId: string,
	storyId: string,
	sourceId: string,
): Promise<void> {
	await pool.query(
		`
			INSERT INTO translated_stories (
				translation_id,
				story_id,
				source_document_id,
				source_language,
				target_language,
				title,
				markdown,
				content_hash,
				sensitivity_level,
				sensitivity_metadata
			)
			VALUES ($1, $2, $3, 'de', 'en', 'Translated Story', 'Translated story markdown', 'story-hash', 'internal', '{}'::jsonb)
		`,
		[translationId, storyId, sourceId],
	);
}

describe('Spec 116: translation API routes', () => {
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

	it('lists and fetches source-level translations', async () => {
		const app = createApp({ config: TEST_API_CONFIG });
		const sourceId = await seedSource(pool);
		const translationId = await seedTranslation(pool, sourceId);

		const listResponse = await app.request(`http://localhost/api/documents/${sourceId}/translations`, {
			headers: authorizedHeaders(),
		});
		expect(listResponse.status).toBe(200);
		expect(await readJson(listResponse)).toMatchObject({
			data: [
				{
					id: translationId,
					source_document_id: sourceId,
					source_language: 'de',
					target_language: 'en',
					content: 'Translated content',
					status: 'current',
				},
			],
			meta: {
				count: 1,
				limit: 20,
				offset: 0,
			},
		});

		const detailResponse = await app.request(`http://localhost/api/translations/${translationId}`, {
			headers: authorizedHeaders(),
		});
		expect(detailResponse.status).toBe(200);
		expect(await readJson(detailResponse)).toMatchObject({
			data: {
				id: translationId,
				source_document_id: sourceId,
				content: 'Translated content',
			},
		});
	});

	it('returns cached translations or enqueues refresh jobs', async () => {
		const app = createApp({ config: TEST_API_CONFIG });
		const sourceId = await seedSource(pool);
		const translationId = await seedTranslation(pool, sourceId);
		const storyId = await seedStory(pool, sourceId);
		await seedTranslatedStory(pool, translationId, storyId, sourceId);

		const cachedResponse = await app.request(`http://localhost/api/documents/${sourceId}/translations`, {
			body: JSON.stringify({ target_language: 'en' }),
			headers: { ...authorizedHeaders(), 'Content-Type': 'application/json' },
			method: 'POST',
		});
		expect(cachedResponse.status).toBe(200);
		expect(await readJson(cachedResponse)).toMatchObject({
			data: {
				id: translationId,
				status: 'current',
			},
		});

		const refreshResponse = await app.request(`http://localhost/api/documents/${sourceId}/translations`, {
			body: JSON.stringify({ target_language: 'en', refresh: true }),
			headers: { ...authorizedHeaders(), 'Content-Type': 'application/json' },
			method: 'POST',
		});
		expect(refreshResponse.status).toBe(202);
		const refreshBody = (await readJson(refreshResponse)) as { data: { job_id: string }; links: { status: string } };
		expect(refreshBody.links.status).toBe(`/api/jobs/${refreshBody.data.job_id}`);

		const job = await pool.query<{ type: string; payload: Record<string, unknown> }>('SELECT type, payload FROM jobs');
		expect(job.rows).toHaveLength(1);
		expect(job.rows[0]).toMatchObject({
			type: 'translate',
			payload: {
				sourceId,
				targetLanguage: 'en',
				refresh: true,
			},
		});
	});

	it('enqueues translation backfill when a cached translation has no translated stories', async () => {
		const app = createApp({ config: TEST_API_CONFIG });
		const sourceId = await seedSource(pool);
		await seedTranslation(pool, sourceId);
		await seedStory(pool, sourceId);

		const response = await app.request(`http://localhost/api/documents/${sourceId}/translations`, {
			body: JSON.stringify({ target_language: 'en' }),
			headers: { ...authorizedHeaders(), 'Content-Type': 'application/json' },
			method: 'POST',
		});
		expect(response.status).toBe(202);
		const body = (await readJson(response)) as { data: { job_id: string }; links: { status: string } };
		expect(body.links.status).toBe(`/api/jobs/${body.data.job_id}`);

		const job = await pool.query<{ type: string; payload: Record<string, unknown> }>('SELECT type, payload FROM jobs');
		expect(job.rows).toHaveLength(1);
		expect(job.rows[0]).toMatchObject({
			type: 'translate',
			payload: {
				sourceId,
				targetLanguage: 'en',
				refresh: false,
			},
		});
	});

	it('returns cached source translations when there are no original stories to backfill', async () => {
		const app = createApp({ config: TEST_API_CONFIG });
		const sourceId = await seedSource(pool);
		const translationId = await seedTranslation(pool, sourceId);

		const response = await app.request(`http://localhost/api/documents/${sourceId}/translations`, {
			body: JSON.stringify({ target_language: 'en' }),
			headers: { ...authorizedHeaders(), 'Content-Type': 'application/json' },
			method: 'POST',
		});
		expect(response.status).toBe(200);
		expect(await readJson(response)).toMatchObject({
			data: {
				id: translationId,
				status: 'current',
			},
		});

		const job = await pool.query<{ type: string; payload: Record<string, unknown> }>('SELECT type, payload FROM jobs');
		expect(job.rows).toHaveLength(0);
	});

	it('protects routes and validates request bodies', async () => {
		const app = createApp({ config: TEST_API_CONFIG });
		const sourceId = await seedSource(pool);

		const unauthenticatedResponse = await app.request(`http://localhost/api/documents/${sourceId}/translations`);
		expect(unauthenticatedResponse.status).toBe(401);

		const invalidResponse = await app.request(`http://localhost/api/documents/${sourceId}/translations`, {
			body: JSON.stringify({ target_language: '' }),
			headers: { ...authorizedHeaders(), 'Content-Type': 'application/json' },
			method: 'POST',
		});
		expect(invalidResponse.status).toBe(400);
		expect(await readJson(invalidResponse)).toMatchObject({
			error: {
				code: 'VALIDATION_ERROR',
				message: 'Invalid request',
			},
		});
	});

	it('accepts and validates translate worker payloads', () => {
		expect(isSupportedJobType('translate')).toBe(true);
		expect(
			parseWorkerJobPayload('00000000-0000-4000-8000-000000116001', 'translate', {
				source_id: 'source-1',
				source_language: 'de',
				target_language: 'en',
				pipeline_path: 'translation_only',
				output_format: 'markdown',
				refresh: true,
			}),
		).toEqual({
			sourceId: 'source-1',
			sourceLanguage: 'de',
			targetLanguage: 'en',
			pipelinePath: 'translation_only',
			outputFormat: 'markdown',
			refresh: true,
		});

		expect(() =>
			parseWorkerJobPayload('00000000-0000-4000-8000-000000116002', 'translate', {
				source_id: 'source-1',
				target_language: 'en',
				output_format: 'pdf',
			}),
		).toThrow('valid outputFormat');
	});
});
