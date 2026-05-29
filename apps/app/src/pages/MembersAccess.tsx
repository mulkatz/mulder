import type { TFunction } from 'i18next';
import { Check, Copy, KeyRound, MailPlus, Users } from 'lucide-react';
import { type FormEvent, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type DataColumn, DataTable } from '@/components/DataTable';
import { InspectorPanel, InspectorSection } from '@/components/InspectorPanel';
import { PageHeader } from '@/components/PageHeader';
import { StateNotice } from '@/components/StateNotice';
import { Toolbar } from '@/components/Toolbar';
import { useCreateInvitation, useMembersAccess } from '@/features/auth/useMembersAccess';
import { useSession } from '@/features/auth/useSession';
import type { CreateInvitationResponse, MemberRecord, PendingInvitationRecord, UserRole } from '@/lib/api-types';
import { getErrorMessage, isApiUnavailableError } from '@/lib/query-state';

type InviteRole = Extract<UserRole, 'admin' | 'member'>;

function formatDateTime(value: string, locale: string) {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	return new Intl.DateTimeFormat(locale, {
		month: 'short',
		day: '2-digit',
		year: 'numeric',
		hour: '2-digit',
		minute: '2-digit',
	}).format(date);
}

function roleLabel(role: UserRole, t: TFunction) {
	return t(`membersAccess.roles.${role}`);
}

function RoleBadge({ role }: { role: UserRole }) {
	const { t } = useTranslation();
	return (
		<span className="inline-flex rounded-sm border border-border bg-field px-2 py-1 text-xs font-medium text-text-muted">
			{roleLabel(role, t)}
		</span>
	);
}

function getMemberColumns(t: TFunction, locale: string): DataColumn<MemberRecord>[] {
	return [
		{
			key: 'email',
			header: t('membersAccess.tableEmail'),
			render: (member) => <span className="font-medium text-text">{member.email}</span>,
		},
		{
			key: 'role',
			header: t('membersAccess.tableRole'),
			render: (member) => <RoleBadge role={member.role} />,
		},
		{
			key: 'created',
			header: t('membersAccess.tableJoined'),
			render: (member) => <span className="text-text-muted">{formatDateTime(member.created_at, locale)}</span>,
		},
	];
}

function getInvitationColumns(t: TFunction, locale: string): DataColumn<PendingInvitationRecord>[] {
	return [
		{
			key: 'email',
			header: t('membersAccess.tableEmail'),
			render: (invitation) => <span className="font-medium text-text">{invitation.email}</span>,
		},
		{
			key: 'role',
			header: t('membersAccess.tableRole'),
			render: (invitation) => <RoleBadge role={invitation.role} />,
		},
		{
			key: 'invitedBy',
			header: t('membersAccess.tableInvitedBy'),
			render: (invitation) => (
				<span className="text-text-muted">{invitation.invited_by?.email ?? t('membersAccess.invitedBySystem')}</span>
			),
		},
		{
			key: 'expires',
			header: t('membersAccess.tableExpires'),
			render: (invitation) => <span className="text-text-muted">{formatDateTime(invitation.expires_at, locale)}</span>,
		},
	];
}

function InviteSuccess({
	invitation,
	onCopy,
	copied,
}: {
	invitation: CreateInvitationResponse['data'];
	onCopy: () => void;
	copied: boolean;
}) {
	const { t } = useTranslation();
	return (
		<StateNotice title={t('membersAccess.inviteCreatedTitle')}>
			<div className="space-y-3">
				<p>
					{t('membersAccess.inviteCreatedBody', {
						email: invitation.email,
						status: t(`membersAccess.deliveryStatus.${invitation.delivery_status}`),
					})}
				</p>
				<div className="flex min-w-0 flex-col gap-2 sm:flex-row">
					<input
						className="field min-w-0 flex-1 px-3 py-2 font-mono text-xs text-text"
						readOnly
						value={invitation.invitation_url}
					/>
					<button
						className="inline-flex h-9 items-center justify-center gap-2 rounded-md border border-border bg-panel px-3 text-sm text-text transition-colors hover:bg-field"
						onClick={onCopy}
						type="button"
					>
						{copied ? <Check className="size-4" /> : <Copy className="size-4" />}
						{copied ? t('membersAccess.copied') : t('membersAccess.copyInviteLink')}
					</button>
				</div>
			</div>
		</StateNotice>
	);
}

export function MembersAccessPage() {
	const { t, i18n } = useTranslation();
	const sessionQuery = useSession();
	const membersQuery = useMembersAccess();
	const createInvitation = useCreateInvitation();
	const [email, setEmail] = useState('');
	const [role, setRole] = useState<InviteRole>('member');
	const [createdInvitation, setCreatedInvitation] = useState<CreateInvitationResponse['data'] | null>(null);
	const [copied, setCopied] = useState(false);
	const currentRole = sessionQuery.data?.data.user.role;
	const canInvite = currentRole === 'owner' || currentRole === 'admin';
	const memberColumns = useMemo(() => getMemberColumns(t, i18n.language), [i18n.language, t]);
	const invitationColumns = useMemo(() => getInvitationColumns(t, i18n.language), [i18n.language, t]);

	async function handleSubmit(event: FormEvent) {
		event.preventDefault();
		if (!canInvite || !email.trim()) return;
		setCopied(false);
		const response = await createInvitation.mutateAsync({ email: email.trim(), role });
		setCreatedInvitation(response.data);
		setEmail('');
		setRole('member');
	}

	async function handleCopyInviteLink() {
		if (!createdInvitation) return;
		await navigator.clipboard.writeText(createdInvitation.invitation_url);
		setCopied(true);
	}

	const members = membersQuery.data?.data.members ?? [];
	const invitations = membersQuery.data?.data.pending_invitations ?? [];

	return (
		<>
			<PageHeader
				description={t('membersAccess.description')}
				eyebrow={t('membersAccess.eyebrow')}
				title={t('membersAccess.title')}
			/>

			<div className="grid gap-4 p-4 sm:p-6 xl:grid-cols-[minmax(0,1fr)_380px]">
				<div className="space-y-4">
					<section className="panel overflow-hidden">
						<Toolbar>
							<div className="flex items-center gap-2">
								<Users className="size-4 text-accent" />
								<h2 className="font-medium text-text">{t('membersAccess.membersTitle')}</h2>
							</div>
							<span className="ml-auto font-mono text-xs text-text-subtle">
								{t('membersAccess.memberCount', { count: members.length })}
							</span>
						</Toolbar>
						{membersQuery.isLoading ? (
							<div className="border-b border-border p-3">
								<StateNotice tone="loading" title={t('membersAccess.loadingTitle')} />
							</div>
						) : null}
						{membersQuery.error ? (
							<div className="border-b border-border p-3">
								<StateNotice
									tone="error"
									title={
										isApiUnavailableError(membersQuery.error)
											? t('membersAccess.unavailableTitle')
											: t('membersAccess.errorTitle')
									}
								>
									{getErrorMessage(membersQuery.error, t('common.apiRequestFailed'))}
								</StateNotice>
							</div>
						) : null}
						<DataTable
							columns={memberColumns}
							emptyMessage={t('membersAccess.noMembers')}
							getRowKey={(member) => member.id}
							minWidth={640}
							rows={members}
						/>
					</section>

					<section className="panel overflow-hidden">
						<Toolbar>
							<div className="flex items-center gap-2">
								<MailPlus className="size-4 text-accent" />
								<h2 className="font-medium text-text">{t('membersAccess.pendingInvitesTitle')}</h2>
							</div>
						</Toolbar>
						<DataTable
							columns={invitationColumns}
							emptyMessage={t('membersAccess.noPendingInvites')}
							getRowKey={(invitation) => invitation.id}
							minWidth={760}
							rows={invitations}
						/>
					</section>
				</div>

				<aside className="space-y-4">
					<InspectorPanel title={t('membersAccess.invitePanelTitle')}>
						{canInvite ? (
							<form className="space-y-4" onSubmit={handleSubmit}>
								<label className="block text-sm">
									<span className="font-medium text-text">{t('membersAccess.inviteEmail')}</span>
									<input
										className="field mt-2 w-full px-3 py-2 text-sm text-text"
										onChange={(event) => setEmail(event.target.value)}
										placeholder={t('membersAccess.inviteEmailPlaceholder')}
										type="email"
										value={email}
									/>
								</label>
								<label className="block text-sm">
									<span className="font-medium text-text">{t('membersAccess.inviteRole')}</span>
									<select
										className="field mt-2 w-full px-3 py-2 text-sm text-text"
										onChange={(event) => setRole(event.target.value as InviteRole)}
										value={role}
									>
										<option value="member">{t('membersAccess.roles.member')}</option>
										<option value="admin">{t('membersAccess.roles.admin')}</option>
									</select>
								</label>
								<button
									className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-md bg-accent px-4 text-sm font-medium text-text-inverse transition-colors hover:bg-accent-hover disabled:bg-field disabled:text-text-faint"
									disabled={!email.trim() || createInvitation.isPending}
									type="submit"
								>
									<MailPlus className="size-4" />
									{createInvitation.isPending ? t('membersAccess.inviting') : t('membersAccess.sendInvite')}
								</button>
								{createInvitation.error ? (
									<StateNotice tone="error" title={t('membersAccess.inviteErrorTitle')}>
										{getErrorMessage(createInvitation.error, t('common.apiRequestFailed'))}
									</StateNotice>
								) : null}
								{createdInvitation ? (
									<InviteSuccess copied={copied} invitation={createdInvitation} onCopy={handleCopyInviteLink} />
								) : null}
							</form>
						) : (
							<StateNotice title={t('membersAccess.inviteRestrictedTitle')}>
								{t('membersAccess.inviteRestrictedBody')}
							</StateNotice>
						)}
					</InspectorPanel>

					<InspectorPanel title={t('membersAccess.roleGuideTitle')}>
						<InspectorSection title={t('membersAccess.roles.member')}>
							<p className="text-sm text-text-muted">{t('membersAccess.roleGuide.member')}</p>
						</InspectorSection>
						<InspectorSection title={t('membersAccess.roles.admin')}>
							<p className="text-sm text-text-muted">{t('membersAccess.roleGuide.admin')}</p>
						</InspectorSection>
						<InspectorSection title={t('membersAccess.roles.owner')}>
							<p className="text-sm text-text-muted">{t('membersAccess.roleGuide.owner')}</p>
						</InspectorSection>
						<div className="mt-4 flex items-start gap-2 rounded-md border border-border bg-field p-3 text-sm text-text-muted">
							<KeyRound className="mt-0.5 size-4 shrink-0 text-accent" />
							<p>{t('membersAccess.ownerInviteNote')}</p>
						</div>
					</InspectorPanel>
				</aside>
			</div>
		</>
	);
}
