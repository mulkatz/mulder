const API_BASE = import.meta.env.VITE_API_BASE_URL ?? '';

interface ApiErrorBody {
	error?: {
		code?: string;
		message?: string;
		details?: unknown;
	};
}

export class ApiError extends Error {
	status: number;
	code: string;
	details?: unknown;

	constructor(status: number, code: string, message: string, details?: unknown) {
		super(message);
		this.name = 'ApiError';
		this.status = status;
		this.code = code;
		this.details = details;
	}
}

function toNetworkError(error: unknown) {
	return new ApiError(
		0,
		'NETWORK_ERROR',
		error instanceof Error ? error.message : 'The API could not be reached.',
		error instanceof Error ? { name: error.name } : undefined,
	);
}

async function parseErrorBody(response: Response): Promise<ApiErrorBody> {
	try {
		return (await response.json()) as ApiErrorBody;
	} catch {
		return {};
	}
}

function buildJsonHeaders(init?: RequestInit) {
	const headers = new Headers(init?.headers);
	if (!headers.has('Content-Type') && init?.body !== undefined) {
		headers.set('Content-Type', 'application/json');
	}
	return headers;
}

async function fetchApi(path: string, init?: RequestInit) {
	try {
		return await fetch(buildApiUrl(path), {
			credentials: 'include',
			...init,
			headers: buildJsonHeaders(init),
		});
	} catch (error) {
		throw toNetworkError(error);
	}
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
	const response = await fetchApi(path, init);

	if (!response.ok) {
		const body = await parseErrorBody(response);
		throw new ApiError(
			response.status,
			body.error?.code ?? 'UNKNOWN',
			body.error?.message ?? response.statusText,
			body.error?.details,
		);
	}

	if (response.status === 204) {
		return undefined as T;
	}

	try {
		return (await response.json()) as T;
	} catch (error) {
		throw new ApiError(
			response.status,
			'INVALID_RESPONSE',
			error instanceof Error ? error.message : 'The API returned an invalid JSON response.',
		);
	}
}

export async function apiFetchText(path: string, init?: RequestInit): Promise<string> {
	const headers = new Headers(init?.headers);
	if (!headers.has('Accept')) {
		headers.set('Accept', 'text/markdown, text/plain');
	}

	let response: Response;
	try {
		response = await fetch(buildApiUrl(path), {
			...init,
			credentials: 'include',
			headers,
		});
	} catch (error) {
		throw toNetworkError(error);
	}

	if (!response.ok) {
		const body = await parseErrorBody(response);
		throw new ApiError(
			response.status,
			body.error?.code ?? 'UNKNOWN',
			body.error?.message ?? response.statusText,
			body.error?.details,
		);
	}

	return response.text();
}

export async function apiFetchBlob(path: string, init?: RequestInit): Promise<Blob> {
	const headers = new Headers(init?.headers);
	if (!headers.has('Accept')) {
		headers.set('Accept', 'application/octet-stream');
	}

	let response: Response;
	try {
		response = await fetch(buildApiUrl(path), {
			...init,
			credentials: 'include',
			headers,
		});
	} catch (error) {
		throw toNetworkError(error);
	}

	if (!response.ok) {
		const body = await parseErrorBody(response);
		throw new ApiError(
			response.status,
			body.error?.code ?? 'UNKNOWN',
			body.error?.message ?? response.statusText,
			body.error?.details,
		);
	}

	return response.blob();
}

export function buildApiUrl(path: string) {
	if (/^https?:\/\//i.test(path)) {
		return path;
	}

	if (!API_BASE) {
		return path;
	}

	const base = API_BASE.endsWith('/') ? API_BASE.slice(0, -1) : API_BASE;
	const suffix = path.startsWith('/') ? path : `/${path}`;
	return `${base}${suffix}`;
}
