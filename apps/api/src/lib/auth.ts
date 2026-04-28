import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import {
	type ApiConfig,
	getWorkerPool,
	loadConfig,
	MulderError,
	PIPELINE_ERROR_CODES,
	PipelineError,
} from '@mulder/core';
import type pg from 'pg';

function scryptAsync(password: string, salt: string, keylen: number): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		scryptCallback(password, salt, keylen, (error, derivedKey) => {
			if (error) {
				reject(error);
				return;
			}
			resolve(derivedKey);
		});
	});
}

export type BrowserUserRole = 'owner' | 'admin' | 'member';

export interface BrowserAuthUser {
	id: string;
	email: string;
	role: BrowserUserRole;
}

export interface BrowserAuthSession {
	user: BrowserAuthUser;
	expiresAt: Date;
}

export interface BrowserAuthCookieSettings {
	name: string;
	maxAgeSeconds: number;
	secure: boolean;
	sameSite: 'Strict' | 'Lax' | 'None';
}

interface UserRow {
	id: string;
	email: string;
	role: BrowserUserRole;
	password_hash: string;
}

interface SessionRow {
	user_id: string;
	email: string;
	role: BrowserUserRole;
	expires_at: Date;
}

interface InvitationRow {
	id: string;
	email: string;
	role: BrowserUserRole;
}

type Queryable = pg.Pool | pg.PoolClient;

function getPool(): pg.Pool {
	const config = loadConfig();
	if (!config.gcp?.cloud_sql) {
		throw new PipelineError(
			'GCP cloud_sql configuration is required for browser auth routes',
			PIPELINE_ERROR_CODES.PIPELINE_WRONG_STATUS,
			{
				context: { configPath: process.env.MULDER_CONFIG ?? 'mulder.config.yaml' },
			},
		);
	}
	return getWorkerPool(config.gcp.cloud_sql);
}

function getBrowserConfig(apiConfig?: ApiConfig): ApiConfig['auth']['browser'] {
	return apiConfig?.auth.browser ?? loadConfig().api.auth.browser;
}

function normalizeEmail(email: string): string {
	return email.trim().toLowerCase();
}

function tokenHash(token: string, apiConfig?: ApiConfig): string {
	const secret = getBrowserConfig(apiConfig).session_secret;
	return createHash('sha256').update(`${secret}:${token}`).digest('hex');
}

async function hashPassword(password: string): Promise<string> {
	const salt = randomBytes(16).toString('base64url');
	const derived = await scryptAsync(password, salt, 64);
	return `scrypt:${salt}:${derived.toString('base64url')}`;
}

async function verifyPassword(password: string, passwordHash: string): Promise<boolean> {
	const [scheme, salt, expectedHash] = passwordHash.split(':');
	if (scheme !== 'scrypt' || !salt || !expectedHash) {
		return false;
	}

	const expected = Buffer.from(expectedHash, 'base64url');
	const actual = await scryptAsync(password, salt, expected.length);
	return expected.length === actual.length && timingSafeEqual(expected, actual);
}

async function runInTransaction<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
	const client = await pool.connect();
	try {
		await client.query('BEGIN');
		const result = await fn(client);
		await client.query('COMMIT');
		return result;
	} catch (error) {
		try {
			await client.query('ROLLBACK');
		} catch {
			// Keep the original error visible.
		}
		throw error;
	} finally {
		client.release();
	}
}

function mapSession(row: SessionRow): BrowserAuthSession {
	return {
		user: {
			id: row.user_id,
			email: row.email,
			role: row.role,
		},
		expiresAt: row.expires_at,
	};
}

async function findUserByEmail(pool: Queryable, email: string): Promise<UserRow | null> {
	const result = await pool.query<UserRow>(
		`
			SELECT id, email, role, password_hash
			FROM api_users
			WHERE lower(email) = lower($1)
				AND disabled_at IS NULL
			LIMIT 1
		`,
		[normalizeEmail(email)],
	);
	return result.rows[0] ?? null;
}

async function createSessionForUser(
	pool: Queryable,
	user: BrowserAuthUser,
	apiConfig?: ApiConfig,
): Promise<{ token: string; session: BrowserAuthSession }> {
	const browser = getBrowserConfig(apiConfig);
	const token = randomBytes(32).toString('base64url');
	const expiresAt = new Date(Date.now() + browser.session_ttl_hours * 60 * 60 * 1000);
	await pool.query(
		`
			INSERT INTO api_sessions (user_id, token_hash, expires_at)
			VALUES ($1, $2, $3)
		`,
		[user.id, tokenHash(token, apiConfig), expiresAt],
	);
	return {
		token,
		session: {
			user,
			expiresAt,
		},
	};
}

export function getBrowserAuthCookieSettings(apiConfig?: ApiConfig): BrowserAuthCookieSettings {
	const browser = getBrowserConfig(apiConfig);
	return {
		name: browser.cookie_name,
		maxAgeSeconds: browser.session_ttl_hours * 60 * 60,
		secure: browser.cookie_secure,
		sameSite: browser.same_site,
	};
}

export async function validateSessionToken(token: string, apiConfig?: ApiConfig): Promise<BrowserAuthSession | null> {
	if (!getBrowserConfig(apiConfig).enabled) {
		return null;
	}

	const pool = getPool();
	const result = await pool.query<SessionRow>(
		`
			SELECT
				s.user_id,
				u.email,
				u.role,
				s.expires_at
			FROM api_sessions s
			JOIN api_users u ON u.id = s.user_id
			WHERE s.token_hash = $1
				AND s.revoked_at IS NULL
				AND s.expires_at > now()
				AND u.disabled_at IS NULL
			LIMIT 1
		`,
		[tokenHash(token, apiConfig)],
	);

	return result.rows[0] ? mapSession(result.rows[0]) : null;
}

export async function loginWithPassword(
	email: string,
	password: string,
	apiConfig?: ApiConfig,
): Promise<{ token: string; session: BrowserAuthSession }> {
	const pool = getPool();
	const user = await findUserByEmail(pool, email);
	if (!user || !(await verifyPassword(password, user.password_hash))) {
		throw new MulderError('Invalid email or password', 'AUTH_UNAUTHORIZED');
	}

	return await createSessionForUser(
		pool,
		{
			id: user.id,
			email: user.email,
			role: user.role,
		},
		apiConfig,
	);
}

export async function logoutSession(token: string, apiConfig?: ApiConfig): Promise<void> {
	const pool = getPool();
	await pool.query(
		`
			UPDATE api_sessions
			SET revoked_at = now()
			WHERE token_hash = $1
				AND revoked_at IS NULL
		`,
		[tokenHash(token, apiConfig)],
	);
}

export async function createInvitation(input: {
	email: string;
	role: BrowserUserRole;
	invitedByUserId?: string | null;
	apiConfig?: ApiConfig;
}): Promise<{ id: string; email: string; role: BrowserUserRole; expiresAt: Date }> {
	const browser = getBrowserConfig(input.apiConfig);
	const pool = getPool();
	const token = randomBytes(32).toString('base64url');
	const expiresAt = new Date(Date.now() + browser.invitation_ttl_hours * 60 * 60 * 1000);
	const result = await pool.query<InvitationRow & { expires_at: Date }>(
		`
			INSERT INTO api_invitations (email, role, token_hash, invited_by, expires_at)
			VALUES ($1, $2, $3, $4, $5)
			RETURNING id, email, role, expires_at
		`,
		[
			normalizeEmail(input.email),
			input.role,
			tokenHash(token, input.apiConfig),
			input.invitedByUserId ?? null,
			expiresAt,
		],
	);

	const row = result.rows[0];
	return {
		id: row.id,
		email: row.email,
		role: row.role,
		expiresAt: row.expires_at,
	};
}

export async function acceptInvitation(
	token: string,
	password: string,
	apiConfig?: ApiConfig,
): Promise<{ token: string; session: BrowserAuthSession }> {
	const pool = getPool();
	return await runInTransaction(pool, async (client) => {
		const invitationResult = await client.query<InvitationRow>(
			`
				SELECT id, email, role
				FROM api_invitations
				WHERE token_hash = $1
					AND accepted_at IS NULL
					AND expires_at > now()
				FOR UPDATE
				LIMIT 1
			`,
			[tokenHash(token, apiConfig)],
		);
		const invitation = invitationResult.rows[0];
		if (!invitation) {
			throw new MulderError('Invitation is invalid or expired', 'AUTH_UNAUTHORIZED');
		}

		const existingUser = await findUserByEmail(client, invitation.email);
		if (existingUser) {
			throw new MulderError('A user already exists for this invitation email', 'AUTH_CONFLICT');
		}

		const passwordHash = await hashPassword(password);
		const userResult = await client.query<UserRow>(
			`
				INSERT INTO api_users (email, password_hash, role)
				VALUES ($1, $2, $3)
				RETURNING id, email, role, password_hash
			`,
			[invitation.email, passwordHash, invitation.role],
		);
		await client.query('UPDATE api_invitations SET accepted_at = now() WHERE id = $1', [invitation.id]);

		const user = userResult.rows[0];
		return await createSessionForUser(
			client,
			{
				id: user.id,
				email: user.email,
				role: user.role,
			},
			apiConfig,
		);
	});
}
