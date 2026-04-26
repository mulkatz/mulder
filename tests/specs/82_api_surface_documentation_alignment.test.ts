import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../apps/api/src/app.js';

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

		const doc = await app.request('http://localhost/doc');
		const reference = await app.request('http://localhost/reference');

		expect(doc.status).toBe(401);
		expect(reference.status).toBe(401);
	});

	it('QA-02: config example does not advertise an explorer key', () => {
		const config = readFileSync(resolve(ROOT, 'mulder.config.example.yaml'), 'utf8');

		expect(config).not.toContain('explorer:');
		expect(config).not.toContain('/reference');
		expect(config).toContain('browser:');
	});

	it('QA-03: API architecture marks OpenAPI and Scalar as future work', () => {
		const docs = readFileSync(resolve(ROOT, 'docs/api-architecture.md'), 'utf8');

		expect(docs).toContain('M7 does not mount `/doc` or `/reference`');
		expect(docs).toContain('No API explorer is mounted');
		expect(docs).not.toContain('Accessible at `/reference`');
		expect(docs).not.toContain('spec served automatically at /doc');
	});
});
