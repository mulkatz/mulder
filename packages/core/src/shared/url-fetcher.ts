import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import { type RequestOptions as HttpsRequestOptions, request as httpsRequest } from 'node:https';
import { MulderError } from './errors.js';
import type { RobotsDecision, UrlFetcherService, UrlFetchOptions, UrlFetchResult } from './services.js';
import {
	addressLiteralFromHostname,
	connectionHostname,
	normalizeUrlInput,
	URL_USER_AGENT,
	type VettedTarget,
	validatePublicHttpTarget,
} from './url-safety.js';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_REDIRECT_LIMIT = 5;
const HTML_CONTENT_TYPES = new Set(['text/html', 'application/xhtml+xml']);

interface NodeFetchResponse {
	status: number;
	ok: boolean;
	headers: IncomingHttpHeaders;
	body: IncomingMessage;
	release: () => void;
}

function parseContentType(value: string | null): { mediaType: string; charset: string | null } {
	const [mediaType = '', ...parameters] = (value ?? '').split(';').map((part) => part.trim());
	const charsetParameter = parameters.find((part) => part.toLowerCase().startsWith('charset='));
	return {
		mediaType: mediaType.toLowerCase(),
		charset: charsetParameter ? charsetParameter.slice('charset='.length).replace(/^"|"$/g, '') : null,
	};
}

function headerValue(headers: IncomingHttpHeaders, name: string): string | null {
	const value = headers[name.toLowerCase()];
	if (Array.isArray(value)) {
		return value[0] ?? null;
	}
	return value ?? null;
}

async function readBoundedResponse(response: NodeFetchResponse, maxBytes: number): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let total = 0;
	try {
		for await (const chunk of response.body) {
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			total += buffer.byteLength;
			if (total > maxBytes) {
				response.body.destroy();
				throw new MulderError('URL response exceeded maximum ingest size', 'URL_TOO_LARGE', {
					context: { maxBytes, receivedBytes: total },
				});
			}
			chunks.push(buffer);
		}
	} finally {
		response.release();
	}
	return Buffer.concat(chunks);
}

async function fetchOnce(
	target: VettedTarget,
	options: { timeoutMs: number; ifNoneMatch?: string | null; ifModifiedSince?: string | null },
): Promise<NodeFetchResponse> {
	const { url } = target;
	const headers: Record<string, string> = {
		Host: url.host,
		'User-Agent': URL_USER_AGENT,
		Accept: 'text/html, application/xhtml+xml;q=0.9',
	};
	if (options.ifNoneMatch) {
		headers['If-None-Match'] = options.ifNoneMatch;
	}
	if (options.ifModifiedSince) {
		headers['If-Modified-Since'] = options.ifModifiedSince;
	}
	const requestOptions: HttpsRequestOptions = {
		protocol: url.protocol,
		hostname: connectionHostname(url.hostname),
		port: url.port || undefined,
		method: 'GET',
		path: `${url.pathname}${url.search}`,
		headers,
		lookup: target.lookup,
		agent: false,
	};
	const servername = addressLiteralFromHostname(url.hostname) ? undefined : url.hostname;
	if (url.protocol === 'https:' && servername) {
		requestOptions.servername = servername;
	}
	return await new Promise((resolve, reject) => {
		let released = false;
		let timeout: NodeJS.Timeout | null = null;
		const release = () => {
			if (released) {
				return;
			}
			released = true;
			if (timeout) {
				clearTimeout(timeout);
				timeout = null;
			}
		};
		const onResponse = (body: IncomingMessage) => {
			body.once('end', release);
			body.once('close', release);
			body.once('error', release);
			const status = body.statusCode ?? 0;
			resolve({
				status,
				ok: status >= 200 && status <= 299,
				headers: body.headers,
				body,
				release,
			});
		};
		const request =
			url.protocol === 'https:' ? httpsRequest(requestOptions, onResponse) : httpRequest(requestOptions, onResponse);
		timeout = setTimeout(() => {
			request.destroy(
				new MulderError('URL fetch timed out', 'URL_TIMEOUT', {
					context: { url: url.toString(), timeoutMs: options.timeoutMs },
				}),
			);
		}, options.timeoutMs);
		request.on('error', (cause: unknown) => {
			release();
			reject(cause);
		});
		request.end();
	});
}

function discardResponse(response: NodeFetchResponse): void {
	response.release();
	response.body.destroy();
}

function headersToRecord(headers: IncomingHttpHeaders): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		if (Array.isArray(value)) {
			result[key.toLowerCase()] = value.join(', ');
			continue;
		}
		if (value !== undefined) {
			result[key.toLowerCase()] = value;
		}
	}
	return result;
}

function responseHeader(response: NodeFetchResponse, name: string): string | null {
	return headerValue(response.headers, name);
}

function isRedirectStatus(status: number): boolean {
	return [301, 302, 303, 307, 308].includes(status);
}

function stripRobotsComment(line: string): string {
	const hashIndex = line.indexOf('#');
	return (hashIndex >= 0 ? line.slice(0, hashIndex) : line).trim();
}

interface RobotsGroup {
	agents: string[];
	rules: Array<{ directive: 'allow' | 'disallow'; path: string }>;
}

function parseRobots(text: string): RobotsGroup[] {
	const groups: RobotsGroup[] = [];
	let current: RobotsGroup | null = null;
	for (const rawLine of text.split(/\r?\n/)) {
		const line = stripRobotsComment(rawLine);
		if (!line) {
			continue;
		}
		const colon = line.indexOf(':');
		if (colon < 0) {
			continue;
		}
		const key = line.slice(0, colon).trim().toLowerCase();
		const value = line.slice(colon + 1).trim();
		if (key === 'user-agent') {
			if (!current || current.rules.length > 0) {
				current = { agents: [], rules: [] };
				groups.push(current);
			}
			current.agents.push(value.toLowerCase());
			continue;
		}
		if ((key === 'allow' || key === 'disallow') && current) {
			current.rules.push({ directive: key, path: value });
		}
	}
	return groups;
}

function matchingAgentSpecificity(agent: string): number | null {
	const normalized = agent.toLowerCase();
	if (normalized === '*') {
		return 0;
	}
	if (normalized.length > 0 && URL_USER_AGENT.toLowerCase().includes(normalized)) {
		return normalized.length;
	}
	return null;
}

function isPathAllowedByRobots(groups: RobotsGroup[], path: string): { allowed: boolean; rule: string | null } {
	const matchingGroups = groups
		.map((group) => ({
			group,
			specificity: Math.max(
				...group.agents.map((agent) => matchingAgentSpecificity(agent)).filter((score) => score !== null),
			),
		}))
		.filter((match) => Number.isFinite(match.specificity));
	const highestSpecificity = Math.max(...matchingGroups.map((match) => match.specificity));
	const matchingRules = matchingGroups
		.filter((match) => match.specificity === highestSpecificity)
		.map((match) => match.group)
		.flatMap((group) => group.rules)
		.filter((rule) => rule.path.length > 0 && path.startsWith(rule.path))
		.sort(
			(a, b) =>
				b.path.length - a.path.length || (a.directive === b.directive ? 0 : a.directive === 'disallow' ? -1 : 1),
		);
	const rule = matchingRules[0];
	if (!rule) {
		return { allowed: true, rule: null };
	}
	return { allowed: rule.directive === 'allow', rule: `${rule.directive}: ${rule.path}` };
}

async function fetchRobots(
	url: URL,
	options: { timeoutMs: number; maxBytes: number; redirectLimit: number },
): Promise<RobotsDecision> {
	const initialRobotsUrl = new URL('/robots.txt', url.origin);
	let robotsUrl = initialRobotsUrl;
	let robotsTarget = await validatePublicHttpTarget(robotsUrl);
	try {
		let redirectCount = 0;
		let response: NodeFetchResponse;
		while (true) {
			response = await fetchOnce(robotsTarget, { timeoutMs: options.timeoutMs });
			if (!isRedirectStatus(response.status)) {
				break;
			}
			const location = responseHeader(response, 'location');
			if (!location) {
				discardResponse(response);
				throw new MulderError('robots.txt redirect response did not include a Location header', 'URL_REDIRECT_FAILED', {
					context: { url: robotsUrl.toString(), status: response.status },
				});
			}
			if (redirectCount >= options.redirectLimit) {
				discardResponse(response);
				throw new MulderError('robots.txt redirect limit exceeded', 'URL_REDIRECT_LIMIT', {
					context: { url: initialRobotsUrl.toString(), redirectLimit: options.redirectLimit },
				});
			}
			discardResponse(response);
			robotsUrl = new URL(location, robotsUrl);
			robotsUrl.hash = '';
			robotsTarget = await validatePublicHttpTarget(robotsUrl);
			redirectCount++;
		}
		if (response.status === 404 || response.status === 410) {
			discardResponse(response);
			return { allowed: true, robotsUrl: robotsUrl.toString(), matchedUserAgent: null, matchedRule: null };
		}
		if (!response.ok) {
			discardResponse(response);
			return { allowed: true, robotsUrl: robotsUrl.toString(), matchedUserAgent: null, matchedRule: null };
		}
		const body = await readBoundedResponse(response, Math.min(options.maxBytes, 512 * 1024));
		const decision = isPathAllowedByRobots(parseRobots(body.toString('utf-8')), `${url.pathname}${url.search}`);
		return {
			allowed: decision.allowed,
			robotsUrl: robotsUrl.toString(),
			matchedUserAgent: decision.rule ? URL_USER_AGENT : null,
			matchedRule: decision.rule,
		};
	} catch (cause: unknown) {
		if (cause instanceof MulderError) {
			throw cause;
		}
		return { allowed: true, robotsUrl: robotsUrl.toString(), matchedUserAgent: null, matchedRule: null };
	}
}

class LocalUrlFetcherService implements UrlFetcherService {
	async fetchUrl(inputUrl: string, options: UrlFetchOptions): Promise<UrlFetchResult> {
		const normalizedUrl = normalizeUrlInput(inputUrl);
		let currentUrl = new URL(normalizedUrl);
		const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		const redirectLimit = options.redirectLimit ?? DEFAULT_REDIRECT_LIMIT;
		let currentTarget = await validatePublicHttpTarget(currentUrl);
		let robots = await fetchRobots(currentUrl, { timeoutMs, maxBytes: options.maxBytes, redirectLimit });
		if (!robots.allowed) {
			throw new MulderError('URL fetch disallowed by robots.txt', 'URL_ROBOTS_DISALLOWED', {
				context: { url: normalizedUrl, robotsUrl: robots.robotsUrl, matchedRule: robots.matchedRule },
			});
		}

		let redirectCount = 0;
		let response: NodeFetchResponse;
		let conditionalHeaders: Pick<UrlFetchOptions, 'ifNoneMatch' | 'ifModifiedSince'> = {
			ifNoneMatch: options.ifNoneMatch,
			ifModifiedSince: options.ifModifiedSince,
		};
		while (true) {
			response = await fetchOnce(currentTarget, {
				timeoutMs,
				...conditionalHeaders,
			});
			if (!isRedirectStatus(response.status)) {
				break;
			}
			const location = responseHeader(response, 'location');
			if (!location) {
				discardResponse(response);
				throw new MulderError('URL redirect response did not include a Location header', 'URL_REDIRECT_FAILED', {
					context: { url: currentUrl.toString(), status: response.status },
				});
			}
			if (redirectCount >= redirectLimit) {
				discardResponse(response);
				throw new MulderError('URL redirect limit exceeded', 'URL_REDIRECT_LIMIT', {
					context: { url: normalizedUrl, redirectLimit },
				});
			}
			discardResponse(response);
			const previousOrigin = currentUrl.origin;
			currentUrl = new URL(location, currentUrl);
			currentUrl.hash = '';
			if (currentUrl.origin !== previousOrigin) {
				conditionalHeaders = {};
			}
			currentTarget = await validatePublicHttpTarget(currentUrl);
			robots = await fetchRobots(currentUrl, { timeoutMs, maxBytes: options.maxBytes, redirectLimit });
			if (!robots.allowed) {
				throw new MulderError('URL fetch disallowed by robots.txt', 'URL_ROBOTS_DISALLOWED', {
					context: { url: currentUrl.toString(), robotsUrl: robots.robotsUrl, matchedRule: robots.matchedRule },
				});
			}
			redirectCount++;
		}

		const rawContentType = responseHeader(response, 'content-type');
		if (response.status === 304) {
			discardResponse(response);
			return {
				originalUrl: inputUrl,
				normalizedUrl,
				finalUrl: currentUrl.toString(),
				httpStatus: response.status,
				headers: headersToRecord(response.headers),
				html: Buffer.alloc(0),
				notModified: true,
				contentType: rawContentType ?? '',
				redirectCount,
				fetchedAt: new Date().toISOString(),
				robots,
				snapshotEncoding: null,
			};
		}

		if (!response.ok) {
			discardResponse(response);
			throw new MulderError('URL fetch failed with non-success status', 'URL_HTTP_STATUS', {
				context: { url: currentUrl.toString(), status: response.status },
			});
		}
		const contentLength = Number.parseInt(responseHeader(response, 'content-length') ?? '', 10);
		if (Number.isFinite(contentLength) && contentLength > options.maxBytes) {
			discardResponse(response);
			throw new MulderError('URL response exceeded maximum ingest size', 'URL_TOO_LARGE', {
				context: { maxBytes: options.maxBytes, contentLength },
			});
		}
		const contentType = parseContentType(rawContentType);
		if (!HTML_CONTENT_TYPES.has(contentType.mediaType)) {
			discardResponse(response);
			throw new MulderError('URL response content type is not HTML', 'URL_UNSUPPORTED_CONTENT_TYPE', {
				context: { url: currentUrl.toString(), contentType: rawContentType },
			});
		}
		const html = await readBoundedResponse(response, options.maxBytes);
		return {
			originalUrl: inputUrl,
			normalizedUrl,
			finalUrl: currentUrl.toString(),
			httpStatus: response.status,
			headers: headersToRecord(response.headers),
			html,
			notModified: false,
			contentType: rawContentType ?? contentType.mediaType,
			redirectCount,
			fetchedAt: new Date().toISOString(),
			robots,
			snapshotEncoding: contentType.charset,
		};
	}
}

export function createUrlFetcherService(): UrlFetcherService {
	return new LocalUrlFetcherService();
}
