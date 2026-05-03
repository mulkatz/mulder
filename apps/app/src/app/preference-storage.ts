import { type AppLocale, defaultLocale, locales } from '@/i18n/resources';

export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

export const localeStorageKey = 'mulder.locale';
export const themeStorageKey = 'mulder.theme';

export function isLocale(value: string | null): value is AppLocale {
	return value !== null && (locales as readonly string[]).includes(value);
}

export function isThemePreference(value: string | null): value is ThemePreference {
	return value === 'light' || value === 'dark' || value === 'system';
}

function readStorageValue(key: string) {
	if (typeof window === 'undefined') return null;
	try {
		return window.localStorage.getItem(key);
	} catch {
		return null;
	}
}

function writeStorageValue(key: string, value: string) {
	if (typeof window === 'undefined') return;
	try {
		window.localStorage.setItem(key, value);
	} catch {
		// Preferences are nice-to-have; blocked storage should not break the app.
	}
}

export function readInitialLocale(): AppLocale {
	const stored = readStorageValue(localeStorageKey);
	if (isLocale(stored)) return stored;
	if (typeof window === 'undefined') return defaultLocale;
	return window.navigator.language.toLowerCase().startsWith('de') ? 'de' : defaultLocale;
}

export function readInitialTheme(): ThemePreference {
	const stored = readStorageValue(themeStorageKey);
	return isThemePreference(stored) ? stored : 'system';
}

export function getSystemTheme(): ResolvedTheme {
	if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'light';
	return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function resolveThemePreference(theme: ThemePreference, systemTheme = getSystemTheme()): ResolvedTheme {
	return theme === 'system' ? systemTheme : theme;
}

export function writeLocalePreference(locale: AppLocale) {
	writeStorageValue(localeStorageKey, locale);
}

export function writeThemePreference(theme: ThemePreference) {
	writeStorageValue(themeStorageKey, theme);
}
