import { describe, expect, it, vi } from 'vitest';

vi.mock('@mulder/core', () => ({
	loadConfig: vi.fn(() => ({
		translation: {
			default_target_language: 'de',
			enabled: true,
			supported_languages: ['de', 'fr'],
		},
	})),
}));

describe('runtime config facade', () => {
	it('exposes only safe translation UI settings', async () => {
		const { getRuntimeConfig } = await import('./runtime-config.js');

		expect(getRuntimeConfig()).toEqual({
			data: {
				translation: {
					default_target_language: 'de',
					enabled: true,
					supported_languages: ['de', 'fr'],
				},
			},
		});
	});
});
