import {
	type AccessPermission,
	type AccessPrincipal,
	allowedSensitivityLevelsForMax,
	DATABASE_ERROR_CODES,
	DatabaseError,
	getQueryPool,
	hasAccessPermission,
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
	return resolvePermissionMaxSensitivity(config, authPrincipal, resourceName, 'read');
}

export function resolvePermissionMaxSensitivity(
	config: MulderConfig,
	authPrincipal: AuthPrincipal | undefined,
	resourceName: string,
	permission: AccessPermission,
): SensitivityLevel | undefined {
	const policy = resolveAccessPolicy(config, mapAuthPrincipal(authPrincipal));
	if (!hasAccessPermission(policy, permission)) {
		throw new MulderError(`The current principal cannot ${permission} ${resourceName}`, 'AUTH_FORBIDDEN', {
			context: { permission, principal_kind: policy.principalKind, resource: resourceName },
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

export function isOperatorPrincipal(authPrincipal: AuthPrincipal | undefined): boolean {
	if (!authPrincipal || authPrincipal.type === 'api_key') {
		return true;
	}
	return authPrincipal.role === 'admin' || authPrincipal.role === 'owner';
}

export function assertOperatorPrincipal(authPrincipal: AuthPrincipal | undefined, resourceName: string): void {
	if (isOperatorPrincipal(authPrincipal)) {
		return;
	}
	throw new MulderError(`The current principal cannot inspect ${resourceName}`, 'AUTH_FORBIDDEN', {
		context: { resource: resourceName, required_role: 'admin' },
	});
}

export function toIsoString(value: Date | null): string | null {
	return value ? value.toISOString() : null;
}
