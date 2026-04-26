import { MulderError, type ApiConfig } from '@mulder/core';
import type { Context, Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import {
	acceptInvitation,
	createInvitation,
	getBrowserAuthCookieSettings,
	loginWithPassword,
	logoutSession,
	validateSessionToken,
} from '../lib/auth.js';
import type { AuthPrincipal } from '../middleware/auth.js';
import {
	AcceptInvitationRequestSchema,
	AuthSessionResponseSchema,
	CreateInvitationRequestSchema,
	CreateInvitationResponseSchema,
	LoginRequestSchema,
} from './auth.schemas.js';

async function readJsonBody(c: Context): Promise<unknown> {
	try {
		return await c.req.json();
	} catch {
		throw new MulderError('Invalid request', 'VALIDATION_ERROR');
	}
}

function setSessionCookie(c: Context, token: string, apiConfig: ApiConfig): void {
	const cookie = getBrowserAuthCookieSettings(apiConfig);
	setCookie(c, cookie.name, token, {
		httpOnly: true,
		secure: cookie.secure,
		sameSite: cookie.sameSite,
		path: '/',
		maxAge: cookie.maxAgeSeconds,
	});
}

function clearSessionCookie(c: Context, apiConfig: ApiConfig): void {
	const cookie = getBrowserAuthCookieSettings(apiConfig);
	deleteCookie(c, cookie.name, {
		path: '/',
		secure: cookie.secure,
		sameSite: cookie.sameSite,
	});
}

function sessionResponse(session: Awaited<ReturnType<typeof validateSessionToken>>) {
	if (!session) {
		throw new MulderError('A valid browser session is required', 'AUTH_UNAUTHORIZED');
	}

	return {
		data: {
			user: session.user,
			expires_at: session.expiresAt.toISOString(),
		},
	};
}

function requireInviteCreator(c: Context): AuthPrincipal {
	const principal = c.get('authPrincipal');
	if (!principal) {
		throw new MulderError('A valid API key or admin session is required', 'AUTH_UNAUTHORIZED');
	}

	if (principal.type === 'api_key') {
		return principal;
	}

	if (principal.role === 'owner' || principal.role === 'admin') {
		return principal;
	}

	throw new MulderError('Only owners and admins can create invitations', 'AUTH_FORBIDDEN');
}

export function registerAuthRoutes(app: Hono, apiConfig: ApiConfig): void {
	app.post('/api/auth/login', async (c) => {
		const body = LoginRequestSchema.parse(await readJsonBody(c));
		const { token, session } = await loginWithPassword(body.email, body.password, apiConfig);
		setSessionCookie(c, token, apiConfig);
		const response = sessionResponse(session);
		AuthSessionResponseSchema.parse(response);
		return c.json(response, 200);
	});

	app.post('/api/auth/logout', async (c) => {
		const cookie = getBrowserAuthCookieSettings(apiConfig);
		const token = getCookie(c, cookie.name);
		if (token) {
			await logoutSession(token, apiConfig);
		}
		clearSessionCookie(c, apiConfig);
		return c.body(null, 204);
	});

	app.get('/api/auth/session', async (c) => {
		const cookie = getBrowserAuthCookieSettings(apiConfig);
		const token = getCookie(c, cookie.name);
		const response = sessionResponse(token ? await validateSessionToken(token, apiConfig) : null);
		AuthSessionResponseSchema.parse(response);
		return c.json(response, 200);
	});

	app.post('/api/auth/invitations/accept', async (c) => {
		const body = AcceptInvitationRequestSchema.parse(await readJsonBody(c));
		const { token, session } = await acceptInvitation(body.token, body.password, apiConfig);
		setSessionCookie(c, token, apiConfig);
		const response = sessionResponse(session);
		AuthSessionResponseSchema.parse(response);
		return c.json(response, 200);
	});

	app.post('/api/auth/invitations', async (c) => {
		const principal = requireInviteCreator(c);
		const body = CreateInvitationRequestSchema.parse(await readJsonBody(c));
		const invitation = await createInvitation({
			email: body.email,
			role: body.role,
			invitedByUserId: principal.type === 'session' ? principal.userId : null,
			apiConfig,
		});
		const response = {
			data: {
				id: invitation.id,
				email: invitation.email,
				role: invitation.role,
				expires_at: invitation.expiresAt.toISOString(),
			},
		};
		CreateInvitationResponseSchema.parse(response);
		return c.json(response, 201);
	});
}
