import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { readInitialLocale } from '@/app/preference-storage';
import { defaultLocale, resources } from '@/i18n/resources';

void i18n.use(initReactI18next).init({
	resources,
	lng: readInitialLocale(),
	fallbackLng: defaultLocale,
	interpolation: {
		escapeValue: false,
	},
});

export { i18n };
