import {
	type AccessPrincipal,
	allowedSensitivityLevelsForMax,
	DATABASE_ERROR_CODES,
	DatabaseError,
	getQueryPool,
	loadConfig,
	type MulderConfig,
	MulderError,
	resolveAccessPolicy,
	type SensitivityLevel,
} from '@mulder/core';
import type pg from 'pg';
import type { AuthPrincipal } from '../middleware/auth.js';

interface ApiDataContext {
	config: MulderConfig;
	pool: pg.Pool;
}

let cachedContext: ApiDataContext | null = null;
let cachedConfigPath: string | null = null;

function resolveConfigPath(): string {
	return process.env.MULDER_CONFIG ?? 'mulder.config.yaml';
}

export function resolveApiDataContext(routeName: string): ApiDataContext {
	const configPath = resolveConfigPath();
	if (cachedContext && cachedConfigPath === configPath) {
		return cachedContext;
	}

	const config = loadConfig(configPath);
	if (!config.gcp?.cloud_sql) {
		throw new DatabaseError(
			`GCP cloud_sql configuration is required for ${routeName} routes`,
			DATABASE_ERROR_CODES.DB_CONNECTION_FAILED,
			{
				context: { configPath, routeName },
			},
		);
	}

	cachedContext = {
		config,
		pool: getQueryPool(config.gcp.cloud_sql),
	};
	cachedConfigPath = configPath;
	return cachedContext;
}

export function mapAuthPrincipal(principal: AuthPrincipal | undefined): AccessPrincipal {
	if (!principal) {
		return { kind: 'service' };
	}
	if (principal.type === 'api_key') {
		return { kind: 'api_key' };
	}
	return {
		kind: 'browser_session',
		browserRole: principal.role,
	};
}

export function resolveReadMaxSensitivity(
	config: MulderConfig,
	authPrincipal: AuthPrincipal | undefined,
	resourceName: string,
): SensitivityLevel | undefined {
	const policy = resolveAccessPolicy(config, mapAuthPrincipal(authPrincipal));
	if (!policy.permissions.includes('read') && !policy.permissions.includes('admin')) {
		throw new MulderError(`The current principal cannot read ${resourceName}`, 'AUTH_FORBIDDEN', {
			context: { principal_kind: policy.principalKind, resource: resourceName },
		});
	}
	return policy.enabled ? policy.maxSensitivityLevel : undefined;
}

export function allowedSensitivity(maxSensitivityLevel: SensitivityLevel | undefined): SensitivityLevel[] | undefined {
	return maxSensitivityLevel ? allowedSensitivityLevelsForMax(maxSensitivityLevel) : undefined;
}

export function actorIdForPrincipal(authPrincipal: AuthPrincipal | undefined): string {
	if (!authPrincipal) {
		return 'service';
	}
	if (authPrincipal.type === 'api_key') {
		return `api-key:${authPrincipal.keyName}`;
	}
	return authPrincipal.userId;
}

export function toIsoString(value: Date | null): string | null {
	return value ? value.toISOString() : null;
}
