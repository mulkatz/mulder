import { MulderError } from '@mulder/core';
import type { MiddlewareHandler } from 'hono';

export const MAX_API_BODY_BYTES = 10 * 1024 * 1024;

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function parseContentLength(headerValue: string | null): number | undefined {
	if (headerValue === null) {
		return undefined;
	}

	const parsed = Number.parseInt(headerValue, 10);
	return Number.isFinite(parsed) ? parsed : undefined;
}

async function measureRequestBodyBytes(request: Request, maxBodyBytes: number): Promise<number | undefined> {
	if (request.body === null) {
		return undefined;
	}

	const clonedRequest = request.clone();
	if (clonedRequest.body === null) {
		return undefined;
	}

	const reader = clonedRequest.body.getReader();
	let totalBytes = 0;

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				return totalBytes;
			}

			totalBytes += value.byteLength;
			if (totalBytes > maxBodyBytes) {
				return totalBytes;
			}
		}
	} finally {
		reader.releaseLock();
	}
}

export function createBodyLimitMiddleware(maxBodyBytes = MAX_API_BODY_BYTES): MiddlewareHandler {
	return async (c, next) => {
		if (!BODY_METHODS.has(c.req.method.toUpperCase())) {
			await next();
			return;
		}

		const contentLength = parseContentLength(c.req.header('content-length') ?? null);
		if (contentLength !== undefined && contentLength > maxBodyBytes) {
			throw new MulderError('Request body exceeds the API limit', 'REQUEST_BODY_TOO_LARGE', {
				context: {
					content_length: contentLength,
					max_bytes: maxBodyBytes,
				},
			});
		}

		const requestBodyBytes = await measureRequestBodyBytes(c.req.raw, maxBodyBytes);
		if (requestBodyBytes !== undefined && requestBodyBytes > maxBodyBytes) {
			throw new MulderError('Request body exceeds the API limit', 'REQUEST_BODY_TOO_LARGE', {
				context: {
					content_length: requestBodyBytes,
					max_bytes: maxBodyBytes,
				},
			});
		}

		await next();
	};
}
