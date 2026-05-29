import { type ApiConfig, MulderError } from '@mulder/core';
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import {
	acceptInvitation,
	createInvitation,
	getBrowserAuthCookieSettings,
	listMembersAccess,
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
	MembersAccessResponseSchema,
} from './auth.schemas.js';
import {
	type ApiApp,
	AUTH_SECURITY,
	COMMON_ERROR_RESPONSES,
	emptyResponse,
	jsonRequestBody,
	jsonResponse,
	registerOpenApiRoute,
} from './openapi.js';

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

export function registerAuthRoutes(app: ApiApp, apiConfig: ApiConfig): void {
	registerOpenApiRoute(
		app,
		{
			method: 'post',
			path: '/api/auth/login',
			operationId: 'login',
			tags: ['Auth'],
			request: {
				body: jsonRequestBody(LoginRequestSchema, 'Login request'),
			},
			responses: {
				200: jsonResponse(AuthSessionResponseSchema, 'Authenticated session'),
				...COMMON_ERROR_RESPONSES,
			},
		},
		async (c) => {
			const body = LoginRequestSchema.parse(await readJsonBody(c));
			const { token, session } = await loginWithPassword(body.email, body.password, apiConfig);
			setSessionCookie(c, token, apiConfig);
			const response = sessionResponse(session);
			AuthSessionResponseSchema.parse(response);
			return c.json(response, 200);
		},
	);

	registerOpenApiRoute(
		app,
		{
			method: 'post',
			path: '/api/auth/logout',
			operationId: 'logout',
			tags: ['Auth'],
			responses: {
				204: emptyResponse('Session cleared'),
				...COMMON_ERROR_RESPONSES,
			},
		},
		async (c) => {
			const cookie = getBrowserAuthCookieSettings(apiConfig);
			const token = getCookie(c, cookie.name);
			if (token) {
				await logoutSession(token, apiConfig);
			}
			clearSessionCookie(c, apiConfig);
			return c.body(null, 204);
		},
	);

	registerOpenApiRoute(
		app,
		{
			method: 'get',
			path: '/api/auth/session',
			operationId: 'getSession',
			tags: ['Auth'],
			responses: {
				200: jsonResponse(AuthSessionResponseSchema, 'Current browser session'),
				...COMMON_ERROR_RESPONSES,
			},
		},
		async (c) => {
			const cookie = getBrowserAuthCookieSettings(apiConfig);
			const token = getCookie(c, cookie.name);
			const response = sessionResponse(token ? await validateSessionToken(token, apiConfig) : null);
			AuthSessionResponseSchema.parse(response);
			return c.json(response, 200);
		},
	);

	registerOpenApiRoute(
		app,
		{
			method: 'post',
			path: '/api/auth/invitations/accept',
			operationId: 'acceptInvitation',
			tags: ['Auth'],
			request: {
				body: jsonRequestBody(AcceptInvitationRequestSchema, 'Invitation acceptance request'),
			},
			responses: {
				200: jsonResponse(AuthSessionResponseSchema, 'Authenticated session'),
				...COMMON_ERROR_RESPONSES,
			},
		},
		async (c) => {
			const body = AcceptInvitationRequestSchema.parse(await readJsonBody(c));
			const { token, session } = await acceptInvitation(body.token, body.password, apiConfig);
			setSessionCookie(c, token, apiConfig);
			const response = sessionResponse(session);
			AuthSessionResponseSchema.parse(response);
			return c.json(response, 200);
		},
	);

	registerOpenApiRoute(
		app,
		{
			method: 'post',
			path: '/api/auth/invitations',
			operationId: 'createInvitation',
			tags: ['Auth'],
			security: AUTH_SECURITY,
			request: {
				body: jsonRequestBody(CreateInvitationRequestSchema, 'Invitation creation request'),
			},
			responses: {
				201: jsonResponse(CreateInvitationResponseSchema, 'Created invitation'),
				...COMMON_ERROR_RESPONSES,
			},
		},
		async (c) => {
			const principal = requireInviteCreator(c);
			const body = CreateInvitationRequestSchema.parse(await readJsonBody(c));
			const invitation = await createInvitation({
				email: body.email,
				role: body.role,
				invitedByUserId: principal.type === 'session' ? principal.userId : null,
				apiConfig,
				logger: c.get('requestContext')?.logger,
			});
			const response = {
				data: {
					id: invitation.id,
					email: invitation.email,
					role: invitation.role,
					expires_at: invitation.expiresAt.toISOString(),
					invitation_url: invitation.invitationUrl,
					delivery_provider: invitation.deliveryProvider,
					delivery_status: invitation.deliveryStatus,
				},
			};
			CreateInvitationResponseSchema.parse(response);
			return c.json(response, 201);
		},
	);

	registerOpenApiRoute(
		app,
		{
			method: 'get',
			path: '/api/auth/members-access',
			operationId: 'getMembersAccess',
			tags: ['Auth'],
			security: AUTH_SECURITY,
			responses: {
				200: jsonResponse(MembersAccessResponseSchema, 'Members and invitations'),
				...COMMON_ERROR_RESPONSES,
			},
		},
		async (c) => {
			const data = await listMembersAccess();
			const response = {
				data: {
					members: data.members.map((member) => ({
						id: member.id,
						email: member.email,
						role: member.role,
						created_at: member.createdAt.toISOString(),
						updated_at: member.updatedAt.toISOString(),
					})),
					pending_invitations: data.pendingInvitations.map((invitation) => ({
						id: invitation.id,
						email: invitation.email,
						role: invitation.role,
						invited_by: invitation.invitedBy,
						expires_at: invitation.expiresAt.toISOString(),
						created_at: invitation.createdAt.toISOString(),
					})),
				},
			};
			MembersAccessResponseSchema.parse(response);
			return c.json(response, 200);
		},
	);
}
