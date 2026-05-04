import { ApiError } from '@/lib/api-client';

export type ApiErrorKind = 'unauthenticated' | 'unavailable' | 'forbidden' | 'notFound' | 'validation';

export function classifyApiError(error: unknown): ApiErrorKind {
	if (error instanceof ApiError) {
		if (error.status === 401) return 'unauthenticated';
		if (error.status === 0 || error.status >= 500) return 'unavailable';
		if (error.status === 403) return 'forbidden';
		if (error.status === 404) return 'notFound';
		return 'validation';
	}

	return 'unavailable';
}

export function isApiUnavailableError(error: unknown) {
	return classifyApiError(error) === 'unavailable';
}

export function getErrorMessage(error: unknown, fallback = 'The API request failed.') {
	if (error instanceof ApiError) {
		if (error.status === 0) return fallback;
		return `${error.status} ${error.message}`;
	}
	if (error instanceof Error) {
		return error.message;
	}
	return fallback;
}

export function hasQueryError(errors: unknown[]) {
	return errors.some(Boolean);
}
