import type { AccessPermission } from '../../shared/access-control.js';
import type { SensitivityLevel } from '../../shared/sensitivity.js';

export interface PersistedAccessRole {
	id: string;
	name: string;
	maxSensitivityLevel: SensitivityLevel;
	permissions: AccessPermission[];
	createdAt: Date;
	updatedAt: Date;
}

export interface UpsertAccessRoleInput {
	id: string;
	name: string;
	maxSensitivityLevel: SensitivityLevel;
	permissions: AccessPermission[];
}
