import type { AccessControlConfig, MulderConfig } from '../config/types.js';
import { SENSITIVITY_LEVELS, type SensitivityLevel } from './sensitivity.js';

export const ACCESS_PERMISSIONS = [
	'read',
	'write',
	'review',
	'classify',
	'delete',
	'admin',
	'export',
	'agent_config',
] as const;

export type AccessPermission = (typeof ACCESS_PERMISSIONS)[number];

export type AccessPrincipalKind = 'browser_session' | 'api_key' | 'service' | 'anonymous';

export type BrowserAccessRole = 'member' | 'admin' | 'owner';

export interface AccessRole {
	id: string;
	name: string;
	maxSensitivityLevel: SensitivityLevel;
	permissions: AccessPermission[];
}

export interface AccessRoleConfig {
	id: string;
	name: string;
	max_sensitivity_level: SensitivityLevel;
	permissions: AccessPermission[];
}

export interface AccessPolicy extends AccessRole {
	enabled: boolean;
	principalKind: AccessPrincipalKind;
	allowedSensitivityLevels: SensitivityLevel[];
}

export interface AccessPrincipal {
	kind: AccessPrincipalKind;
	roleId?: string | null;
	browserRole?: string | null;
}

export const DEFAULT_ACCESS_ROLE_CONFIGS: AccessRoleConfig[] = [
	{
		id: 'analyst',
		name: 'Analyst',
		max_sensitivity_level: 'internal',
		permissions: ['read'],
	},
	{
		id: 'reviewer',
		name: 'Reviewer',
		max_sensitivity_level: 'restricted',
		permissions: ['read', 'review', 'classify'],
	},
	{
		id: 'admin',
		name: 'Administrator',
		max_sensitivity_level: 'confidential',
		permissions: [...ACCESS_PERMISSIONS],
	},
];

export const DEFAULT_ACCESS_ROLES: AccessRole[] = DEFAULT_ACCESS_ROLE_CONFIGS.map((role) => ({
	id: role.id,
	name: role.name,
	maxSensitivityLevel: role.max_sensitivity_level,
	permissions: [...role.permissions],
}));

const DISABLED_ACCESS_ROLE: AccessRole = {
	id: 'access-control-disabled',
	name: 'Access control disabled',
	maxSensitivityLevel: 'confidential',
	permissions: [...ACCESS_PERMISSIONS],
};

const DENIED_ACCESS_ROLE: AccessRole = {
	id: 'unresolved',
	name: 'Unresolved access role',
	maxSensitivityLevel: 'public',
	permissions: [],
};

function isAccessControlConfig(config: AccessControlConfig | MulderConfig): config is AccessControlConfig {
	return 'enabled' in config && 'rbac' in config;
}

function readAccessControlConfig(config: AccessControlConfig | MulderConfig): AccessControlConfig {
	return isAccessControlConfig(config) ? config : config.access_control;
}

function normalizeRoleConfig(role: AccessRoleConfig): AccessRole {
	return {
		id: role.id,
		name: role.name,
		maxSensitivityLevel: role.max_sensitivity_level,
		permissions: [...role.permissions],
	};
}

function resolveRole(config: AccessControlConfig, roleId: string): AccessRole | null {
	const roles = config.rbac.roles.map(normalizeRoleConfig);
	return roles.find((role) => role.id === roleId) ?? null;
}

export function allowedSensitivityLevelsForMax(maxSensitivityLevel: SensitivityLevel): SensitivityLevel[] {
	const maxIndex = SENSITIVITY_LEVELS.indexOf(maxSensitivityLevel);
	return SENSITIVITY_LEVELS.slice(0, maxIndex + 1);
}

export function canReadSensitivityLevel(policy: AccessPolicy, sensitivityLevel: SensitivityLevel): boolean {
	return hasAccessPermission(policy, 'read') && policy.allowedSensitivityLevels.includes(sensitivityLevel);
}

export function hasAccessPermission(policy: AccessPolicy, permission: AccessPermission): boolean {
	return policy.permissions.includes(permission) || policy.permissions.includes('admin');
}

export function mapBrowserRoleToAccessRoleId(browserRole: string | null | undefined): string | null {
	if (browserRole === 'member') return 'analyst';
	if (browserRole === 'admin' || browserRole === 'owner') return 'admin';
	return null;
}

export function accessRoleConfigToRole(role: AccessRoleConfig): AccessRole {
	return normalizeRoleConfig(role);
}

export function accessRoleToConfig(role: AccessRole): AccessRoleConfig {
	return {
		id: role.id,
		name: role.name,
		max_sensitivity_level: role.maxSensitivityLevel,
		permissions: [...role.permissions],
	};
}

export function resolveAccessPolicy(
	config: AccessControlConfig | MulderConfig,
	principal: AccessPrincipal,
): AccessPolicy {
	const accessControl = readAccessControlConfig(config);

	if (!accessControl.enabled) {
		return {
			...DISABLED_ACCESS_ROLE,
			enabled: false,
			principalKind: principal.kind,
			allowedSensitivityLevels: allowedSensitivityLevelsForMax(DISABLED_ACCESS_ROLE.maxSensitivityLevel),
		};
	}

	const roleId =
		principal.kind === 'api_key' || principal.kind === 'service'
			? 'admin'
			: (principal.roleId ?? mapBrowserRoleToAccessRoleId(principal.browserRole) ?? accessControl.rbac.default_role);
	const role = resolveRole(accessControl, roleId);

	if (!role) {
		return {
			...DENIED_ACCESS_ROLE,
			enabled: true,
			principalKind: principal.kind,
			allowedSensitivityLevels: [],
		};
	}

	return {
		...role,
		enabled: true,
		principalKind: principal.kind,
		allowedSensitivityLevels: allowedSensitivityLevelsForMax(role.maxSensitivityLevel),
	};
}
