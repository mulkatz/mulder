import type { LookupAddress } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import { type RequestOptions as HttpsRequestOptions, request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { MulderError } from './errors.js';
import type { RobotsDecision, UrlFetcherService, UrlFetchOptions, UrlFetchResult } from './services.js';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_REDIRECT_LIMIT = 5;
const USER_AGENT = 'MulderUrlFetcher/1.0';
const HTML_CONTENT_TYPES = new Set(['text/html', 'application/xhtml+xml']);

interface VettedAddress {
	address: string;
	family: number;
}

interface VettedTarget {
	url: URL;
	addresses: VettedAddress[];
	lookup: LookupFunction;
}

interface NodeFetchResponse {
	status: number;
	ok: boolean;
	headers: IncomingHttpHeaders;
	body: IncomingMessage;
	release: () => void;
}

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

function ipv4FromMappedHexTail(tail: string): string | null {
	const parts = tail.split(':');
	if (parts.length !== 2 || parts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) {
		return null;
	}
	const high = Number.parseInt(parts[0] ?? '', 16);
	const low = Number.parseInt(parts[1] ?? '', 16);
	if (!Number.isInteger(high) || !Number.isInteger(low) || high > 0xffff || low > 0xffff) {
		return null;
	}
	return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
}

function ipv4FromIpv4MappedIpv6(ip: string): string | null {
	const normalized = normalizeIpv6(ip);
	for (const prefix of ['::ffff:', '0:0:0:0:0:ffff:']) {
		if (!normalized.startsWith(prefix)) {
			continue;
		}
		const tail = normalized.slice(prefix.length);
		if (isIP(tail) === 4) {
			return tail;
		}
		return ipv4FromMappedHexTail(tail);
	}
	return null;
}

function isUnsafeIpv6(ip: string): boolean {
	const mappedIpv4 = ipv4FromIpv4MappedIpv6(ip);
	if (mappedIpv4) {
		return isUnsafeIpv4(mappedIpv4);
	}
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

function addressLiteralFromHostname(hostname: string): string | null {
	const unbracketed = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
	return isIP(unbracketed) === 0 ? null : unbracketed;
}

function connectionHostname(hostname: string): string {
	return addressLiteralFromHostname(hostname) ?? hostname;
}

function normalizeLookupFamily(family: number | string | undefined): number {
	if (family === 'IPv4') {
		return 4;
	}
	if (family === 'IPv6') {
		return 6;
	}
	return typeof family === 'number' ? family : 0;
}

function createPinnedLookup(addresses: VettedAddress[]): LookupFunction {
	return (_hostname, options, callback) => {
		const requestedFamily = normalizeLookupFamily(options.family);
		const matchingAddresses =
			requestedFamily === 4 || requestedFamily === 6
				? addresses.filter((address) => address.family === requestedFamily)
				: addresses;
		if (matchingAddresses.length === 0) {
			const error: NodeJS.ErrnoException = new Error('No validated DNS address matches the requested family');
			error.code = 'ENOTFOUND';
			callback(error, '', requestedFamily);
			return;
		}
		if (options.all) {
			callback(
				null,
				matchingAddresses.map((address) => ({ address: address.address, family: address.family })),
			);
			return;
		}
		const [address] = matchingAddresses;
		callback(null, address.address, address.family);
	};
}

function createVettedTarget(url: URL, addresses: VettedAddress[]): VettedTarget {
	return { url, addresses, lookup: createPinnedLookup(addresses) };
}

async function resolveTargetAddresses(hostname: string): Promise<LookupAddress[]> {
	try {
		return await lookup(hostname, { all: true, verbatim: true });
	} catch (cause: unknown) {
		throw new MulderError('URL hostname could not be resolved safely', 'URL_DNS_FAILED', {
			cause,
			context: { hostname },
		});
	}
}

async function validatePublicHttpTarget(url: URL): Promise<VettedTarget> {
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
	const literalAddress = addressLiteralFromHostname(url.hostname);
	if (literalAddress) {
		if (isUnsafeAddress(literalAddress) && !testUnsafeOverrideEnabled()) {
			throw new MulderError('URL target resolves to an unsafe address', 'URL_UNSAFE_TARGET', {
				context: { hostname: url.hostname, address: literalAddress },
			});
		}
		return createVettedTarget(url, [{ address: literalAddress, family: isIP(literalAddress) }]);
	}
	const addresses = await resolveTargetAddresses(url.hostname);
	if (addresses.length === 0) {
		throw new MulderError('URL hostname did not resolve to any address', 'URL_DNS_FAILED', {
			context: { hostname: url.hostname },
		});
	}
	const unsafeAddresses = addresses.filter((address) => isUnsafeAddress(address.address));
	if (unsafeAddresses.length > 0 && !testUnsafeOverrideEnabled()) {
		throw new MulderError('URL hostname resolves to an unsafe address', 'URL_UNSAFE_TARGET', {
			context: { hostname: url.hostname, addresses: addresses.map((address) => address.address) },
		});
	}
	return createVettedTarget(
		url,
		addresses.map((address) => ({ address: address.address, family: address.family })),
	);
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

async function fetchOnce(target: VettedTarget, options: { timeoutMs: number }): Promise<NodeFetchResponse> {
	const { url } = target;
	const requestOptions: HttpsRequestOptions = {
		protocol: url.protocol,
		hostname: connectionHostname(url.hostname),
		port: url.port || undefined,
		method: 'GET',
		path: `${url.pathname}${url.search}`,
		headers: {
			Host: url.host,
			'User-Agent': USER_AGENT,
			Accept: 'text/html, application/xhtml+xml;q=0.9',
		},
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
		let currentTarget = await validatePublicHttpTarget(currentUrl);
		let robots = await fetchRobots(currentUrl, { timeoutMs, maxBytes: options.maxBytes, redirectLimit });
		if (!robots.allowed) {
			throw new MulderError('URL fetch disallowed by robots.txt', 'URL_ROBOTS_DISALLOWED', {
				context: { url: normalizedUrl, robotsUrl: robots.robotsUrl, matchedRule: robots.matchedRule },
			});
		}

		let redirectCount = 0;
		let response: NodeFetchResponse;
		while (true) {
			response = await fetchOnce(currentTarget, { timeoutMs });
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
			currentUrl = new URL(location, currentUrl);
			currentUrl.hash = '';
			currentTarget = await validatePublicHttpTarget(currentUrl);
			robots = await fetchRobots(currentUrl, { timeoutMs, maxBytes: options.maxBytes, redirectLimit });
			if (!robots.allowed) {
				throw new MulderError('URL fetch disallowed by robots.txt', 'URL_ROBOTS_DISALLOWED', {
					context: { url: currentUrl.toString(), robotsUrl: robots.robotsUrl, matchedRule: robots.matchedRule },
				});
			}
			redirectCount++;
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
		const rawContentType = responseHeader(response, 'content-type');
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
