import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as db from '../lib/db.js';
import { cleanStorageDirSince, type StorageSnapshot, snapshotStorageDir, testStoragePath } from '../lib/storage.js';

const ROOT = resolve(import.meta.dirname, '../..');
const CORE_DIR = resolve(ROOT, 'packages/core');
const PIPELINE_DIR = resolve(ROOT, 'packages/pipeline');
const CLI_DIR = resolve(ROOT, 'apps/cli');
const CLI_DIST = resolve(CLI_DIR, 'dist/index.js');
const EXAMPLE_CONFIG = resolve(ROOT, 'mulder.config.example.yaml');
const STORAGE_DIR = testStoragePath();
const RAW_STORAGE_DIR = resolve(STORAGE_DIR, 'raw');
const EXTRACTED_STORAGE_DIR = resolve(STORAGE_DIR, 'extracted');
const SEGMENTS_STORAGE_DIR = resolve(STORAGE_DIR, 'segments');
const SOURCE_ID_TEXT = '00000000-0000-0000-0000-000000009410';

let server: Server;
let baseUrl = '';
let pgAvailable = false;
let rawSnapshot: StorageSnapshot | null = null;
let extractedSnapshot: StorageSnapshot | null = null;
let segmentsSnapshot: StorageSnapshot | null = null;
let articleBody = 'Initial lifecycle article body for Spec 94 URL freshness tracking.';
let articleEtag = '"spec-94-v1"';
let articleLastModified = 'Mon, 04 May 2026 08:00:00 GMT';
let robotsDisallowArticle = false;
let lastIfNoneMatch: string | null = null;
let lastIfModifiedSince: string | null = null;

function articleHtml(body: string): string {
	return `<!doctype html>
<html lang="en">
<head>
  <title>Spec 94 Lifecycle Article</title>
  <meta name="author" content="Uma URL Lifecycle">
</head>
<body>
  <article>
    <h1>Spec 94 Lifecycle Article</h1>
    <p>${body}</p>
    <p>This deterministic page has enough readable text for Readability extraction and stable URL lifecycle assertions.</p>
    <p>The page mentions freshness, robots decisions, conditional requests, and explicit source re-fetch behavior.</p>
  </article>
</body>
</html>`;
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

async function runCli(args: string[], options: { timeout?: number } = {}) {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		MULDER_CONFIG: EXAMPLE_CONFIG,
		MULDER_LOG_LEVEL: 'silent',
		MULDER_ALLOW_UNSAFE_URLS_FOR_TESTS: 'true',
		MULDER_URL_POLITENESS_DELAY_MS: '0',
		NODE_ENV: 'test',
		PGPASSWORD: db.TEST_PG_PASSWORD,
	};
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
			'DELETE FROM url_lifecycle',
			'DELETE FROM url_host_lifecycle',
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

function sourceIdForArticle(): string {
	return db.runSql(
		`SELECT id FROM sources WHERE format_metadata->>'original_url' = ${sqlLiteral(`${baseUrl}/article`)} LIMIT 1;`,
	);
}

function rawHtmlForSource(sourceId: string): string {
	return readFileSync(resolve(STORAGE_DIR, `raw/${sourceId}/original.html`), 'utf-8');
}

async function ingestArticle(): Promise<string> {
	const ingest = await runCli(['ingest', `${baseUrl}/article`]);
	expect(ingest.exitCode, `${ingest.stdout}\n${ingest.stderr}`).toBe(0);
	return sourceIdForArticle();
}

beforeAll(async () => {
	server = createServer((request, response) => {
		const url = request.url ?? '/';
		if (url === '/robots.txt') {
			response.writeHead(200, { 'content-type': 'text/plain' });
			response.end(robotsDisallowArticle ? 'User-agent: *\nDisallow: /article' : 'User-agent: *\nAllow: /');
			return;
		}
		if (url === '/article') {
			lastIfNoneMatch = Array.isArray(request.headers['if-none-match'])
				? (request.headers['if-none-match'][0] ?? null)
				: (request.headers['if-none-match'] ?? null);
			lastIfModifiedSince = Array.isArray(request.headers['if-modified-since'])
				? (request.headers['if-modified-since'][0] ?? null)
				: (request.headers['if-modified-since'] ?? null);
			const validatorsMatch = lastIfNoneMatch === articleEtag || lastIfModifiedSince === articleLastModified;
			if (validatorsMatch) {
				response.writeHead(304, { etag: articleEtag, 'last-modified': articleLastModified });
				response.end();
				return;
			}
			response.writeHead(200, {
				'content-type': 'text/html; charset=utf-8',
				etag: articleEtag,
				'last-modified': articleLastModified,
			});
			response.end(articleHtml(articleBody));
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
	articleBody = 'Initial lifecycle article body for Spec 94 URL freshness tracking.';
	articleEtag = '"spec-94-v1"';
	articleLastModified = 'Mon, 04 May 2026 08:00:00 GMT';
	robotsDisallowArticle = false;
	lastIfNoneMatch = null;
	lastIfModifiedSince = null;
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

describe('Spec 94 - URL lifecycle and re-fetch support', () => {
	it('QA-01/02: ingest persists lifecycle and host state, and status prints it', async () => {
		if (!pgAvailable) return;
		const sourceId = await ingestArticle();
		const host = new URL(baseUrl).host;
		const row = db
			.runSql(
				`SELECT ul.host, ul.etag, ul.last_modified, ul.robots_allowed, ul.fetch_count, ul.unchanged_count, ul.changed_count, uh.minimum_delay_ms FROM url_lifecycle ul JOIN url_host_lifecycle uh ON uh.host = ul.host WHERE ul.source_id = ${sqlLiteral(sourceId)};`,
			)
			.split('|');
		expect(row).toEqual([host, articleEtag, articleLastModified, 't', '1', '0', '0', '0']);

		const status = await runCli(['url', 'status', sourceId]);
		expect(status.exitCode, `${status.stdout}\n${status.stderr}`).toBe(0);
		expect(status.stdout).toContain(`${baseUrl}/article`);
		expect(status.stdout).toContain(host);
		expect(status.stdout).toContain(articleEtag);
		expect(status.stdout).toMatch(/Fetch count\s+1/);
	});

	it('QA-03: 304 re-fetch updates freshness only', async () => {
		if (!pgAvailable) return;
		const sourceId = await ingestArticle();
		const before = db.runSql(`SELECT file_hash FROM sources WHERE id = ${sqlLiteral(sourceId)};`);

		const refetch = await runCli(['url', 'refetch', sourceId]);
		expect(refetch.exitCode, `${refetch.stdout}\n${refetch.stderr}`).toBe(0);
		expect(refetch.stdout).toMatch(/Result\s+unchanged/);
		expect(refetch.stdout).toMatch(/Not modified\s+yes/);
		expect(lastIfNoneMatch).toBe(articleEtag);

		const after = db
			.runSql(
				`SELECT s.file_hash, ul.last_http_status, ul.fetch_count, ul.unchanged_count, ul.changed_count FROM sources s JOIN url_lifecycle ul ON ul.source_id = s.id WHERE s.id = ${sqlLiteral(sourceId)};`,
			)
			.split('|');
		expect(after).toEqual([before, '304', '2', '1', '0']);
		expect(rawHtmlForSource(sourceId)).toContain('Initial lifecycle article body');
	});

	it('QA-04: changed re-fetch refreshes the source snapshot and resets extraction state', async () => {
		if (!pgAvailable) return;
		const sourceId = await ingestArticle();
		const beforeHash = db.runSql(`SELECT file_hash FROM sources WHERE id = ${sqlLiteral(sourceId)};`);
		const extract = await runCli(['extract', sourceId]);
		expect(extract.exitCode, `${extract.stdout}\n${extract.stderr}`).toBe(0);
		expect(db.runSql(`SELECT COUNT(*) FROM stories WHERE source_id = ${sqlLiteral(sourceId)};`)).toBe('1');

		articleBody = 'Refreshed lifecycle article body after explicit re-fetch.';
		articleEtag = '"spec-94-v2"';
		articleLastModified = 'Mon, 04 May 2026 09:00:00 GMT';
		const refetch = await runCli(['url', 'refetch', sourceId]);
		expect(refetch.exitCode, `${refetch.stdout}\n${refetch.stderr}`).toBe(0);
		expect(refetch.stdout).toMatch(/Result\s+changed/);

		const row = db
			.runSql(
				`SELECT s.file_hash, s.status::text, s.format_metadata->>'etag', ul.fetch_count, ul.changed_count FROM sources s JOIN url_lifecycle ul ON ul.source_id = s.id WHERE s.id = ${sqlLiteral(sourceId)};`,
			)
			.split('|');
		expect(row[0]).not.toBe(beforeHash);
		expect(row.slice(1)).toEqual(['ingested', articleEtag, '2', '1']);
		expect(db.runSql(`SELECT COUNT(*) FROM stories WHERE source_id = ${sqlLiteral(sourceId)};`)).toBe('0');
		expect(
			db.runSql(
				`SELECT COUNT(*) FROM source_steps WHERE source_id = ${sqlLiteral(sourceId)} AND step_name = 'extract';`,
			),
		).toBe('0');
		expect(
			db.runSql(`SELECT status FROM source_steps WHERE source_id = ${sqlLiteral(sourceId)} AND step_name = 'ingest';`),
		).toBe('completed');
		expect(rawHtmlForSource(sourceId)).toContain('Refreshed lifecycle article body');
	});

	it('QA-05/06: dry-run writes nothing, and force skips conditional validators', async () => {
		if (!pgAvailable) return;
		const sourceId = await ingestArticle();
		const beforeHash = db.runSql(`SELECT file_hash FROM sources WHERE id = ${sqlLiteral(sourceId)};`);
		const beforeRaw = rawHtmlForSource(sourceId);
		articleBody = 'Dry-run body that should not be stored yet.';
		articleEtag = '"spec-94-v3"';
		articleLastModified = 'Mon, 04 May 2026 10:00:00 GMT';

		const dryRun = await runCli(['url', 'refetch', sourceId, '--dry-run']);
		expect(dryRun.exitCode, `${dryRun.stdout}\n${dryRun.stderr}`).toBe(0);
		expect(dryRun.stdout).toMatch(/Result\s+dry-run changed/);
		expect(lastIfNoneMatch).toBe('"spec-94-v1"');
		expect(db.runSql(`SELECT file_hash FROM sources WHERE id = ${sqlLiteral(sourceId)};`)).toBe(beforeHash);
		expect(db.runSql(`SELECT fetch_count FROM url_lifecycle WHERE source_id = ${sqlLiteral(sourceId)};`)).toBe('1');
		expect(rawHtmlForSource(sourceId)).toBe(beforeRaw);

		lastIfNoneMatch = 'not-reset';
		const force = await runCli(['url', 'refetch', sourceId, '--force']);
		expect(force.exitCode, `${force.stdout}\n${force.stderr}`).toBe(0);
		expect(force.stdout).toMatch(/Result\s+changed/);
		expect(lastIfNoneMatch).toBeNull();
		expect(rawHtmlForSource(sourceId)).toContain('Dry-run body that should not be stored yet');
	});

	it('QA-07/08: robots-blocked refetch and non-URL sources fail without source mutations', async () => {
		if (!pgAvailable) return;
		const sourceId = await ingestArticle();
		const beforeHash = db.runSql(`SELECT file_hash FROM sources WHERE id = ${sqlLiteral(sourceId)};`);
		robotsDisallowArticle = true;
		articleBody = 'Robots blocked body that must not be stored.';
		articleEtag = '"spec-94-v4"';

		const blocked = await runCli(['url', 'refetch', sourceId]);
		expect(blocked.exitCode, `${blocked.stdout}\n${blocked.stderr}`).not.toBe(0);
		expect(`${blocked.stdout}\n${blocked.stderr}`).toMatch(/robots|re-fetch failed/i);
		expect(db.runSql(`SELECT file_hash FROM sources WHERE id = ${sqlLiteral(sourceId)};`)).toBe(beforeHash);
		expect(db.runSql(`SELECT fetch_count FROM url_lifecycle WHERE source_id = ${sqlLiteral(sourceId)};`)).toBe('1');

		db.runSql(
			`INSERT INTO sources (id, filename, storage_path, file_hash, source_type, format_metadata, metadata) VALUES (${sqlLiteral(SOURCE_ID_TEXT)}, 'spec-94.txt', 'raw/spec-94/original.txt', 'spec-94-text-hash', 'text', '{}'::jsonb, '{}'::jsonb);`,
		);
		const nonUrl = await runCli(['url', 'status', SOURCE_ID_TEXT]);
		expect(nonUrl.exitCode, `${nonUrl.stdout}\n${nonUrl.stderr}`).not.toBe(0);
		expect(`${nonUrl.stdout}\n${nonUrl.stderr}`).toMatch(/URL source/i);
	});
});
