import { Plus } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useSession } from '@/features/auth/useSession';
import type { UserRole } from '@/lib/api-types';
import { cn } from '@/lib/cn';

const uploadRoles = new Set<UserRole>(['owner', 'admin']);

const disabledUploadClassName =
	'inline-flex h-9 items-center gap-2 rounded-md border border-border bg-field px-3 text-sm font-medium text-text-subtle opacity-70';

export function canUploadSources(role: UserRole | undefined): boolean {
	return role ? uploadRoles.has(role) : false;
}

export function AddSourcesButton({
	children,
	className,
	disabledClassName,
	iconClassName,
	title,
}: {
	children: ReactNode;
	className?: string;
	disabledClassName?: string;
	iconClassName?: string;
	title?: string;
}) {
	const { t } = useTranslation();
	const sessionQuery = useSession();
	const canUpload = canUploadSources(sessionQuery.data?.data.user.role);

	if (!canUpload) {
		return (
			<span className="inline-flex" title={t('common.uploadUnavailableForRole')}>
				<button
					className={cn(disabledClassName ?? disabledUploadClassName, 'cursor-not-allowed')}
					disabled
					type="button"
				>
					<Plus className={cn('size-4 text-text-subtle', iconClassName)} />
					{children}
				</button>
			</span>
		);
	}

	return (
		<Link className={className} title={title} to="/sources/add">
			<Plus className={cn('size-4', iconClassName)} />
			{children}
		</Link>
	);
}
