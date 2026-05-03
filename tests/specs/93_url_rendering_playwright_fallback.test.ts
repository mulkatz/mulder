import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as db from '../lib/db.js';
import { cleanStorageDirSince, type StorageSnapshot, snapshotStorageDir } from '../lib/storage.js';

const ROOT = resolve(import.meta.dirname, '../..');
const CORE_DIR = resolve(ROOT, 'packages/core');
const PIPELINE_DIR = resolve(ROOT, 'packages/pipeline');
const CLI_DIR = resolve(ROOT, 'apps/cli');
const CLI_DIST = resolve(CLI_DIR, 'dist/index.js');
const EXAMPLE_CONFIG = resolve(ROOT, 'mulder.config.example.yaml');
const STORAGE_DIR = resolve(ROOT, '.local/storage');
const RAW_STORAGE_DIR = resolve(STORAGE_DIR, 'raw');
const EXTRACTED_STORAGE_DIR = resolve(STORAGE_DIR, 'extracted');
const SEGMENTS_STORAGE_DIR = resolve(STORAGE_DIR, 'segments');
const RENDER_FIXTURE_FILE = resolve(ROOT, '.local/spec-93-url-render-fixtures.json');

let server: Server;
let baseUrl = '';
let pgAvailable = false;
let rawSnapshot: StorageSnapshot | null = null;
let extractedSnapshot: StorageSnapshot | null = null;
let segmentsSnapshot: StorageSnapshot | null = null;
let renderedArticleBody = 'Rendered immutable article body for Spec 93 URL rendering fallback.';

function articleHtml(body: string): string {
	return `<!doctype html>
	<html lang="en">
	<head>
	  <title>Spec 93 Rendered Article</title>
	  <link rel="canonical" href="/canonical/spec-93-rendered-article">
	  <meta property="og:site_name" content="Mulder Render Gazette">
	  <meta name="author" content="Riley Render Reporter">
	  <meta property="article:published_time" content="2026-05-03T10:00:00Z">
	</head>
	<body>
	  <article>
	    <h1>Spec 93 Rendered Article</h1>
	    <p>${body}</p>
	    <p>This rendered page contains enough deterministic readable prose for Readability to create stable Markdown after a JavaScript shell fallback.</p>
	    <p>The content proves that Mulder stores rendered DOM HTML as the immutable URL snapshot and reuses the normal pre-structured URL extract path.</p>
	  </article>
	</body>
	</html>`;
}

function staticArticleHtml(): string {
	return `<!doctype html>
	<html><head><title>Spec 93 Static Article</title></head>
	<body><article>
	  <h1>Spec 93 Static Article</h1>
	  <p>This static article contains enough readable prose to avoid Playwright fallback entirely during URL ingestion.</p>
	  <p>The renderer fixture intentionally has no entry for this path, so invoking it would fail the test.</p>
	  <p>Static URL ingestion should remain the fast path for normal server-rendered HTML pages.</p>
	</article></body></html>`;
}

function shellHtml(): string {
	return '<!doctype html><html><head><title>Spec 93 Shell</title></head><body><div id="app"></div><script>window.__APP__ = true;</script></body></html>';
}

function writeRenderFixtures(): void {
	const rendered = articleHtml(renderedArticleBody);
	writeFileSync(
		RENDER_FIXTURE_FILE,
		JSON.stringify(
			{
				'/js-shell': {
					html: rendered,
					finalUrl: `${baseUrl}/js-shell`,
					durationMs: 12,
					blockedRequestCount: 1,
					warnings: ['blocked_tracking_pixel'],
				},
				'/js-shell-copy': {
					html: rendered,
					finalUrl: `${baseUrl}/js-shell-copy`,
					durationMs: 8,
					blockedRequestCount: 0,
				},
				'/render-unreadable': {
					html: '<!doctype html><html><head><title>Still Shell</title></head><body><script>1</script></body></html>',
					finalUrl: `${baseUrl}/render-unreadable`,
				},
				'/render-timeout': {
					errorCode: 'URL_RENDER_TIMEOUT',
					errorMessage: 'fixture render timed out',
				},
				'/render-credentialed-final': {
					html: rendered,
					finalUrl: 'https://user:pass@example.com/rendered',
				},
			},
			null,
			2,
		),
	);
}

function buildPackage(packageDir: string): void {
	const result = spawnSync('pnpm', ['build'], {
		cwd: packageDir,
		stdio: ['ignore', 'pipe', 'pipe'],
		env: { ...process.env, MULDER_LOG_LEVEL: 'silent' },
	});
	if ((result.status ?? 1) !== 0) {
		throw new Error(
			`Build failed in ${packageDir}:\n${result.stdout?.toString() ?? ''}\n${result.stderr?.toString() ?? ''}`,
		);
	}
}

async function runCli(args: string[], options: { timeout?: number; allowUnsafeUrls?: boolean } = {}) {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		MULDER_CONFIG: EXAMPLE_CONFIG,
		MULDER_LOG_LEVEL: 'silent',
		MULDER_URL_RENDERER_FIXTURE_FILE: RENDER_FIXTURE_FILE,
		NODE_ENV: 'test',
		PGPASSWORD: db.TEST_PG_PASSWORD,
	};
	if (options.allowUnsafeUrls ?? true) {
		env.MULDER_ALLOW_UNSAFE_URLS_FOR_TESTS = 'true';
	} else {
		delete env.MULDER_ALLOW_UNSAFE_URLS_FOR_TESTS;
	}
	return new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolveCli) => {
		const child = spawn('node', [CLI_DIST, ...args], {
			cwd: ROOT,
			stdio: ['ignore', 'pipe', 'pipe'],
			env,
		});
		let stdout = '';
		let stderr = '';
		const timeout = setTimeout(() => {
			child.kill('SIGTERM');
		}, options.timeout ?? 180_000);
		child.stdout.setEncoding('utf-8');
		child.stderr.setEncoding('utf-8');
		child.stdout.on('data', (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.on('data', (chunk: string) => {
			stderr += chunk;
		});
		child.on('close', (code) => {
			clearTimeout(timeout);
			resolveCli({ stdout, stderr, exitCode: code ?? 1 });
		});
	});
}

function cleanState(): void {
	db.runSql(
		[
			'DELETE FROM monthly_budget_reservations',
			'DELETE FROM jobs',
			'DELETE FROM pipeline_run_sources',
			'DELETE FROM pipeline_runs',
			'DELETE FROM source_steps',
			'DELETE FROM chunks',
			'DELETE FROM story_entities',
			'DELETE FROM entity_edges',
			'DELETE FROM entity_aliases',
			'DELETE FROM entities',
			'DELETE FROM stories',
			'DELETE FROM sources',
		].join('; '),
	);
}

function resetStorage(): void {
	for (const snapshot of [rawSnapshot, extractedSnapshot, segmentsSnapshot]) {
		if (snapshot) {
			cleanStorageDirSince(snapshot);
		}
	}
}

function sqlLiteral(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

function sourceIdForOriginalUrl(url: string): string {
	return db.runSql(`SELECT id FROM sources WHERE format_metadata->>'original_url' = ${sqlLiteral(url)} LIMIT 1;`);
}

function storyMarkdownForSource(sourceId: string): string {
	const uri = db.runSql(`SELECT gcs_markdown_uri FROM stories WHERE source_id = ${sqlLiteral(sourceId)} LIMIT 1;`);
	return readFileSync(resolve(STORAGE_DIR, uri), 'utf-8');
}

beforeAll(async () => {
	server = createServer((request, response) => {
		const url = request.url ?? '/';
		if (url === '/robots.txt') {
			response.writeHead(200, { 'content-type': 'text/plain' });
			response.end('User-agent: *\nAllow: /');
			return;
		}
		if (url === '/static-article') {
			response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
			response.end(staticArticleHtml());
			return;
		}
		if (
			url === '/js-shell' ||
			url === '/js-shell-copy' ||
			url === '/render-unreadable' ||
			url === '/render-timeout' ||
			url === '/render-credentialed-final'
		) {
			response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
			response.end(shellHtml());
			return;
		}
		response.writeHead(404, { 'content-type': 'text/plain' });
		response.end('not found');
	});
	await new Promise<void>((resolveServer) => {
		server.listen(0, '127.0.0.1', resolveServer);
	});
	const address = server.address();
	if (typeof address === 'object' && address) {
		baseUrl = `http://127.0.0.1:${address.port}`;
	}
	writeRenderFixtures();

	rawSnapshot = snapshotStorageDir(RAW_STORAGE_DIR);
	extractedSnapshot = snapshotStorageDir(EXTRACTED_STORAGE_DIR);
	segmentsSnapshot = snapshotStorageDir(SEGMENTS_STORAGE_DIR);

	buildPackage(CORE_DIR);
	buildPackage(PIPELINE_DIR);
	buildPackage(CLI_DIR);

	pgAvailable = db.isPgAvailable();
	if (pgAvailable) {
		const migrate = await runCli(['db', 'migrate', EXAMPLE_CONFIG]);
		expect(migrate.exitCode, `${migrate.stdout}\n${migrate.stderr}`).toBe(0);
	}
}, 600_000);

beforeEach(() => {
	renderedArticleBody = 'Rendered immutable article body for Spec 93 URL rendering fallback.';
	writeRenderFixtures();
	if (!pgAvailable) return;
	cleanState();
	resetStorage();
});

afterAll(async () => {
	try {
		if (pgAvailable) {
			cleanState();
			resetStorage();
		}
	} catch {
		// Ignore cleanup failures.
	}
	await new Promise<void>((resolveServer) => {
		server.close(() => resolveServer());
	});
});

describe('Spec 93 — URL Rendering Playwright Fallback', () => {
	it('QA-01/07: static readable URLs avoid rendering and dry-run stays non-persistent', async () => {
		const dryRun = await runCli(['ingest', '--dry-run', `${baseUrl}/static-article`]);
		expect(dryRun.exitCode, `${dryRun.stdout}\n${dryRun.stderr}`).toBe(0);
		expect(dryRun.stdout).toMatch(/\burl\b/);
		expect(dryRun.stdout).toMatch(/\b0\b/);
		if (pgAvailable) {
			expect(db.runSql("SELECT COUNT(*) FROM sources WHERE source_type = 'url';")).toBe('0');
		}

		if (!pgAvailable) return;
		const ingest = await runCli(['ingest', `${baseUrl}/static-article`]);
		expect(ingest.exitCode, `${ingest.stdout}\n${ingest.stderr}`).toBe(0);
		const sourceId = sourceIdForOriginalUrl(`${baseUrl}/static-article`);
		const row = db
			.runSql(
				`SELECT format_metadata->>'rendering_method', format_metadata->>'rendering_engine', format_metadata->>'title' FROM sources WHERE id = ${sqlLiteral(sourceId)};`,
			)
			.split('|');
		expect(row[0]).toBe('static');
		expect(row[1]).toBe('');
		expect(row[2]).toContain('Spec 93 Static Article');
	});

	it('QA-02/07/08: JavaScript shells render before source creation and deduplicate by rendered hash', async () => {
		const dryRun = await runCli(['ingest', '--dry-run', `${baseUrl}/js-shell`]);
		expect(dryRun.exitCode, `${dryRun.stdout}\n${dryRun.stderr}`).toBe(0);
		expect(dryRun.stdout).toMatch(/\burl\b/);
		expect(dryRun.stdout).toMatch(/\b0\b/);
		if (pgAvailable) {
			expect(db.runSql("SELECT COUNT(*) FROM sources WHERE source_type = 'url';")).toBe('0');
		}

		if (!pgAvailable) return;
		const ingest = await runCli(['ingest', `${baseUrl}/js-shell`]);
		expect(ingest.exitCode, `${ingest.stdout}\n${ingest.stderr}`).toBe(0);
		const sourceId = sourceIdForOriginalUrl(`${baseUrl}/js-shell`);
		const row = db
			.runSql(
				`SELECT source_type::text, storage_path, format_metadata->>'rendering_method', format_metadata->>'rendering_engine', format_metadata->>'render_fallback_reason', format_metadata->>'blocked_render_request_count' FROM sources WHERE id = ${sqlLiteral(sourceId)};`,
			)
			.split('|');
		expect(row).toEqual(['url', `raw/${sourceId}/original.html`, 'playwright', 'fixture', 'static_unreadable', '1']);
		const rawHtml = readFileSync(resolve(STORAGE_DIR, `raw/${sourceId}/original.html`), 'utf-8');
		expect(rawHtml).toContain('Rendered immutable article body');
		expect(rawHtml).not.toContain('<div id="app"></div>');

		const duplicate = await runCli(['ingest', `${baseUrl}/js-shell-copy`]);
		expect(duplicate.exitCode, `${duplicate.stdout}\n${duplicate.stderr}`).toBe(0);
		expect(duplicate.stdout).toMatch(/duplicate/i);
		expect(db.runSql("SELECT COUNT(*) FROM sources WHERE source_type = 'url';")).toBe('1');
	});

	it('QA-03/04: extract uses the stored rendered snapshot and creates one pre-structured story', async () => {
		if (!pgAvailable) return;
		const ingest = await runCli(['ingest', `${baseUrl}/js-shell`]);
		expect(ingest.exitCode, `${ingest.stdout}\n${ingest.stderr}`).toBe(0);
		const sourceId = sourceIdForOriginalUrl(`${baseUrl}/js-shell`);
		renderedArticleBody = 'Changed rendered fixture body that must not appear after ingest.';
		writeRenderFixtures();

		const extract = await runCli(['extract', sourceId]);
		expect(extract.exitCode, `${extract.stdout}\n${extract.stderr}`).toBe(0);
		expect(db.runSql(`SELECT status FROM sources WHERE id = ${sqlLiteral(sourceId)};`)).toBe('extracted');
		expect(db.runSql(`SELECT COUNT(*) FROM stories WHERE source_id = ${sqlLiteral(sourceId)};`)).toBe('1');
		expect(
			db.runSql(`SELECT status FROM source_steps WHERE source_id = ${sqlLiteral(sourceId)} AND step_name = 'extract';`),
		).toBe('completed');
		expect(existsSync(resolve(STORAGE_DIR, `extracted/${sourceId}/layout.json`))).toBe(false);
		const markdown = storyMarkdownForSource(sourceId);
		expect(markdown).toContain('Rendered immutable article body');
		expect(markdown).not.toContain('Changed rendered fixture body');
		expect(markdown).toContain('| Rendering | playwright |');
		expect(markdown).toContain('| Renderer | fixture |');
	});

	it('QA-05/06: unsafe render results, render failures, and unreadable rendered HTML do not create sources', async () => {
		if (!pgAvailable) return;
		for (const path of ['/render-credentialed-final', '/render-timeout', '/render-unreadable']) {
			const result = await runCli(['ingest', `${baseUrl}${path}`]);
			expect(result.exitCode, `${path}\n${result.stdout}\n${result.stderr}`).not.toBe(0);
			expect(`${result.stdout}\n${result.stderr}`).toMatch(/URL render|rendered|credential|readable|timeout/i);
			expect(db.runSql("SELECT COUNT(*) FROM sources WHERE source_type = 'url';")).toBe('0');
		}
	});

	it('QA-09: pipeline records segment skipped for rendered URL sources', async () => {
		if (!pgAvailable) return;
		const ingest = await runCli(['ingest', `${baseUrl}/js-shell`]);
		expect(ingest.exitCode, `${ingest.stdout}\n${ingest.stderr}`).toBe(0);
		const sourceId = sourceIdForOriginalUrl(`${baseUrl}/js-shell`);
		const pipeline = await runCli(
			['pipeline', 'run', '--from', 'extract', '--up-to', 'enrich', '--source-id', sourceId],
			{
				timeout: 240_000,
			},
		);
		expect(pipeline.exitCode, `${pipeline.stdout}\n${pipeline.stderr}`).toBe(0);
		expect(
			db.runSql(`SELECT status FROM source_steps WHERE source_id = ${sqlLiteral(sourceId)} AND step_name = 'segment';`),
		).toBe('skipped');
		expect(existsSync(resolve(STORAGE_DIR, `extracted/${sourceId}/layout.json`))).toBe(false);
	});
});
