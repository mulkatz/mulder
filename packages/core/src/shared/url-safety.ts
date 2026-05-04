import type { LookupAddress } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { isIP, type LookupFunction } from 'node:net';
import { MulderError } from './errors.js';

export const URL_USER_AGENT = 'MulderUrlFetcher/1.0';

export interface VettedAddress {
	address: string;
	family: number;
}

export interface VettedTarget {
	url: URL;
	addresses: VettedAddress[];
	lookup: LookupFunction;
}

export function testUnsafeOverrideEnabled(): boolean {
	return process.env.NODE_ENV === 'test' && process.env.MULDER_ALLOW_UNSAFE_URLS_FOR_TESTS === 'true';
}

export function rejectCredentialedUrl(url: URL, label: string): void {
	if (url.username || url.password) {
		throw new MulderError(`${label} must not include embedded credentials`, 'URL_CREDENTIALS_UNSUPPORTED');
	}
}

export function normalizeUrlInput(input: string): string {
	const trimmed = input.trim();
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch (cause: unknown) {
		throw new MulderError('URL input must be an absolute HTTP(S) URL', 'URL_INVALID', { cause });
	}
	rejectCredentialedUrl(url, 'URL input');
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

export function isUnsafeAddress(address: string): boolean {
	const family = isIP(address);
	if (family === 4) {
		return isUnsafeIpv4(address);
	}
	if (family === 6) {
		return isUnsafeIpv6(address);
	}
	return true;
}

export function addressLiteralFromHostname(hostname: string): string | null {
	const unbracketed = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
	return isIP(unbracketed) === 0 ? null : unbracketed;
}

export function connectionHostname(hostname: string): string {
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

export async function validatePublicHttpTarget(url: URL): Promise<VettedTarget> {
	rejectCredentialedUrl(url, 'URL target');
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
