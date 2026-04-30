import { ApiError } from '@/lib/api-client';

export function getErrorMessage(error: unknown) {
	if (error instanceof ApiError) {
		return `${error.status} ${error.message}`;
	}
	if (error instanceof Error) {
		return error.message;
	}
	return 'The API request failed.';
}

export function hasQueryError(errors: unknown[]) {
	return errors.some(Boolean);
}
