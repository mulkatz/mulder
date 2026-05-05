#!/usr/bin/env node

import { chromium } from '@playwright/test';

function readOption(name) {
	const prefixed = `--${name}=`;
	const index = process.argv.indexOf(`--${name}`);
	if (index >= 0) {
		return process.argv[index + 1];
	}

	const inline = process.argv.find((arg) => arg.startsWith(prefixed));
	return inline ? inline.slice(prefixed.length) : undefined;
}

function normalizeBaseUrl(value) {
	return value.endsWith('/') ? value.slice(0, -1) : value;
}

const appUrl = normalizeBaseUrl(readOption('app-url') ?? process.env.MULDER_APP_URL ?? 'http://127.0.0.1:5174');
const email = readOption('email') ?? process.env.MULDER_SMOKE_EMAIL;
const password = readOption('password') ?? process.env.MULDER_SMOKE_PASSWORD;
const configuredSourceId = readOption('source-id') ?? process.env.MULDER_SMOKE_SOURCE_ID;
const sourceId = configuredSourceId ?? '00000000-0000-4000-8000-000000000301';
const headless = (process.env.MULDER_PLAYWRIGHT_HEADLESS ?? 'true') !== 'false';

if (!email || !password) {
	console.error(
		[
			'Usage: pnpm smoke:app -- --email user@example.test --password <password>',
			'',
			'Environment alternatives:',
			'  MULDER_APP_URL=http://127.0.0.1:5174',
			'  MULDER_SMOKE_EMAIL=user@example.test',
			'  MULDER_SMOKE_PASSWORD=<password>',
			'  MULDER_SMOKE_SOURCE_ID=<optional-source-id>',
		].join('\n'),
	);
	process.exit(2);
}

const browser = await chromium.launch({ headless });
const context = await browser.newContext({ baseURL: appUrl });
const page = await context.newPage();
const pageErrors = [];
const consoleErrors = [];

function isExpectedConsoleError(text) {
	if (/status of 401 \(Unauthorized\)/.test(text)) {
		return true;
	}

	if (!configuredSourceId && (/status of 404/.test(text) || /X-Frame-Options.*deny/i.test(text))) {
		return true;
	}

	return false;
}

page.on('pageerror', (error) => {
	pageErrors.push(error.message);
});
page.on('console', (message) => {
	if (message.type() === 'error' && !isExpectedConsoleError(message.text())) {
		consoleErrors.push(message.text());
	}
});

async function expectNoBrokenText(route) {
	const bodyText = await page.locator('body').innerText();
	if (!bodyText.trim()) {
		throw new Error(`${route} rendered an empty body`);
	}
	if (/\b(undefined|NaN)\b/.test(bodyText)) {
		throw new Error(`${route} rendered a broken placeholder`);
	}
}

async function visit(route, viewport) {
	await page.setViewportSize(viewport);
	await page.goto(route);
	await page.waitForLoadState('networkidle');
	await expectNoBrokenText(route);
}

try {
	await page.addInitScript(() => {
		try {
			window.localStorage.setItem('mulder.locale', 'en');
		} catch {
			// Some embedded documents do not expose localStorage. The app shell still handles locale normally.
		}
	});

	await page.goto('/login');
	await page.locator('#email').fill(email);
	await page.locator('#password').fill(password);
	await page.locator('button[type="submit"]').click();
	await page.waitForURL((url) => url.pathname !== '/login', { timeout: 10_000 });
	await page.waitForLoadState('networkidle');

	const viewports = [
		{ width: 1440, height: 1000 },
		{ width: 1024, height: 900 },
		{ width: 390, height: 860 },
	];
	const routes = ['/', '/sources', `/sources/${sourceId}`, '/evidence', '/runs'];

	for (const viewport of viewports) {
		for (const route of routes) {
			await visit(route, viewport);
		}
	}

	await page.setViewportSize({ width: 1440, height: 1000 });
	await page.goto(`/sources/${sourceId}`);
	await page.waitForLoadState('networkidle');
	await page.getByRole('button', { name: /original/i }).click();
	await expectNoBrokenText('/sources/:id original');
	await page.getByRole('button', { name: /story/i }).click();
	await expectNoBrokenText('/sources/:id story');

	await page.setViewportSize({ width: 390, height: 860 });
	await page.goto(`/sources/${sourceId}`);
	await page.waitForLoadState('networkidle');
	const splitButtonCount = await page.getByRole('button', { name: /split/i }).count();
	if (splitButtonCount !== 0) {
		throw new Error('Split mode should be hidden on mobile-width reader');
	}

	if (pageErrors.length > 0) {
		throw new Error(`Page errors:\n${pageErrors.join('\n')}`);
	}

	if (consoleErrors.length > 0) {
		throw new Error(`Unexpected console errors:\n${consoleErrors.join('\n')}`);
	}

	console.log(`app_smoke ok: ${routes.length} routes x ${viewports.length} viewports`);
} finally {
	await browser.close();
}
