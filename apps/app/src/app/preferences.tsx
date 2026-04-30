import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from 'react';
import { i18n } from '@/i18n';
import { type AppLocale, defaultLocale, locales } from '@/i18n/resources';

export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

interface PreferencesContextValue {
	locale: AppLocale;
	setLocale: (locale: AppLocale) => void;
	theme: ThemePreference;
	resolvedTheme: ResolvedTheme;
	setTheme: (theme: ThemePreference) => void;
}

const localeStorageKey = 'mulder.locale';
const themeStorageKey = 'mulder.theme';

const PreferencesContext = createContext<PreferencesContextValue | null>(null);

function isLocale(value: string | null): value is AppLocale {
	return value !== null && (locales as readonly string[]).includes(value);
}

function isThemePreference(value: string | null): value is ThemePreference {
	return value === 'light' || value === 'dark' || value === 'system';
}

function readInitialLocale(): AppLocale {
	if (typeof window === 'undefined') return defaultLocale;
	const stored = window.localStorage.getItem(localeStorageKey);
	if (isLocale(stored)) return stored;
	const browserLocale = window.navigator.language.toLowerCase().startsWith('de') ? 'de' : defaultLocale;
	return browserLocale;
}

function readInitialTheme(): ThemePreference {
	if (typeof window === 'undefined') return 'system';
	const stored = window.localStorage.getItem(themeStorageKey);
	return isThemePreference(stored) ? stored : 'system';
}

function getSystemTheme(): ResolvedTheme {
	if (typeof window === 'undefined') return 'light';
	return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function PreferencesProvider({ children }: { children: ReactNode }) {
	const [locale, setLocaleState] = useState<AppLocale>(readInitialLocale);
	const [theme, setThemeState] = useState<ThemePreference>(readInitialTheme);
	const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(getSystemTheme);
	const resolvedTheme = theme === 'system' ? systemTheme : theme;

	useEffect(() => {
		const media = window.matchMedia('(prefers-color-scheme: dark)');
		const handleChange = () => setSystemTheme(media.matches ? 'dark' : 'light');
		handleChange();
		media.addEventListener('change', handleChange);
		return () => media.removeEventListener('change', handleChange);
	}, []);

	useEffect(() => {
		document.documentElement.lang = locale;
		window.localStorage.setItem(localeStorageKey, locale);
		void i18n.changeLanguage(locale);
	}, [locale]);

	useEffect(() => {
		document.documentElement.dataset.theme = resolvedTheme;
		document.documentElement.style.colorScheme = resolvedTheme;
		window.localStorage.setItem(themeStorageKey, theme);
	}, [resolvedTheme, theme]);

	const value = useMemo<PreferencesContextValue>(
		() => ({
			locale,
			resolvedTheme,
			setLocale: setLocaleState,
			setTheme: setThemeState,
			theme,
		}),
		[locale, resolvedTheme, theme],
	);

	return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>;
}

export function usePreferences() {
	const value = useContext(PreferencesContext);
	if (!value) {
		throw new Error('usePreferences must be used inside PreferencesProvider');
	}
	return value;
}
