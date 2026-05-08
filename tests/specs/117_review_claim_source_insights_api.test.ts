import { randomUUID } from 'node:crypto';
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
