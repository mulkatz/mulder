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
const uploadFile = readOption('upload-file') ?? process.env.MULDER_SMOKE_UPLOAD_FILE;
const translateSmoke = (readOption('translate') ?? process.env.MULDER_SMOKE_TRANSLATE ?? 'false') === 'true';
const documentAiFile = readOption('document-ai-file') ?? process.env.MULDER_SMOKE_DOCUMENT_AI_FILE;
const documentAiSmoke = (readOption('document-ai') ?? process.env.MULDER_SMOKE_DOCUMENT_AI ?? 'false') === 'true';
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
			'  MULDER_SMOKE_UPLOAD_FILE=<optional-upload-file>',
			'  MULDER_SMOKE_TRANSLATE=true',
			'  MULDER_SMOKE_DOCUMENT_AI=true',
			'  MULDER_SMOKE_DOCUMENT_AI_FILE=<optional-document-ai-file>',
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

async function expectReaderHappyPath(sourceId) {
	await page.setViewportSize({ width: 1440, height: 1000 });
	await page.goto('/sources');
	await page.waitForLoadState('networkidle');
	await expectNoBrokenText('/sources');

	await page.goto(`/sources/${sourceId}`);
	await page.waitForLoadState('networkidle');
	await expectNoBrokenText('/sources/:id');

	await page.getByRole('button', { name: /original/i }).click();
	await expectNoBrokenText('/sources/:id original');

	const iframeCount = await page.locator('iframe').count();
	if (iframeCount !== 0) {
		throw new Error('Reader original pane must not render an iframe');
	}

	const renderedCanvasCount = await page.locator('canvas').count();
	const pdfErrorCount = await page
		.getByText(/Original PDF unavailable|Original PDF could not be loaded|PDF render failed/i)
		.count();
	if (renderedCanvasCount === 0 && pdfErrorCount === 0) {
		throw new Error('Reader original pane showed neither a rendered PDF canvas nor an honest PDF error state');
	}

	await page.getByRole('button', { name: /story/i }).click();
	await expectNoBrokenText('/sources/:id story');

	await page.setViewportSize({ width: 390, height: 860 });
	await page.goto(`/sources/${sourceId}`);
	await page.waitForLoadState('networkidle');
	const splitButtonCount = await page.getByRole('button', { name: /split/i }).count();
	if (splitButtonCount !== 0) {
		throw new Error('Split mode should be hidden on mobile-width reader');
	}
}

async function expectUploadSmoke(filePath) {
	await page.setViewportSize({ width: 1440, height: 1000 });
	await page.goto('/sources/add');
	await page.waitForLoadState('networkidle');
	await page.locator('#add-sources-files').setInputFiles(filePath);
	await page.locator('#add-sources-no-collection-confirmed').check();
	await page.locator('#add-sources-provenance-confirmed').check();
	await page.getByRole('button', { name: /upload/i }).click();
	await page.waitForLoadState('networkidle');

	const action = page.getByRole('link', { name: /open source|open processing/i }).first();
	await action.waitFor({ state: 'visible', timeout: 180_000 });
	await expectNoBrokenText('/sources/add upload');
}

async function expectTranslationSmoke(sourceId) {
	await page.setViewportSize({ width: 1440, height: 1000 });
	await page.goto(`/sources/${sourceId}`);
	await page.waitForLoadState('networkidle');
	await expectNoBrokenText('/sources/:id pre-translation');

	const translationButton = page.getByRole('button', { name: /translate|translate again/i }).first();
	if ((await translationButton.count()) > 0) {
		await translationButton.click();
		await page.waitForTimeout(750);
		await page.waitForLoadState('networkidle');
	}

	await page.getByRole('button', { name: /translated/i }).click({ timeout: 30_000 });
	await expectNoBrokenText('/sources/:id translated');
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
	const routes = ['/', '/sources', '/sources/add', '/evidence', '/runs'];

	for (const viewport of viewports) {
		for (const route of routes) {
			await visit(route, viewport);
		}
	}

	if (configuredSourceId) {
		await expectReaderHappyPath(configuredSourceId);
	}

	if (uploadFile) {
		await expectUploadSmoke(uploadFile);
	}

	if (translateSmoke) {
		if (!configuredSourceId) {
			throw new Error('Translation smoke requires MULDER_SMOKE_SOURCE_ID or --source-id.');
		}
		await expectTranslationSmoke(configuredSourceId);
	}

	if (documentAiSmoke) {
		if (!documentAiFile) {
			console.log('document_ai_smoke environment gap: set MULDER_SMOKE_DOCUMENT_AI_FILE to run the Document AI smoke.');
		} else {
			await expectUploadSmoke(documentAiFile);
		}
	}

	if (pageErrors.length > 0) {
		throw new Error(`Page errors:\n${pageErrors.join('\n')}`);
	}

	if (consoleErrors.length > 0) {
		throw new Error(`Unexpected console errors:\n${consoleErrors.join('\n')}`);
	}

	console.log(
		`app_smoke ok: ${routes.length} routes x ${viewports.length} viewports${configuredSourceId ? ' + reader source' : ''}${uploadFile ? ' + upload' : ''}${translateSmoke ? ' + translation' : ''}${documentAiSmoke ? ' + document-ai' : ''}`,
	);
} finally {
	await browser.close();
}
