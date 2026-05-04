import { Languages, Monitor, Moon, Sun } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { type ThemePreference, usePreferences } from '@/app/preferences';
import { cn } from '@/lib/cn';

const themeOrder: ThemePreference[] = ['system', 'light', 'dark'];

function nextTheme(theme: ThemePreference) {
	const index = themeOrder.indexOf(theme);
	return themeOrder[(index + 1) % themeOrder.length];
}

function ThemeIcon({ theme }: { theme: ThemePreference }) {
	if (theme === 'light') return <Sun className="size-4" />;
	if (theme === 'dark') return <Moon className="size-4" />;
	return <Monitor className="size-4" />;
}

export function LanguageSelect({ className }: { className?: string }) {
	const { locale, setLocale } = usePreferences();
	const { t } = useTranslation();

	return (
		<label className={cn('field inline-flex h-9 items-center gap-2 px-2 text-sm text-text-muted', className)}>
			<Languages className="size-4 text-text-subtle" />
			<span className="sr-only">{t('common.language')}</span>
			<select
				aria-label={t('common.language')}
				className="bg-transparent text-sm text-text outline-none"
				onChange={(event) => setLocale(event.target.value === 'de' ? 'de' : 'en')}
				value={locale}
			>
				<option value="en">{t('common.english')}</option>
				<option value="de">{t('common.german')}</option>
			</select>
		</label>
	);
}

export function ThemeToggle({ className }: { className?: string }) {
	const { setTheme, theme } = usePreferences();
	const { t } = useTranslation();
	const label =
		theme === 'light' ? t('common.themeLight') : theme === 'dark' ? t('common.themeDark') : t('common.themeSystem');

	return (
		<button
			aria-label={`${t('common.theme')}: ${label}`}
			className={cn(
				'field inline-flex h-9 items-center gap-2 px-2 text-sm text-text-muted transition-colors hover:bg-field-hover',
				className,
			)}
			onClick={() => setTheme(nextTheme(theme))}
			title={`${t('common.theme')}: ${label}`}
			type="button"
		>
			<ThemeIcon theme={theme} />
			<span className="hidden sm:inline">{label}</span>
		</button>
	);
}
