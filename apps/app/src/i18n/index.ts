import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { defaultLocale, resources } from '@/i18n/resources';

void i18n.use(initReactI18next).init({
	resources,
	lng: defaultLocale,
	fallbackLng: defaultLocale,
	interpolation: {
		escapeValue: false,
	},
});

export { i18n };
