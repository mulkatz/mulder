import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createApp } from '@mulder/api';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');

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

describe('Spec 82: API surface documentation alignment', () => {
	it('QA-01: /doc and /reference are not public middleware exceptions', async () => {
		const app = createApp({ config: TEST_API_CONFIG });

		const openapi = await app.request('http://localhost/api/openapi.json');
		const doc = await app.request('http://localhost/doc');
		const reference = await app.request('http://localhost/reference');

		expect(openapi.status).toBe(200);
		expect(doc.status).toBe(401);
		expect(reference.status).toBe(401);
	});

	it('QA-02: OpenAPI JSON is mounted for product routes only', async () => {
		const app = createApp({ config: TEST_API_CONFIG });

		const response = await app.request('http://localhost/api/openapi.json');
		const contract = (await response.json()) as {
			openapi: string;
			paths: Record<string, unknown>;
		};

		expect(contract.openapi).toBe('3.0.0');
		expect(contract.paths).toHaveProperty('/api/health');
		expect(contract.paths).toHaveProperty('/api/status');
		expect(contract.paths).toHaveProperty('/api/documents');
		expect(contract.paths).toHaveProperty('/api/documents/{id}');
		expect(contract.paths).toHaveProperty('/api/documents/{id}/quality');
		expect(contract.paths).toHaveProperty('/api/documents/{id}/credibility');
		expect(contract.paths).toHaveProperty('/api/documents/{id}/claims');
		expect(contract.paths).toHaveProperty('/api/documents/{id}/translations');
		expect(contract.paths).toHaveProperty('/api/translations/{translationId}');
		expect(contract.paths).toHaveProperty('/api/review/queues');
		expect(contract.paths).toHaveProperty('/api/review/queues/{queueKey}/artifacts');
		expect(contract.paths).toHaveProperty('/api/review/artifacts/{artifactId}');
		expect(contract.paths).toHaveProperty('/api/review/artifacts/{artifactId}/events');
		expect(contract.paths).toHaveProperty('/api/review/artifacts/{artifactId}/actions');
		expect(contract.paths).toHaveProperty('/api/claims');
		expect(contract.paths).toHaveProperty('/api/claims/{claimId}');
		expect(contract.paths).toHaveProperty('/api/stories/{storyId}/claims');
		expect(contract.paths).toHaveProperty('/api/source-credibility');
		expect(contract.paths).toHaveProperty('/api/collections');
		expect(contract.paths).toHaveProperty('/api/collections/{collectionId}');
		expect(contract.paths).toHaveProperty('/api/taxonomy');
		expect(contract.paths).toHaveProperty('/api/taxonomy/export');
		expect(contract.paths).toHaveProperty('/api/discovery/similar-entities');
		expect(contract.paths).toHaveProperty('/api/discovery/temporal-patterns');
		expect(contract.paths).toHaveProperty('/api/discovery/classification-mappings');
		expect(contract.paths).toHaveProperty('/api/discovery/external-correlations');
		expect(contract.paths).toHaveProperty('/api/search');
		expect(contract.paths).not.toHaveProperty('/doc');
		expect(contract.paths).not.toHaveProperty('/reference');
	});

	it('QA-03: config example does not advertise an explorer key', () => {
		const config = readFileSync(resolve(ROOT, 'mulder.config.example.yaml'), 'utf8');

		expect(config).not.toContain('explorer:');
		expect(config).not.toContain('/reference');
		expect(config).toContain('browser:');
	});

	it('QA-04: API architecture documents OpenAPI JSON without promising an explorer', () => {
		const docs = readFileSync(resolve(ROOT, 'docs/api-architecture.md'), 'utf8');

		expect(docs).toContain('GET /api/openapi.json');
		expect(docs).toContain('No API explorer is mounted');
		expect(docs).not.toContain('Accessible at `/reference`');
		expect(docs).not.toContain('spec served automatically at /doc');
	});
});
