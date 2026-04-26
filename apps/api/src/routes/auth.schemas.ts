import { z } from 'zod';

export const BrowserUserRoleSchema = z.enum(['owner', 'admin', 'member']);

export const AuthUserSchema = z.object({
	id: z.string().uuid(),
	email: z.string().email(),
	role: BrowserUserRoleSchema,
});

export const AuthSessionResponseSchema = z.object({
	data: z.object({
		user: AuthUserSchema,
		expires_at: z.string(),
	}),
});

export const LoginRequestSchema = z.object({
	email: z.string().email(),
	password: z.string().min(1),
});

export const AcceptInvitationRequestSchema = z.object({
	token: z.string().min(1),
	password: z.string().min(12),
});

export const CreateInvitationRequestSchema = z.object({
	email: z.string().email(),
	role: BrowserUserRoleSchema.optional().default('member'),
});

export const CreateInvitationResponseSchema = z.object({
	data: z.object({
		id: z.string().uuid(),
		email: z.string().email(),
		role: BrowserUserRoleSchema,
		expires_at: z.string(),
	}),
});

export type LoginRequest = z.infer<typeof LoginRequestSchema>;
export type AcceptInvitationRequest = z.infer<typeof AcceptInvitationRequestSchema>;
export type CreateInvitationRequest = z.infer<typeof CreateInvitationRequestSchema>;
