import { loadConfig } from '@mulder/core';
import type { RuntimeConfigResponse } from '../routes/runtime-config.schemas.js';

function resolveConfigPath(): string {
	return process.env.MULDER_CONFIG ?? 'mulder.config.yaml';
}

export function getRuntimeConfig(): RuntimeConfigResponse {
	const config = loadConfig(resolveConfigPath());
	return {
		data: {
			translation: {
				enabled: config.translation.enabled,
				default_target_language: config.translation.default_target_language,
				supported_languages: config.translation.supported_languages,
			},
		},
	};
}
