import type pg from 'pg';
import { ACCESS_PERMISSIONS, type AccessPermission } from '../../shared/access-control.js';
import { DATABASE_ERROR_CODES, DatabaseError } from '../../shared/errors.js';
import { isSensitivityLevel } from '../../shared/sensitivity.js';
import type { PersistedAccessRole, UpsertAccessRoleInput } from './access-role.types.js';

type Queryable = pg.Pool | pg.PoolClient;

interface AccessRoleRow {
	id: string;
	name: string;
	max_sensitivity_level: PersistedAccessRole['maxSensitivityLevel'];
	permissions: string[] | null;
	created_at: Date;
	updated_at: Date;
}

function isAccessPermission(value: string): value is AccessPermission {
	return ACCESS_PERMISSIONS.some((permission) => permission === value);
}

function normalizePermissions(permissions: readonly string[] | null): AccessPermission[] {
	return [...new Set(permissions ?? [])].filter(isAccessPermission).sort((left, right) => left.localeCompare(right));
}

function mapAccessRoleRow(row: AccessRoleRow): PersistedAccessRole {
	return {
		id: row.id,
		name: row.name,
		maxSensitivityLevel: isSensitivityLevel(row.max_sensitivity_level) ? row.max_sensitivity_level : 'internal',
		permissions: normalizePermissions(row.permissions),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

export async function listAccessRoles(pool: Queryable): Promise<PersistedAccessRole[]> {
	try {
		const result = await pool.query<AccessRoleRow>(
			`
				SELECT *
				FROM access_roles
				ORDER BY id ASC
			`,
		);
		return result.rows.map(mapAccessRoleRow);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to list access roles', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
		});
	}
}

export async function findAccessRoleById(pool: Queryable, id: string): Promise<PersistedAccessRole | null> {
	try {
		const result = await pool.query<AccessRoleRow>('SELECT * FROM access_roles WHERE id = $1', [id]);
		const row = result.rows[0];
		return row ? mapAccessRoleRow(row) : null;
	} catch (error: unknown) {
		throw new DatabaseError('Failed to find access role by ID', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { id },
		});
	}
}

export async function upsertAccessRole(pool: Queryable, input: UpsertAccessRoleInput): Promise<PersistedAccessRole> {
	try {
		const result = await pool.query<AccessRoleRow>(
			`
				INSERT INTO access_roles (id, name, max_sensitivity_level, permissions)
				VALUES ($1, $2, $3, $4)
				ON CONFLICT (id) DO UPDATE SET
					name = EXCLUDED.name,
					max_sensitivity_level = EXCLUDED.max_sensitivity_level,
					permissions = EXCLUDED.permissions,
					updated_at = now()
				RETURNING *
			`,
			[input.id, input.name, input.maxSensitivityLevel, normalizePermissions(input.permissions)],
		);
		return mapAccessRoleRow(result.rows[0]);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to upsert access role', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { id: input.id },
		});
	}
}
