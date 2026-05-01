import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { MulderError } from './errors.js';
import type { RobotsDecision, UrlFetcherService, UrlFetchOptions, UrlFetchResult } from './services.js';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_REDIRECT_LIMIT = 5;
const USER_AGENT = 'MulderUrlFetcher/1.0';
const HTML_CONTENT_TYPES = new Set(['text/html', 'application/xhtml+xml']);

function testUnsafeOverrideEnabled(): boolean {
	return process.env.NODE_ENV === 'test' && process.env.MULDER_ALLOW_UNSAFE_URLS_FOR_TESTS === 'true';
}

function normalizeUrlInput(input: string): string {
	const trimmed = input.trim();
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch (cause: unknown) {
		throw new MulderError('URL input must be an absolute HTTP(S) URL', 'URL_INVALID', { cause });
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new MulderError('URL input must use http:// or https://', 'URL_UNSUPPORTED_SCHEME', {
			context: { protocol: url.protocol },
		});
	}
	if (!url.hostname) {
		throw new MulderError('URL input must include a hostname', 'URL_INVALID');
	}
	url.hash = '';
	return url.toString();
}

function isLocalhostName(hostname: string): boolean {
	const lower = hostname.toLowerCase();
	return lower === 'localhost' || lower.endsWith('.localhost');
}

function ipv4ToNumber(ip: string): number {
	return ip.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

function ipv4InRange(ip: string, cidr: string): boolean {
	const [base, bitsText] = cidr.split('/');
	const bits = Number(bitsText);
	const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
	return (ipv4ToNumber(ip) & mask) === (ipv4ToNumber(base ?? '0.0.0.0') & mask);
}

function isUnsafeIpv4(ip: string): boolean {
	return [
		'0.0.0.0/8',
		'10.0.0.0/8',
		'100.64.0.0/10',
		'127.0.0.0/8',
		'169.254.0.0/16',
		'172.16.0.0/12',
		'192.0.0.0/24',
		'192.0.2.0/24',
		'192.168.0.0/16',
		'198.18.0.0/15',
		'198.51.100.0/24',
		'203.0.113.0/24',
		'224.0.0.0/4',
		'240.0.0.0/4',
	].some((range) => ipv4InRange(ip, range));
}

function normalizeIpv6(ip: string): string {
	return ip.toLowerCase();
}

function isUnsafeIpv6(ip: string): boolean {
	const normalized = normalizeIpv6(ip);
	return (
		normalized === '::' ||
		normalized === '::1' ||
		normalized.startsWith('fc') ||
		normalized.startsWith('fd') ||
		normalized.startsWith('fe8') ||
		normalized.startsWith('fe9') ||
		normalized.startsWith('fea') ||
		normalized.startsWith('feb') ||
		normalized.startsWith('ff') ||
		normalized.startsWith('2001:db8')
	);
}

function isUnsafeAddress(address: string): boolean {
	const family = isIP(address);
	if (family === 4) {
		return isUnsafeIpv4(address);
	}
	if (family === 6) {
		return isUnsafeIpv6(address);
	}
	return true;
}

async function assertPublicHttpTarget(url: URL): Promise<void> {
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new MulderError('Redirect target must use HTTP(S)', 'URL_UNSUPPORTED_SCHEME', {
			context: { url: url.toString(), protocol: url.protocol },
		});
	}
	if (isLocalhostName(url.hostname) && !testUnsafeOverrideEnabled()) {
		throw new MulderError('URL targets on localhost are not allowed', 'URL_UNSAFE_TARGET', {
			context: { hostname: url.hostname },
		});
	}
	if (testUnsafeOverrideEnabled()) {
		return;
	}
	if (isIP(url.hostname) !== 0) {
		if (isUnsafeAddress(url.hostname)) {
			throw new MulderError('URL target resolves to an unsafe address', 'URL_UNSAFE_TARGET', {
				context: { hostname: url.hostname, address: url.hostname },
			});
		}
		return;
	}
	let addresses: Array<{ address: string; family: number }>;
	try {
		addresses = await lookup(url.hostname, { all: true, verbatim: true });
	} catch (cause: unknown) {
		throw new MulderError('URL hostname could not be resolved safely', 'URL_DNS_FAILED', {
			cause,
			context: { hostname: url.hostname },
		});
	}
	if (addresses.length === 0 || addresses.every((address) => isUnsafeAddress(address.address))) {
		throw new MulderError('URL hostname resolves only to unsafe addresses', 'URL_UNSAFE_TARGET', {
			context: { hostname: url.hostname, addresses: addresses.map((address) => address.address) },
		});
	}
}

function parseContentType(value: string | null): { mediaType: string; charset: string | null } {
	const [mediaType = '', ...parameters] = (value ?? '').split(';').map((part) => part.trim());
	const charsetParameter = parameters.find((part) => part.toLowerCase().startsWith('charset='));
	return {
		mediaType: mediaType.toLowerCase(),
		charset: charsetParameter ? charsetParameter.slice('charset='.length).replace(/^"|"$/g, '') : null,
	};
}

async function readBoundedResponse(response: Response, maxBytes: number): Promise<Buffer> {
	if (!response.body) {
		return Buffer.alloc(0);
	}
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const next = await reader.read();
			if (next.done) {
				break;
			}
			total += next.value.byteLength;
			if (total > maxBytes) {
				throw new MulderError('URL response exceeded maximum ingest size', 'URL_TOO_LARGE', {
					context: { maxBytes, receivedBytes: total },
				});
			}
			chunks.push(next.value);
		}
	} finally {
		reader.releaseLock();
	}
	return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

async function fetchOnce(url: URL, options: { timeoutMs: number }): Promise<Response> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
	try {
		return await fetch(url, {
			redirect: 'manual',
			signal: controller.signal,
			headers: {
				'User-Agent': USER_AGENT,
				Accept: 'text/html, application/xhtml+xml;q=0.9',
			},
		});
	} finally {
		clearTimeout(timeout);
	}
}

function headersToRecord(headers: Headers): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, value] of headers.entries()) {
		result[key.toLowerCase()] = value;
	}
	return result;
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

function agentMatches(agent: string): boolean {
	const normalized = agent.toLowerCase();
	return normalized === '*' || USER_AGENT.toLowerCase().startsWith(normalized) || normalized.includes('mulder');
}

function isPathAllowedByRobots(groups: RobotsGroup[], path: string): { allowed: boolean; rule: string | null } {
	const matchingRules = groups
		.filter((group) => group.agents.some(agentMatches))
		.flatMap((group) => group.rules)
		.filter((rule) => rule.path.length > 0 && path.startsWith(rule.path))
		.sort((a, b) => b.path.length - a.path.length);
	const rule = matchingRules[0];
	if (!rule) {
		return { allowed: true, rule: null };
	}
	return { allowed: rule.directive === 'allow', rule: `${rule.directive}: ${rule.path}` };
}

async function fetchRobots(url: URL, options: { timeoutMs: number; maxBytes: number }): Promise<RobotsDecision> {
	const robotsUrl = new URL('/robots.txt', url.origin);
	await assertPublicHttpTarget(robotsUrl);
	try {
		const response = await fetchOnce(robotsUrl, { timeoutMs: options.timeoutMs });
		if (response.status === 404 || response.status === 410) {
			return { allowed: true, robotsUrl: robotsUrl.toString(), matchedUserAgent: null, matchedRule: null };
		}
		if (!response.ok) {
			return { allowed: true, robotsUrl: robotsUrl.toString(), matchedUserAgent: null, matchedRule: null };
		}
		const body = await readBoundedResponse(response, Math.min(options.maxBytes, 512 * 1024));
		const decision = isPathAllowedByRobots(parseRobots(body.toString('utf-8')), `${url.pathname}${url.search}`);
		return {
			allowed: decision.allowed,
			robotsUrl: robotsUrl.toString(),
			matchedUserAgent: decision.rule ? USER_AGENT : null,
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
		await assertPublicHttpTarget(currentUrl);
		const robots = await fetchRobots(currentUrl, { timeoutMs, maxBytes: options.maxBytes });
		if (!robots.allowed) {
			throw new MulderError('URL fetch disallowed by robots.txt', 'URL_ROBOTS_DISALLOWED', {
				context: { url: normalizedUrl, robotsUrl: robots.robotsUrl, matchedRule: robots.matchedRule },
			});
		}

		let redirectCount = 0;
		let response: Response;
		while (true) {
			response = await fetchOnce(currentUrl, { timeoutMs });
			if (![301, 302, 303, 307, 308].includes(response.status)) {
				break;
			}
			const location = response.headers.get('location');
			if (!location) {
				throw new MulderError('URL redirect response did not include a Location header', 'URL_REDIRECT_FAILED', {
					context: { url: currentUrl.toString(), status: response.status },
				});
			}
			if (redirectCount >= redirectLimit) {
				throw new MulderError('URL redirect limit exceeded', 'URL_REDIRECT_LIMIT', {
					context: { url: normalizedUrl, redirectLimit },
				});
			}
			currentUrl = new URL(location, currentUrl);
			currentUrl.hash = '';
			await assertPublicHttpTarget(currentUrl);
			redirectCount++;
		}

		if (!response.ok) {
			throw new MulderError('URL fetch failed with non-success status', 'URL_HTTP_STATUS', {
				context: { url: currentUrl.toString(), status: response.status },
			});
		}
		const contentLength = Number.parseInt(response.headers.get('content-length') ?? '', 10);
		if (Number.isFinite(contentLength) && contentLength > options.maxBytes) {
			throw new MulderError('URL response exceeded maximum ingest size', 'URL_TOO_LARGE', {
				context: { maxBytes: options.maxBytes, contentLength },
			});
		}
		const contentType = parseContentType(response.headers.get('content-type'));
		if (!HTML_CONTENT_TYPES.has(contentType.mediaType)) {
			throw new MulderError('URL response content type is not HTML', 'URL_UNSUPPORTED_CONTENT_TYPE', {
				context: { url: currentUrl.toString(), contentType: response.headers.get('content-type') },
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
			contentType: response.headers.get('content-type') ?? contentType.mediaType,
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
