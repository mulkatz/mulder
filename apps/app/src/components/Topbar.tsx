import { useQueryClient } from '@tanstack/react-query';
import { Bell, HelpCircle, LogOut, Menu, Plus, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { IconButton } from '@/components/IconButton';
import { LanguageSelect, ThemeToggle } from '@/components/PreferenceControls';
import { SearchInput } from '@/components/SearchInput';
import { useLogout } from '@/features/auth/useLogout';
import { useSession } from '@/features/auth/useSession';

export function Topbar({ onOpenSidebar }: { onOpenSidebar: () => void }) {
	const { t } = useTranslation();
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const sessionQuery = useSession();
	const logout = useLogout();
	const user = sessionQuery.data?.data.user;

	return (
		<header className="sticky top-0 z-30 flex h-[var(--topbar-height)] min-w-0 items-center gap-3 overflow-hidden border-b border-border bg-panel/95 px-3 backdrop-blur sm:px-4">
			<IconButton className="lg:hidden" label={t('navigation.openSidebar')} onClick={onOpenSidebar}>
				<Menu className="size-4" />
			</IconButton>

			<div className="hidden min-w-0 flex-1 items-center gap-3 md:flex">
				<SearchInput className="max-w-md" placeholder={t('topbar.searchPlaceholder')} />
				<button
					className="field hidden h-9 items-center gap-2 px-3 text-sm text-text-muted transition-colors hover:bg-field-hover lg:inline-flex"
					type="button"
				>
					<span className="font-mono text-xs">{t('common.commandShortcut')}</span>
					{t('common.command')}
				</button>
			</div>

			<div className="ml-auto flex items-center gap-2">
				<ThemeToggle className="hidden min-[560px]:inline-flex" />
				<LanguageSelect className="hidden min-[720px]:inline-flex" />
				<IconButton
					className="hidden sm:inline-flex"
					label={t('common.refresh')}
					onClick={() => queryClient.invalidateQueries()}
				>
					<RefreshCw className="size-4" />
				</IconButton>
				<IconButton className="hidden md:inline-flex" label={t('common.notifications')}>
					<Bell className="size-4" />
				</IconButton>
				<IconButton className="hidden sm:inline-flex" label={t('common.help')}>
					<HelpCircle className="size-4" />
				</IconButton>
				<button
					className="hidden h-9 items-center gap-2 rounded-md border border-border bg-panel px-3 text-sm text-text-subtle sm:inline-flex"
					disabled
					title={t('topbar.runCreationTitle')}
					type="button"
				>
					<Plus className="size-4 text-accent" />
					{t('common.addSources')}
				</button>
				<button
					className="hidden h-9 max-w-[220px] items-center gap-2 rounded-md border border-border bg-field px-2 text-sm text-text transition-colors hover:bg-field-hover min-[480px]:flex sm:px-3"
					disabled={logout.isPending}
					onClick={() => {
						logout.mutate(undefined, {
							onSettled: () => {
								navigate('/login', { replace: true });
							},
						});
					}}
					title={user ? t('topbar.signedInAs', { email: user.email }) : t('common.signOut')}
					type="button"
				>
					<span className="flex size-5 items-center justify-center rounded-sm bg-accent font-mono text-[11px] text-text-inverse">
						{user?.email.slice(0, 1).toUpperCase() ?? 'M'}
					</span>
					<span className="hidden truncate sm:inline">{user?.email ?? t('common.account')}</span>
					<LogOut className="size-3.5 text-text-subtle" />
				</button>
			</div>
		</header>
	);
}
