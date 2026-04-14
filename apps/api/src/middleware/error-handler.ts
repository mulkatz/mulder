import { isMulderError, type Logger, type MulderError, ZodError } from '@mulder/core';
import type { Context, ErrorHandler } from 'hono';

interface ErrorResponseBody {
	error: {
		code: string;
		message: string;
		details?: unknown;
	};
}

type ApiErrorStatus = 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500 | 503;

function getLogger(c: Context, fallbackLogger: Logger): Logger {
	const requestContext = c.get('requestContext');
	return requestContext?.logger ?? fallbackLogger;
}

function getRequestId(c: Context): string | undefined {
	return c.get('requestId');
}

export function mapErrorToStatus(error: MulderError): ApiErrorStatus {
	const code = error.code.toUpperCase();

	if (code.includes('RATE_LIMIT')) {
		return 429;
	}

	if (code.includes('UNAUTHORIZED') || code.startsWith('AUTH_')) {
		return 401;
	}

	if (code.includes('FORBIDDEN')) {
		return 403;
	}

	if (code.includes('TOO_LARGE')) {
		return 413;
	}

	if (code.includes('NOT_FOUND')) {
		return 404;
	}

	if (code.includes('CONFLICT')) {
		return 409;
	}

	if (code.includes('VALIDATION') || code.startsWith('CONFIG_') || code.includes('INVALID')) {
		return 400;
	}

	if (code.startsWith('DB_')) {
		return 503;
	}

	return 500;
}

function buildErrorBody(code: string, message: string, details?: unknown): ErrorResponseBody {
	return {
		error: {
			code,
			message,
			...(details ? { details } : {}),
		},
	};
}

function isZodValidationError(error: unknown): error is ZodError {
	return error instanceof ZodError;
}

export function createErrorHandler(fallbackLogger: Logger): ErrorHandler {
	return (error, c) => {
		const logger = getLogger(c, fallbackLogger);
		const requestId = getRequestId(c);

		if (isMulderError(error)) {
			const status = mapErrorToStatus(error);
			const body = buildErrorBody(error.code, error.message, error.context);

			if (status >= 500) {
				logger.error({ err: error, request_id: requestId, status }, 'API request failed');
			} else {
				logger.warn({ err: error, request_id: requestId, status }, 'API request failed');
			}

			if (error.context && typeof error.context.retry_after_seconds === 'number') {
				c.header('Retry-After', String(error.context.retry_after_seconds));
			}

			if (requestId) {
				c.header('X-Request-Id', requestId);
			}

			return c.json(body, status);
		}

		if (isZodValidationError(error)) {
			logger.warn({ err: error, request_id: requestId }, 'API validation failed');
			if (requestId) {
				c.header('X-Request-Id', requestId);
			}

			return c.json(buildErrorBody('VALIDATION_ERROR', 'Invalid request', error.flatten()), 400);
		}

		logger.error({ err: error, request_id: requestId }, 'Unhandled API error');
		if (requestId) {
			c.header('X-Request-Id', requestId);
		}

		return c.json(buildErrorBody('INTERNAL_ERROR', 'Internal server error'), 500);
	};
}
