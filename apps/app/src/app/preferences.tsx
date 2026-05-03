import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from 'react';
import {
	getSystemTheme,
	type ResolvedTheme,
	readInitialLocale,
	readInitialTheme,
	resolveThemePreference,
	type ThemePreference,
	writeLocalePreference,
	writeThemePreference,
} from '@/app/preference-storage';
import { i18n } from '@/i18n';
import type { AppLocale } from '@/i18n/resources';

export type { ResolvedTheme, ThemePreference } from '@/app/preference-storage';

interface PreferencesContextValue {
	locale: AppLocale;
	setLocale: (locale: AppLocale) => void;
	theme: ThemePreference;
	resolvedTheme: ResolvedTheme;
	setTheme: (theme: ThemePreference) => void;
}

const PreferencesContext = createContext<PreferencesContextValue | null>(null);

export function PreferencesProvider({ children }: { children: ReactNode }) {
	const [locale, setLocaleState] = useState<AppLocale>(readInitialLocale);
	const [theme, setThemeState] = useState<ThemePreference>(readInitialTheme);
	const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(getSystemTheme);
	const resolvedTheme = resolveThemePreference(theme, systemTheme);

	useEffect(() => {
		if (typeof window.matchMedia !== 'function') return;
		const media = window.matchMedia('(prefers-color-scheme: dark)');
		const handleChange = () => setSystemTheme(media.matches ? 'dark' : 'light');
		handleChange();
		media.addEventListener('change', handleChange);
		return () => media.removeEventListener('change', handleChange);
	}, []);

	useEffect(() => {
		document.documentElement.lang = locale;
		writeLocalePreference(locale);
		void i18n.changeLanguage(locale);
	}, [locale]);

	useEffect(() => {
		document.documentElement.dataset.theme = resolvedTheme;
		document.documentElement.style.colorScheme = resolvedTheme;
		writeThemePreference(theme);
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
