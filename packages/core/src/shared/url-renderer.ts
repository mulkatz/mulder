import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import type { Browser, BrowserContext, Page, Request, Route } from 'playwright';
import { MulderError } from './errors.js';
import type { UrlRendererService, UrlRenderOptions, UrlRenderResult } from './services.js';
import {
	addressLiteralFromHostname,
	normalizeUrlInput,
	URL_USER_AGENT,
	type VettedTarget,
	validatePublicHttpTarget,
} from './url-safety.js';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_REDIRECT_LIMIT = 5;
const NETWORK_IDLE_TIMEOUT_MS = 3_000;

interface RenderFixture {
	html?: string;
	finalUrl?: string;
	errorCode?: string;
	errorMessage?: string;
	durationMs?: number;
	blockedRequestCount?: number;
	warnings?: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === 'string' ? value : undefined;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
	const value = record[key];
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringArrayField(record: Record<string, unknown>, key: string): string[] | undefined {
	const value = record[key];
	return Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? value : undefined;
}

function renderFixtureFromRecord(record: Record<string, unknown>): RenderFixture {
	return {
		html: stringField(record, 'html'),
		finalUrl: stringField(record, 'finalUrl'),
		errorCode: stringField(record, 'errorCode'),
		errorMessage: stringField(record, 'errorMessage'),
		durationMs: numberField(record, 'durationMs'),
		blockedRequestCount: numberField(record, 'blockedRequestCount'),
		warnings: stringArrayField(record, 'warnings'),
	};
}

function testFixturePath(): string | null {
	return process.env.NODE_ENV === 'test' ? (process.env.MULDER_URL_RENDERER_FIXTURE_FILE ?? null) : null;
}

async function readFixtureForUrl(url: URL): Promise<RenderFixture> {
	const fixturePath = testFixturePath();
	if (!fixturePath) {
		throw new MulderError('URL renderer fixture file is not configured for test mode', 'URL_RENDER_FIXTURE_MISSING');
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(fixturePath, 'utf-8'));
	} catch (cause: unknown) {
		throw new MulderError('URL renderer fixture file could not be read', 'URL_RENDER_FIXTURE_INVALID', {
			cause,
			context: { fixturePath },
		});
	}
	if (!isRecord(parsed)) {
		throw new MulderError('URL renderer fixture file must contain an object map', 'URL_RENDER_FIXTURE_INVALID', {
			context: { fixturePath },
		});
	}
	const candidate = parsed[url.toString()] ?? parsed[`${url.pathname}${url.search}`] ?? parsed[url.pathname];
	if (!isRecord(candidate)) {
		throw new MulderError('URL renderer fixture was not found for URL', 'URL_RENDER_FIXTURE_NOT_FOUND', {
			context: { url: url.toString(), fixturePath },
		});
	}
	return renderFixtureFromRecord(candidate);
}

class FixtureUrlRendererService implements UrlRendererService {
	async renderUrl(inputUrl: string, options: UrlRenderOptions): Promise<UrlRenderResult> {
		const normalizedUrl = normalizeUrlInput(inputUrl);
		const url = new URL(normalizedUrl);
		await validatePublicHttpTarget(url);
		const fixture = await readFixtureForUrl(url);
		if (fixture.errorCode) {
			throw new MulderError(fixture.errorMessage ?? 'URL renderer fixture failed', fixture.errorCode, {
				context: { url: normalizedUrl },
			});
		}
		if (!fixture.html) {
			throw new MulderError('URL renderer fixture did not include HTML', 'URL_RENDER_FIXTURE_INVALID', {
				context: { url: normalizedUrl },
			});
		}
		const html = Buffer.from(fixture.html, 'utf-8');
		if (html.length > options.maxBytes) {
			throw new MulderError('Rendered URL HTML exceeded maximum ingest size', 'URL_RENDER_TOO_LARGE', {
				context: { maxBytes: options.maxBytes, receivedBytes: html.length },
			});
		}
		const finalUrl = fixture.finalUrl ?? normalizedUrl;
		await validatePublicHttpTarget(new URL(finalUrl));
		return {
			html,
			finalUrl,
			renderedAt: new Date().toISOString(),
			durationMs: fixture.durationMs ?? 0,
			engine: 'fixture',
			blockedRequestCount: fixture.blockedRequestCount ?? 0,
			warnings: fixture.warnings ?? [],
		};
	}
}

function isMainFrameNavigation(request: Request, page: Page): boolean {
	return request.isNavigationRequest() && request.frame() === page.mainFrame();
}

function chromiumHostResolverArgs(target: VettedTarget): string[] {
	if (addressLiteralFromHostname(target.url.hostname)) {
		return [];
	}
	const [address] = target.addresses;
	if (!address) {
		return [];
	}
	const mappedAddress = address.family === 6 ? `[${address.address}]` : address.address;
	return [`--host-resolver-rules=MAP ${target.url.hostname} ${mappedAddress}`];
}

async function validateBrowserRequestUrl(requestUrl: string, allowedHostname: string): Promise<URL> {
	const url = new URL(requestUrl);
	url.hash = '';
	if (url.hostname.toLowerCase() !== allowedHostname) {
		throw new MulderError('URL render blocked cross-host browser request', 'URL_RENDER_CROSS_HOST_BLOCKED', {
			context: { url: url.toString(), allowedHostname },
		});
	}
	await validatePublicHttpTarget(url);
	return url;
}

class PlaywrightUrlRendererService implements UrlRendererService {
	async renderUrl(inputUrl: string, options: UrlRenderOptions): Promise<UrlRenderResult> {
		const normalizedUrl = normalizeUrlInput(inputUrl);
		const initialUrl = new URL(normalizedUrl);
		const initialTarget = await validatePublicHttpTarget(initialUrl);
		const allowedHostname = initialUrl.hostname.toLowerCase();
		const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		const redirectLimit = options.redirectLimit ?? DEFAULT_REDIRECT_LIMIT;
		const start = performance.now();
		let browser: Browser | null = null;
		let context: BrowserContext | null = null;
		let blockedRequestCount = 0;
		let mainFrameNavigationCount = 0;
		let mainFrameFailure: MulderError | null = null;
		const warnings: string[] = [];

		try {
			const { chromium } = await import('playwright');
			browser = await chromium.launch({ headless: true, args: chromiumHostResolverArgs(initialTarget) });
			context = await browser.newContext({
				acceptDownloads: false,
				javaScriptEnabled: true,
				userAgent: URL_USER_AGENT,
			});
			const page = await context.newPage();
			page.setDefaultTimeout(timeoutMs);
			page.setDefaultNavigationTimeout(timeoutMs);

			await context.route('**/*', async (route: Route, request: Request) => {
				try {
					await validateBrowserRequestUrl(request.url(), allowedHostname);
					if (isMainFrameNavigation(request, page)) {
						mainFrameNavigationCount++;
						if (mainFrameNavigationCount > redirectLimit + 1) {
							mainFrameFailure = new MulderError('URL render redirect limit exceeded', 'URL_RENDER_REDIRECT_LIMIT', {
								context: { url: normalizedUrl, redirectLimit },
							});
							blockedRequestCount++;
							await route.abort('blockedbyclient');
							return;
						}
					}
					await route.continue();
				} catch (cause: unknown) {
					blockedRequestCount++;
					if (isMainFrameNavigation(request, page)) {
						mainFrameFailure =
							cause instanceof MulderError
								? cause
								: new MulderError(
										'URL render main-frame request failed safety validation',
										'URL_RENDER_UNSAFE_TARGET',
										{
											cause,
											context: { url: request.url() },
										},
									);
					}
					await route.abort('blockedbyclient');
				}
			});

			try {
				await page.goto(normalizedUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
			} catch (cause: unknown) {
				throw (
					mainFrameFailure ??
					new MulderError('URL render navigation failed', 'URL_RENDER_NAVIGATION_FAILED', {
						cause,
						context: { url: normalizedUrl },
					})
				);
			}
			if (mainFrameFailure) {
				throw mainFrameFailure;
			}
			try {
				await page.waitForLoadState('networkidle', { timeout: Math.min(NETWORK_IDLE_TIMEOUT_MS, timeoutMs) });
			} catch {
				warnings.push('networkidle_timeout');
			}

			const finalUrl = page.url();
			await validatePublicHttpTarget(new URL(finalUrl));
			const html = Buffer.from(await page.content(), 'utf-8');
			if (html.length > options.maxBytes) {
				throw new MulderError('Rendered URL HTML exceeded maximum ingest size', 'URL_RENDER_TOO_LARGE', {
					context: { maxBytes: options.maxBytes, receivedBytes: html.length },
				});
			}

			return {
				html,
				finalUrl,
				renderedAt: new Date().toISOString(),
				durationMs: Math.round(performance.now() - start),
				engine: 'playwright-chromium',
				blockedRequestCount,
				warnings,
			};
		} catch (cause: unknown) {
			if (cause instanceof MulderError) {
				throw cause;
			}
			throw new MulderError('URL rendering failed', 'URL_RENDER_FAILED', {
				cause,
				context: { url: normalizedUrl },
			});
		} finally {
			await context?.close().catch(() => undefined);
			await browser?.close().catch(() => undefined);
		}
	}
}

export function createUrlRendererService(): UrlRendererService {
	return testFixturePath() ? new FixtureUrlRendererService() : new PlaywrightUrlRendererService();
}
