import { createHash, randomUUID } from 'node:crypto';
import { createApp } from '@mulder/api';
import {
	createDocumentQualityAssessment,
	upsertKnowledgeAssertion,
	upsertReviewableArtifact,
	upsertSourceCredibilityProfile,
} from '@mulder/core';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as db from '../lib/db.js';
import { ensureSchema, truncateMulderTables } from '../lib/schema.js';

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

function hashToken(token: string): string {
	return createHash('sha256').update(`${TEST_API_CONFIG.auth.browser.session_secret}:${token}`).digest('hex');
}

async function readJson(response: Response): Promise<unknown> {
	return await response.json();
}

async function seedInvitation(
	pool: pg.Pool,
	input: { email: string; token: string; role: 'admin' | 'member' | 'owner' },
): Promise<void> {
	await pool.query(
		`
			INSERT INTO api_invitations (email, role, token_hash, expires_at)
			VALUES ($1, $2, $3, now() + interval '1 day')
		`,
		[input.email, input.role, hashToken(input.token)],
	);
}

async function acceptInvitation(app: ReturnType<typeof createApp>, pool: pg.Pool, role: 'admin' | 'member') {
	const token = `${role}-${randomUUID()}`;
	await seedInvitation(pool, { email: `${role}-${randomUUID()}@example.test`, role, token });
	const response = await app.request('http://localhost/api/auth/invitations/accept', {
		body: JSON.stringify({ token, password: 'correct horse battery staple' }),
		headers: { 'Content-Type': 'application/json' },
		method: 'POST',
	});
	expect(response.status).toBe(200);
	const setCookie = response.headers.get('set-cookie');
	expect(setCookie).toContain('mulder_session=');
	return setCookie?.split(';')[0] ?? '';
}

async function seedSource(pool: pg.Pool): Promise<string> {
	const id = randomUUID();
	await pool.query(
		[
			'INSERT INTO sources (id, filename, storage_path, file_hash, page_count, status, metadata)',
			'VALUES ($1, $2, $3, $4, 2, $5, $6::jsonb)',
		].join(' '),
		[
			id,
			'parity-source.pdf',
			`raw/${id}/parity-source.pdf`,
			randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', ''),
			'analyzed',
			JSON.stringify({ language: 'de' }),
		],
	);
	return id;
}

async function seedStory(pool: pg.Pool, sourceId: string): Promise<string> {
	const id = randomUUID();
	await pool.query(
		[
			'INSERT INTO stories (id, source_id, title, gcs_markdown_uri, gcs_metadata_uri, status, metadata)',
			'VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)',
		].join(' '),
		[
			id,
			sourceId,
			'Parity story',
			`gs://test/${id}.md`,
			`gs://test/${id}.json`,
			'enriched',
			JSON.stringify({ language: 'de' }),
		],
	);
	return id;
}

describe('Spec 117: review, claims, and source insight API routes', () => {
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

	it('serves document quality and credibility without mixing the concepts', async () => {
		const app = createApp({ config: TEST_API_CONFIG });
		const sourceId = await seedSource(pool);
		await createDocumentQualityAssessment(pool, {
			sourceId,
			assessmentMethod: 'automated',
			overallQuality: 'medium',
			processable: true,
			recommendedPath: 'standard',
			dimensions: {
				textReadability: { score: 0.72, method: 'ocr_confidence', details: 'Readable' },
				imageQuality: { score: 0.88, issues: [] },
				languageDetection: { primaryLanguage: 'de', confidence: 0.91, mixedLanguages: false },
				documentStructure: {
					type: 'printed_text',
					hasAnnotations: false,
					hasMarginalia: false,
					multiColumn: false,
				},
				contentCompleteness: {
					pagesTotal: 2,
					pagesReadable: 2,
					missingPagesSuspected: false,
					truncated: false,
				},
			},
			signals: { ocr_confidence: 0.72 },
		});
		await upsertSourceCredibilityProfile(pool, {
			sourceId,
			sourceName: 'Archive office',
			sourceType: 'organization',
			profileAuthor: 'llm_auto',
			reviewStatus: 'draft',
			dimensions: [
				{
					dimensionId: 'proximity',
					label: 'Proximity',
					score: 0.63,
					rationale: 'Institutional archive source.',
				},
			],
		});

		const qualityResponse = await app.request(`http://localhost/api/documents/${sourceId}/quality`, {
			headers: authorizedHeaders(),
		});
		expect(qualityResponse.status).toBe(200);
		expect(await readJson(qualityResponse)).toMatchObject({
			data: {
				latest: {
					source_id: sourceId,
					overall_quality: 'medium',
					recommended_path: 'standard',
				},
				assessments: [{ source_id: sourceId }],
			},
		});

		const credibilityResponse = await app.request(`http://localhost/api/documents/${sourceId}/credibility`, {
			headers: authorizedHeaders(),
		});
		expect(credibilityResponse.status).toBe(200);
		expect(await readJson(credibilityResponse)).toMatchObject({
			data: {
				source_id: sourceId,
				source_type: 'organization',
				review_status: 'draft',
				dimensions: [{ dimension_id: 'proximity' }],
			},
		});

		const listResponse = await app.request('http://localhost/api/source-credibility?review_status=draft', {
			headers: authorizedHeaders(),
		});
		expect(listResponse.status).toBe(200);
		expect(await readJson(listResponse)).toMatchObject({
			data: [{ source_id: sourceId }],
			meta: { count: 1, limit: 50, offset: 0 },
		});
	});

	it('returns total source credibility count for paginated lists', async () => {
		const app = createApp({ config: TEST_API_CONFIG });
		for (const label of ['Archive office', 'Field witness', 'Research group']) {
			const sourceId = await seedSource(pool);
			await upsertSourceCredibilityProfile(pool, {
				sourceId,
				sourceName: label,
				sourceType: 'organization',
				profileAuthor: 'llm_auto',
				reviewStatus: 'draft',
				dimensions: [
					{
						dimensionId: 'proximity',
						label: 'Proximity',
						score: 0.63,
						rationale: 'Institutional source.',
					},
				],
			});
		}
		const deletedSourceId = await seedSource(pool);
		await upsertSourceCredibilityProfile(pool, {
			sourceId: deletedSourceId,
			sourceName: 'Deleted source',
			sourceType: 'organization',
			profileAuthor: 'llm_auto',
			reviewStatus: 'draft',
			dimensions: [
				{
					dimensionId: 'proximity',
					label: 'Proximity',
					score: 0.2,
					rationale: 'Deleted source should not be listed.',
				},
			],
		});
		await pool.query("UPDATE sources SET deletion_status = 'soft_deleted', deleted_at = now() WHERE id = $1", [
			deletedSourceId,
		]);

		const response = await app.request('http://localhost/api/source-credibility?review_status=draft&limit=1', {
			headers: authorizedHeaders(),
		});
		expect(response.status).toBe(200);
		const body = (await readJson(response)) as {
			data: unknown[];
			meta: { count: number; limit: number; offset: number };
		};
		expect(body.data).toHaveLength(1);
		expect(body.meta).toEqual({ count: 3, limit: 1, offset: 0 });
	});

	it('lists first-class claims by global, source, story, and detail routes', async () => {
		const app = createApp({ config: TEST_API_CONFIG });
		const sourceId = await seedSource(pool);
		const storyId = await seedStory(pool, sourceId);
		const claim = await upsertKnowledgeAssertion(pool, {
			sourceId,
			storyId,
			assertionType: 'observation',
			content: 'The source mentions a meeting in Berlin.',
			confidenceMetadata: {
				witnessCount: 1,
				measurementBased: false,
				contemporaneous: true,
				corroborated: false,
				peerReviewed: false,
				authorIsInterpreter: false,
			},
		});

		for (const path of [
			`/api/claims?assertion_type=observation`,
			`/api/documents/${sourceId}/claims`,
			`/api/stories/${storyId}/claims`,
		]) {
			const response = await app.request(`http://localhost${path}`, { headers: authorizedHeaders() });
			expect(response.status).toBe(200);
			expect(await readJson(response)).toMatchObject({
				data: [
					{
						id: claim.id,
						source_id: sourceId,
						story_id: storyId,
						assertion_type: 'observation',
						content: 'The source mentions a meeting in Berlin.',
					},
				],
				meta: { count: 1 },
			});
		}

		const detailResponse = await app.request(`http://localhost/api/claims/${claim.id}`, {
			headers: authorizedHeaders(),
		});
		expect(detailResponse.status).toBe(200);
		expect(await readJson(detailResponse)).toMatchObject({
			data: {
				id: claim.id,
				classification_provenance: 'llm_auto',
			},
		});
	});

	it('serves review queues, artifacts, events, and actions', async () => {
		const app = createApp({ config: TEST_API_CONFIG });
		const sourceId = await seedSource(pool);
		const subjectId = randomUUID();
		const artifact = await upsertReviewableArtifact(pool, {
			artifactType: 'agent_finding',
			subjectId,
			subjectTable: 'agent_findings',
			currentValue: { title: 'Needs review' },
			context: { sensitivity_level: 'internal' },
			sourceId,
			priority: 5,
		});

		const queuesResponse = await app.request('http://localhost/api/review/queues', { headers: authorizedHeaders() });
		expect(queuesResponse.status).toBe(200);
		expect(await readJson(queuesResponse)).toMatchObject({
			data: expect.arrayContaining([
				expect.objectContaining({
					queue_key: 'contested_artifacts',
				}),
			]),
		});

		const artifactsResponse = await app.request(
			'http://localhost/api/review/queues/contested_artifacts/artifacts?review_status=pending',
			{ headers: authorizedHeaders() },
		);
		expect(artifactsResponse.status).toBe(200);
		expect(await readJson(artifactsResponse)).toMatchObject({
			data: [{ artifact_id: artifact.artifactId, artifact_type: 'agent_finding' }],
			meta: { count: 1 },
		});

		const actionResponse = await app.request(`http://localhost/api/review/artifacts/${artifact.artifactId}/actions`, {
			body: JSON.stringify({ action: 'comment', rationale: 'Looks relevant', tags: ['reader'] }),
			headers: { ...authorizedHeaders(), 'Content-Type': 'application/json' },
			method: 'POST',
		});
		expect(actionResponse.status).toBe(200);
		expect(await readJson(actionResponse)).toMatchObject({
			data: {
				artifact: { artifact_id: artifact.artifactId, review_status: 'pending' },
				event: { action: 'comment', tags: ['reader'] },
			},
		});

		const eventsResponse = await app.request(`http://localhost/api/review/artifacts/${artifact.artifactId}/events`, {
			headers: authorizedHeaders(),
		});
		expect(eventsResponse.status).toBe(200);
		expect(await readJson(eventsResponse)).toMatchObject({
			data: [{ artifact_id: artifact.artifactId, action: 'comment' }],
			meta: { count: 1 },
		});
	});

	it('enforces review artifact sensitivity, deleted-state, and review permission on detail/events/actions', async () => {
		const app = createApp({ config: TEST_API_CONFIG });
		const sourceId = await seedSource(pool);
		const memberCookie = await acceptInvitation(app, pool, 'member');
		const adminCookie = await acceptInvitation(app, pool, 'admin');
		const visible = await upsertReviewableArtifact(pool, {
			artifactType: 'agent_finding',
			subjectId: randomUUID(),
			subjectTable: 'agent_findings',
			reviewStatus: 'contested',
			currentValue: { title: 'Visible review' },
			context: { sensitivity_level: 'internal' },
			sourceId,
			priority: 5,
		});
		const hidden = await upsertReviewableArtifact(pool, {
			artifactType: 'agent_finding',
			subjectId: randomUUID(),
			subjectTable: 'agent_findings',
			reviewStatus: 'contested',
			currentValue: { title: 'Hidden review' },
			context: { sensitivity_level: 'confidential' },
			sourceId,
			priority: 4,
		});
		const deleted = await upsertReviewableArtifact(pool, {
			artifactType: 'agent_finding',
			subjectId: randomUUID(),
			subjectTable: 'agent_findings',
			reviewStatus: 'contested',
			currentValue: { title: 'Deleted review' },
			context: { sensitivity_level: 'internal' },
			sourceId,
			priority: 3,
		});
		await pool.query('UPDATE review_artifacts SET deleted_at = now() WHERE artifact_id = $1', [deleted.artifactId]);

		const queueSummaryResponse = await app.request('http://localhost/api/review/queues', {
			headers: { Cookie: memberCookie },
		});
		expect(queueSummaryResponse.status).toBe(200);
		const queueSummaryBody = (await readJson(queueSummaryResponse)) as {
			data: { queue_key: string; pending_count: number; oldest_pending: string | null }[];
		};
		const contestedSummary = queueSummaryBody.data.find((queue) => queue.queue_key === 'contested_artifacts');
		expect(contestedSummary).toMatchObject({ pending_count: 1 });
		expect(contestedSummary?.oldest_pending).not.toBeNull();

		const listResponse = await app.request(
			'http://localhost/api/review/queues/contested_artifacts/artifacts?review_status=contested',
			{ headers: { Cookie: memberCookie } },
		);
		expect(listResponse.status).toBe(200);
		const listBody = (await readJson(listResponse)) as {
			data: { artifact_id: string }[];
			meta: { count: number };
		};
		expect(listBody.data.map((item) => item.artifact_id)).toEqual([visible.artifactId]);
		expect(listBody.meta.count).toBe(1);

		const visibleDetail = await app.request(`http://localhost/api/review/artifacts/${visible.artifactId}`, {
			headers: { Cookie: memberCookie },
		});
		expect(visibleDetail.status).toBe(200);

		for (const path of [
			`/api/review/artifacts/${hidden.artifactId}`,
			`/api/review/artifacts/${hidden.artifactId}/events`,
			`/api/review/artifacts/${deleted.artifactId}`,
			`/api/review/artifacts/${deleted.artifactId}/events`,
		]) {
			const response = await app.request(`http://localhost${path}`, { headers: { Cookie: memberCookie } });
			expect(response.status).toBe(404);
			expect(await readJson(response)).toMatchObject({ error: { code: 'REVIEW_ARTIFACT_NOT_FOUND' } });
		}

		const deniedAction = await app.request(`http://localhost/api/review/artifacts/${visible.artifactId}/actions`, {
			body: JSON.stringify({ action: 'comment', rationale: 'Read-only member should not review' }),
			headers: { Cookie: memberCookie, 'Content-Type': 'application/json' },
			method: 'POST',
		});
		expect(deniedAction.status).toBe(403);
		expect(await readJson(deniedAction)).toMatchObject({ error: { code: 'AUTH_FORBIDDEN' } });

		const adminHiddenAction = await app.request(`http://localhost/api/review/artifacts/${hidden.artifactId}/actions`, {
			body: JSON.stringify({ action: 'comment', rationale: 'Admin can review confidential artifact' }),
			headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
			method: 'POST',
		});
		expect(adminHiddenAction.status).toBe(200);

		const deletedAction = await app.request(`http://localhost/api/review/artifacts/${deleted.artifactId}/actions`, {
			body: JSON.stringify({ action: 'comment', rationale: 'Deleted artifact should stay hidden' }),
			headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
			method: 'POST',
		});
		expect(deletedAction.status).toBe(404);
		expect(await readJson(deletedAction)).toMatchObject({ error: { code: 'REVIEW_ARTIFACT_NOT_FOUND' } });
	});

	it('protects the new product routes and validates params', async () => {
		const app = createApp({ config: TEST_API_CONFIG });

		const unauthenticatedResponse = await app.request('http://localhost/api/review/queues');
		expect(unauthenticatedResponse.status).toBe(401);

		const invalidClaimResponse = await app.request('http://localhost/api/claims/not-a-uuid', {
			headers: authorizedHeaders(),
		});
		expect(invalidClaimResponse.status).toBe(400);
		expect(await readJson(invalidClaimResponse)).toMatchObject({
			error: { code: 'VALIDATION_ERROR' },
		});
	});
});
