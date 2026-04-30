import { ApiError } from '@/lib/api-client';

export function getErrorMessage(error: unknown, fallback = 'The API request failed.') {
	if (error instanceof ApiError) {
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
