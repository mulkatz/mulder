import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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

let server: Server;
let baseUrl = '';
let mutableArticleBody = 'Original immutable article paragraph for Spec 92 URL extraction.';
let pgAvailable = false;
let rawSnapshot: StorageSnapshot | null = null;
let extractedSnapshot: StorageSnapshot | null = null;
let segmentsSnapshot: StorageSnapshot | null = null;
let blockedPageRequests = 0;

function articleHtml(body: string): string {
	return `<!doctype html>
<html lang="en">
<head>
  <title>Spec 92 Article</title>
  <link rel="canonical" href="/canonical/spec-92-article">
  <meta property="og:site_name" content="Mulder Test Gazette">
  <meta name="author" content="Alice URL Reporter">
  <meta property="article:published_time" content="2026-05-01T12:00:00Z">
  <meta property="article:modified_time" content="2026-05-01T13:00:00Z">
</head>
<body>
  <article>
    <h1>Spec 92 Article</h1>
    <p>${body}</p>
    <p>This deterministic page contains enough readable prose for the static Readability parser to produce stable Markdown without network fixtures or JavaScript rendering.</p>
    <p>The story mentions URL ingestion, canonical metadata, byline hints, publication timestamps, and stable raw HTML snapshots.</p>
  </article>
</body>
</html>`;
}

function unreadableHtml(): string {
	return '<!doctype html><html><head><title>Shell</title></head><body><script>window.app = true;</script></body></html>';
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

async function runCli(
	args: string[],
	options: { timeout?: number; allowUnsafeUrls?: boolean } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		MULDER_CONFIG: EXAMPLE_CONFIG,
		MULDER_LOG_LEVEL: 'silent',
		NODE_ENV: 'test',
		PGPASSWORD: db.TEST_PG_PASSWORD,
	};
	if (options.allowUnsafeUrls ?? true) {
		env.MULDER_ALLOW_UNSAFE_URLS_FOR_TESTS = 'true';
	} else {
		delete env.MULDER_ALLOW_UNSAFE_URLS_FOR_TESTS;
	}
	return new Promise((resolveCli) => {
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

function latestUrlSourceId(): string {
	return db.runSql("SELECT id FROM sources WHERE source_type = 'url' ORDER BY created_at DESC LIMIT 1;");
}

function storyMarkdownForSource(sourceId: string): string {
	const uri = db.runSql(`SELECT gcs_markdown_uri FROM stories WHERE source_id = ${sqlLiteral(sourceId)} LIMIT 1;`);
	return readFileSync(resolve(STORAGE_DIR, uri), 'utf-8');
}

function storyMetadataForSource(sourceId: string): Record<string, unknown> {
	const uri = db.runSql(`SELECT gcs_metadata_uri FROM stories WHERE source_id = ${sqlLiteral(sourceId)} LIMIT 1;`);
	return JSON.parse(readFileSync(resolve(STORAGE_DIR, uri), 'utf-8')) as Record<string, unknown>;
}

beforeAll(async () => {
	server = createServer((request, response) => {
		const url = request.url ?? '/';
		if (url === '/robots.txt') {
			response.writeHead(302, { location: '/robots-final.txt' });
			response.end();
			return;
		}
		if (url === '/robots-final.txt') {
			response.writeHead(200, { 'content-type': 'text/plain' });
			response.end(['User-agent: MulderUrlFetcher', 'Disallow: /blocked', 'Allow: /'].join('\n'));
			return;
		}
		if (url === '/article') {
			response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', etag: '"spec-92"' });
			response.end(articleHtml(mutableArticleBody));
			return;
		}
		if (url === '/redirect') {
			response.writeHead(302, { location: '/article' });
			response.end();
			return;
		}
		if (url === '/redirect-blocked') {
			response.writeHead(302, { location: '/blocked' });
			response.end();
			return;
		}
		if (url === '/blocked') {
			blockedPageRequests++;
			response.writeHead(200, { 'content-type': 'text/html' });
			response.end(articleHtml('Robots should prevent this page from being fetched.'));
			return;
		}
		if (url === '/plain') {
			response.writeHead(200, { 'content-type': 'text/plain' });
			response.end('not html');
			return;
		}
		if (url === '/oversized') {
			response.writeHead(200, { 'content-type': 'text/html', 'content-length': String(200 * 1024 * 1024) });
			response.end();
			return;
		}
		if (url === '/unreadable') {
			response.writeHead(200, { 'content-type': 'text/html' });
			response.end(unreadableHtml());
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
	mutableArticleBody = 'Original immutable article paragraph for Spec 92 URL extraction.';
	blockedPageRequests = 0;
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

describe('Spec 92 — URL Ingestion on the Pre-Structured Path', () => {
	it('QA-01/04: CLI dry-run accepts safe test URLs and rejects loopback without override', async () => {
		const accepted = await runCli(['ingest', '--dry-run', `${baseUrl}/article`]);
		expect(accepted.exitCode, `${accepted.stdout}\n${accepted.stderr}`).toBe(0);
		expect(accepted.stdout).toContain('Type');
		expect(accepted.stdout).toMatch(/\burl\b/);
		expect(accepted.stdout).toMatch(/\b0\b/);
		if (pgAvailable) {
			expect(db.runSql("SELECT COUNT(*) FROM sources WHERE source_type = 'url';")).toBe('0');

			const pipelineDryRun = await runCli(['pipeline', 'run', `${baseUrl}/article`, '--dry-run']);
			expect(pipelineDryRun.exitCode, `${pipelineDryRun.stdout}\n${pipelineDryRun.stderr}`).toBe(0);
			expect(`${pipelineDryRun.stdout}\n${pipelineDryRun.stderr}`).toMatch(/Sources to process:\s*1/i);
			expect(`${pipelineDryRun.stdout}\n${pipelineDryRun.stderr}`).toMatch(/\(url\)/i);
			expect(`${pipelineDryRun.stdout}\n${pipelineDryRun.stderr}`).toMatch(/skipped\s+segment/i);
			expect(db.runSql("SELECT COUNT(*) FROM sources WHERE source_type = 'url';")).toBe('0');

			const blockedBefore = blockedPageRequests;
			const blockedPipelineDryRun = await runCli(['pipeline', 'run', `${baseUrl}/redirect-blocked`, '--dry-run']);
			expect(blockedPipelineDryRun.exitCode).not.toBe(0);
			expect(`${blockedPipelineDryRun.stdout}\n${blockedPipelineDryRun.stderr}`).toMatch(
				/robots|URL fetch|validation/i,
			);
			expect(blockedPageRequests).toBe(blockedBefore);
			expect(db.runSql("SELECT COUNT(*) FROM sources WHERE source_type = 'url';")).toBe('0');
		}

		const rejected = await runCli(['ingest', '--dry-run', `${baseUrl}/article`], { allowUnsafeUrls: false });
		expect(rejected.exitCode).not.toBe(0);
		expect(`${rejected.stdout}\n${rejected.stderr}`).toMatch(/unsafe|localhost|URL fetch/i);
	});

	it('QA-02/03/07: URL ingest persists raw HTML snapshot metadata and deduplicates by snapshot hash', async () => {
		if (!pgAvailable) return;

		const ingest = await runCli(['ingest', `${baseUrl}/redirect`]);
		expect(ingest.exitCode, `${ingest.stdout}\n${ingest.stderr}`).toBe(0);
		const sourceId = latestUrlSourceId();
		const row = db
			.runSql(
				`SELECT source_type::text, page_count, has_native_text, native_text_ratio, storage_path, format_metadata->>'original_url', format_metadata->>'final_url', format_metadata->>'http_status', format_metadata->>'robots_allowed', format_metadata->>'redirect_count', format_metadata->>'parser_engine' FROM sources WHERE id = ${sqlLiteral(sourceId)};`,
			)
			.split('|');
		expect(row).toEqual([
			'url',
			'0',
			'f',
			'0',
			`raw/${sourceId}/original.html`,
			`${baseUrl}/redirect`,
			`${baseUrl}/article`,
			'200',
			'true',
			'1',
			'mozilla-readability-jsdom-turndown',
		]);
		const rawHtml = readFileSync(resolve(STORAGE_DIR, `raw/${sourceId}/original.html`), 'utf-8');
		expect(rawHtml).toContain('Original immutable article paragraph');

		const duplicate = await runCli(['ingest', `${baseUrl}/article`]);
		expect(duplicate.exitCode, `${duplicate.stdout}\n${duplicate.stderr}`).toBe(0);
		expect(duplicate.stdout).toMatch(/duplicate/i);
		expect(db.runSql("SELECT COUNT(*) FROM sources WHERE source_type = 'url';")).toBe('1');
	});

	it('QA-05/06: URL ingest rejects robots-disallowed, non-HTML, and oversized responses before source creation', async () => {
		if (!pgAvailable) return;

		for (const path of ['/blocked', '/redirect-blocked', '/plain', '/oversized']) {
			const blockedBefore = blockedPageRequests;
			const result = await runCli(['ingest', `${baseUrl}${path}`]);
			expect(result.exitCode, `${path}\n${result.stdout}\n${result.stderr}`).not.toBe(0);
			expect(`${result.stdout}\n${result.stderr}`).toMatch(/URL|robots|content type|size|HTML/i);
			expect(db.runSql("SELECT COUNT(*) FROM sources WHERE source_type = 'url';")).toBe('0');
			if (path === '/blocked' || path === '/redirect-blocked') {
				expect(blockedPageRequests).toBe(blockedBefore);
			}
		}
	});

	it('QA-04: URL fetch rejects IPv4-mapped IPv6 DNS answers before fetch', async () => {
		for (const mappedAddress of ['::ffff:127.0.0.1', '::ffff:10.0.0.1']) {
			const fetchCalls: string[] = [];
			vi.doMock('node:dns/promises', () => ({
				lookup: vi.fn(async () => [{ address: mappedAddress, family: 6 }]),
			}));
			vi.stubGlobal(
				'fetch',
				vi.fn((input: string | URL | Request) => {
					fetchCalls.push(String(input));
					return Promise.resolve(new Response(articleHtml('Unexpected fetch'), { status: 200 }));
				}),
			);
			vi.resetModules();
			try {
				const moduleUrl = `${
					pathToFileURL(resolve(CORE_DIR, 'dist/shared/url-fetcher.js')).href
				}?mapped-ipv6=${encodeURIComponent(mappedAddress)}`;
				const fetcherModule: typeof import('../../packages/core/dist/shared/url-fetcher.js') = await import(moduleUrl);
				await expect(
					fetcherModule.createUrlFetcherService().fetchUrl('https://mapped-unsafe.example/article', {
						maxBytes: 1024,
						timeoutMs: 100,
						redirectLimit: 0,
					}),
				).rejects.toMatchObject({ code: 'URL_UNSAFE_TARGET' });
				expect(fetchCalls).toEqual([]);
				if (pgAvailable) {
					expect(db.runSql("SELECT COUNT(*) FROM sources WHERE source_type = 'url';")).toBe('0');
				}
			} finally {
				vi.unstubAllGlobals();
				vi.doUnmock('node:dns/promises');
				vi.resetModules();
			}
		}
	});

	it('QA-08/09/10: URL extract creates one readable story with URL hints and fails unreadable shells clearly', async () => {
		if (!pgAvailable) return;

		const ingest = await runCli(['ingest', `${baseUrl}/article`]);
		expect(ingest.exitCode, `${ingest.stdout}\n${ingest.stderr}`).toBe(0);
		const sourceId = latestUrlSourceId();
		mutableArticleBody = 'Changed server content that must not appear in extracted snapshot output.';

		const extract = await runCli(['extract', sourceId]);
		expect(extract.exitCode, `${extract.stdout}\n${extract.stderr}`).toBe(0);
		expect(db.runSql(`SELECT status FROM sources WHERE id = ${sqlLiteral(sourceId)};`)).toBe('extracted');
		expect(db.runSql(`SELECT COUNT(*) FROM stories WHERE source_id = ${sqlLiteral(sourceId)};`)).toBe('1');
		expect(
			db.runSql(`SELECT status FROM source_steps WHERE source_id = ${sqlLiteral(sourceId)} AND step_name = 'extract';`),
		).toBe('completed');
		expect(existsSync(resolve(STORAGE_DIR, `extracted/${sourceId}/layout.json`))).toBe(false);

		const markdown = storyMarkdownForSource(sourceId);
		expect(markdown).toContain('# Spec 92 Article');
		expect(markdown).toContain('Original immutable article paragraph');
		expect(markdown).not.toContain('Changed server content');
		expect(markdown).toContain('## URL Entity Hints');
		expect(markdown).toContain('Alice URL Reporter');
		expect(markdown).toContain('Mulder Test Gazette');

		const metadata = storyMetadataForSource(sourceId);
		expect(metadata.source_type).toBe('url');
		expect(metadata.canonical_url).toBe(`${baseUrl}/canonical/spec-92-article`);
		expect(metadata.byline).toBe('Alice URL Reporter');
		expect(metadata.site_name).toBe('Mulder Test Gazette');
		expect(Array.isArray(metadata.entity_hints)).toBe(true);

		cleanState();
		resetStorage();
		const unreadableIngest = await runCli(['ingest', `${baseUrl}/unreadable`]);
		expect(unreadableIngest.exitCode, `${unreadableIngest.stdout}\n${unreadableIngest.stderr}`).toBe(0);
		const unreadableSourceId = latestUrlSourceId();
		const unreadableExtract = await runCli(['extract', unreadableSourceId]);
		expect(unreadableExtract.exitCode).not.toBe(0);
		expect(`${unreadableExtract.stdout}\n${unreadableExtract.stderr}`).toMatch(/URL extraction|readable|unreadable/i);
		expect(db.runSql(`SELECT COUNT(*) FROM stories WHERE source_id = ${sqlLiteral(unreadableSourceId)};`)).toBe('0');
	});

	it('QA-11: pipeline run records segment skipped for URL sources after extract', async () => {
		if (!pgAvailable) return;

		const ingest = await runCli(['ingest', `${baseUrl}/article`]);
		expect(ingest.exitCode, `${ingest.stdout}\n${ingest.stderr}`).toBe(0);
		const sourceId = latestUrlSourceId();
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
