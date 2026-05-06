import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as db from '../lib/db.js';
import { createDocxBuffer, createEmlContent, createXlsxBuffer, PNG_BYTES } from '../lib/multi-format-fixtures.js';
import { cleanStorageDirSince, type StorageSnapshot, snapshotStorageDir, testStoragePath } from '../lib/storage.js';

const ROOT = resolve(import.meta.dirname, '../..');
const CORE_DIR = resolve(ROOT, 'packages/core');
const PIPELINE_DIR = resolve(ROOT, 'packages/pipeline');
const CLI_DIR = resolve(ROOT, 'apps/cli');
const CLI_DIST = resolve(CLI_DIR, 'dist/index.js');
const EXAMPLE_CONFIG = resolve(ROOT, 'mulder.config.example.yaml');
const MANIFEST_PATH = resolve(ROOT, 'eval/golden/multi-format/manifest.json');
const STORAGE_DIR = testStoragePath();
const RAW_STORAGE_DIR = resolve(STORAGE_DIR, 'raw');
const EXTRACTED_STORAGE_DIR = resolve(STORAGE_DIR, 'extracted');
const SEGMENTS_STORAGE_DIR = resolve(STORAGE_DIR, 'segments');

type SourceType = 'pdf' | 'image' | 'text' | 'docx' | 'spreadsheet' | 'email' | 'url';
type FixtureKind =
	| 'committed_file'
	| 'generated_png'
	| 'generated_markdown'
	| 'generated_docx'
	| 'generated_xlsx'
	| 'generated_eml'
	| 'generated_text'
	| 'local_http_url';
type ExpectedRoute = 'layout' | 'prestructured';

interface ManifestCase {
	id: string;
	source_type: SourceType;
	fixture_kind: FixtureKind;
	fixture_ref?: string;
	expected_filename: string;
	expected_route: ExpectedRoute;
	expected_story_min: number;
	expected_metadata_keys: string[];
}

interface DuplicateManifestFixture {
	fixture_kind: FixtureKind;
	expected_filename: string;
}

interface MultiFormatManifest {
	schema_version: number;
	cases: ManifestCase[];
	duplicate_scenario: {
		id: string;
		first: DuplicateManifestFixture;
		second: DuplicateManifestFixture;
		expected_source_type: SourceType;
		expected_duplicate_basis: string;
	};
}

const SOURCE_TYPES: SourceType[] = ['pdf', 'image', 'text', 'docx', 'spreadsheet', 'email', 'url'];

let tmpDir = '';
let server: Server | null = null;
let baseUrl = '';
let pgAvailable = false;
let rawSnapshot: StorageSnapshot | null = null;
let extractedSnapshot: StorageSnapshot | null = null;
let segmentsSnapshot: StorageSnapshot | null = null;

function readManifest(): MultiFormatManifest {
	return JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8')) as MultiFormatManifest;
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

function cliEnv(): NodeJS.ProcessEnv {
	return {
		...process.env,
		MULDER_CONFIG: EXAMPLE_CONFIG,
		MULDER_LOG_LEVEL: 'silent',
		MULDER_ALLOW_UNSAFE_URLS_FOR_TESTS: 'true',
		MULDER_URL_POLITENESS_DELAY_MS: '0',
		NODE_ENV: 'test',
		PGPASSWORD: db.TEST_PG_PASSWORD,
	};
}

function runCli(args: string[], opts?: { timeout?: number }): { stdout: string; stderr: string; exitCode: number } {
	const result = spawnSync('node', [CLI_DIST, ...args], {
		cwd: ROOT,
		encoding: 'utf-8',
		timeout: opts?.timeout ?? 180_000,
		stdio: ['pipe', 'pipe', 'pipe'],
		env: cliEnv(),
	});
	return {
		stdout: result.stdout ?? '',
		stderr: result.stderr ?? '',
		exitCode: result.status ?? 1,
	};
}

async function runCliAsync(
	args: string[],
	opts?: { timeout?: number },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	return await new Promise((resolveCli) => {
		const child = spawn('node', [CLI_DIST, ...args], {
			cwd: ROOT,
			stdio: ['ignore', 'pipe', 'pipe'],
			env: cliEnv(),
		});
		let stdout = '';
		let stderr = '';
		const timeout = setTimeout(() => {
			child.kill('SIGTERM');
		}, opts?.timeout ?? 180_000);
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

function combinedOutput(result: { stdout: string; stderr: string }): string {
	return `${result.stdout}\n${result.stderr}`;
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

function writeFixture(relativePath: string, content: Buffer | string): string {
	const filePath = join(tmpDir, relativePath);
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, content);
	return filePath;
}

function sourceIdForFilename(filename: string): string {
	return db.runSql(`SELECT id FROM sources WHERE filename = ${sqlLiteral(filename)} ORDER BY created_at DESC LIMIT 1;`);
}

function sourceIdForCase(testCase: ManifestCase): string {
	if (testCase.source_type === 'url') {
		return db.runSql("SELECT id FROM sources WHERE source_type = 'url' ORDER BY created_at DESC LIMIT 1;");
	}
	return sourceIdForFilename(testCase.expected_filename);
}

function materializeFixture(testCase: ManifestCase): string {
	switch (testCase.fixture_kind) {
		case 'committed_file':
			if (!testCase.fixture_ref) {
				throw new Error(`Manifest case ${testCase.id} is missing fixture_ref`);
			}
			return resolve(ROOT, testCase.fixture_ref);
		case 'generated_png':
			return writeFixture(testCase.expected_filename, PNG_BYTES);
		case 'generated_markdown':
			return writeFixture(
				testCase.expected_filename,
				[
					'# Spec 97 Golden Note',
					'',
					'This deterministic Markdown fixture exercises the pre-structured text route.',
					'',
				].join('\n'),
			);
		case 'generated_docx':
			return writeFixture(
				testCase.expected_filename,
				createDocxBuffer('Spec 97 Golden DOCX', 'The DOCX fixture converges directly to a Markdown story.'),
			);
		case 'generated_xlsx':
			return writeFixture(
				testCase.expected_filename,
				createXlsxBuffer([
					{
						name: 'People',
						rows: [
							['name', 'date', 'city', 'email'],
							['Ada Lovelace', '2026-05-01', 'London', 'ada@example.com'],
						],
					},
				]),
			);
		case 'generated_eml':
			return writeFixture(
				testCase.expected_filename,
				createEmlContent({
					messageId: 'spec-97-golden@example.com',
					subject: 'Spec 97 Golden Email',
					body: 'This deterministic email body exercises the pre-structured email route.',
				}),
			);
		case 'local_http_url':
			if (!testCase.fixture_ref) {
				throw new Error(`Manifest case ${testCase.id} is missing fixture_ref`);
			}
			return `${baseUrl}${testCase.fixture_ref}`;
		default:
			throw new Error(`Unsupported fixture kind for primary case: ${testCase.fixture_kind}`);
	}
}

function materializeDuplicateFixture(fixture: DuplicateManifestFixture, content: string): string {
	if (fixture.fixture_kind === 'generated_markdown') {
		return writeFixture(fixture.expected_filename, content);
	}
	if (fixture.fixture_kind === 'generated_text') {
		return writeFixture(fixture.expected_filename, content.replaceAll('\n', '\r\n'));
	}
	throw new Error(`Unsupported duplicate fixture kind: ${fixture.fixture_kind}`);
}

function formatMetadataForSource(sourceId: string): Record<string, unknown> {
	return JSON.parse(
		db.runSql(`SELECT format_metadata::text FROM sources WHERE id = ${sqlLiteral(sourceId)};`),
	) as Record<string, unknown>;
}

function storyCount(sourceId: string): number {
	return Number(db.runSql(`SELECT COUNT(*) FROM stories WHERE source_id = ${sqlLiteral(sourceId)};`));
}

function sourceStepStatus(sourceId: string, stepName: string): string {
	return db.runSql(
		`SELECT COALESCE((SELECT status::text FROM source_steps WHERE source_id = ${sqlLiteral(sourceId)} AND step_name = ${sqlLiteral(stepName)}), 'missing');`,
	);
}

function storyArtifactRows(sourceId: string): string[] {
	return db
		.runSql(
			`SELECT gcs_markdown_uri || '|' || gcs_metadata_uri FROM stories WHERE source_id = ${sqlLiteral(sourceId)} ORDER BY created_at;`,
		)
		.split('\n')
		.filter(Boolean);
}

function assertStoryArtifacts(sourceId: string, sourceType: SourceType): void {
	for (const row of storyArtifactRows(sourceId)) {
		const [markdownUri, metadataUri] = row.split('|');
		expect(markdownUri).toMatch(/^segments\//);
		expect(metadataUri).toMatch(/^segments\//);
		expect(existsSync(resolve(STORAGE_DIR, markdownUri))).toBe(true);
		expect(existsSync(resolve(STORAGE_DIR, metadataUri))).toBe(true);
		const metadata = JSON.parse(readFileSync(resolve(STORAGE_DIR, metadataUri), 'utf-8')) as Record<string, unknown>;
		expect(metadata.source_type).toBe(sourceType);
	}
}

function assertRouteArtifacts(sourceId: string, expectedRoute: ExpectedRoute): void {
	const layoutJsonPath = resolve(STORAGE_DIR, `extracted/${sourceId}/layout.json`);
	if (expectedRoute === 'layout') {
		expect(existsSync(layoutJsonPath)).toBe(true);
		expect(sourceStepStatus(sourceId, 'segment')).toBe('completed');
		return;
	}
	expect(existsSync(layoutJsonPath)).toBe(false);
}

function sourceCount(): string {
	return db.runSql('SELECT COUNT(*) FROM sources;');
}

function urlArticleHtml(): string {
	return `<!doctype html>
<html lang="en">
<head>
  <title>Spec 97 Golden URL</title>
  <meta name="author" content="Golden URL Reporter">
</head>
<body>
  <article>
    <h1>Spec 97 Golden URL</h1>
    <p>This deterministic local page exercises URL ingestion without leaving the test process.</p>
    <p>The readable article body is intentionally stable so the pre-structured URL route creates one Markdown story.</p>
    <p>It mentions source types, route behavior, and story convergence for the M9 multi-format golden layer.</p>
  </article>
</body>
</html>`;
}

beforeAll(async () => {
	process.env.MULDER_CONFIG = EXAMPLE_CONFIG;
	process.env.MULDER_LOG_LEVEL = 'silent';
	process.env.NODE_ENV = 'test';

	tmpDir = mkdtempSync(join(tmpdir(), 'mulder-qa-97-'));
	server = createServer((request, response) => {
		const url = request.url ?? '/';
		if (url === '/robots.txt') {
			response.writeHead(200, { 'content-type': 'text/plain' });
			response.end('User-agent: *\nAllow: /');
			return;
		}
		if (url === '/golden-url-article') {
			response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
			response.end(urlArticleHtml());
			return;
		}
		response.writeHead(404, { 'content-type': 'text/plain' });
		response.end('not found');
	});
	await new Promise<void>((resolveServer) => {
		server?.listen(0, '127.0.0.1', resolveServer);
	});
	const address = server.address();
	if (address && typeof address === 'object') {
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
		const migrate = runCli(['db', 'migrate', EXAMPLE_CONFIG], { timeout: 300_000 });
		expect(migrate.exitCode, combinedOutput(migrate)).toBe(0);
	}
}, 600_000);

beforeEach(() => {
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
	if (tmpDir) {
		rmSync(tmpDir, { recursive: true, force: true });
	}
	if (server) {
		await new Promise<void>((resolveServer) => {
			server?.close(() => resolveServer());
			server?.closeAllConnections();
		});
	}
});

describe('Spec 97 - Multi-format golden tests', () => {
	it('QA-01/02: manifest contains one complete primary case per source type', () => {
		const manifest = readManifest();
		expect(manifest.schema_version).toBe(1);
		expect(manifest.cases).toHaveLength(SOURCE_TYPES.length);
		expect(manifest.cases.map((testCase) => testCase.source_type).sort()).toEqual([...SOURCE_TYPES].sort());

		for (const sourceType of SOURCE_TYPES) {
			expect(manifest.cases.filter((testCase) => testCase.source_type === sourceType)).toHaveLength(1);
		}
		for (const testCase of manifest.cases) {
			expect(testCase.id).toMatch(/^golden-/);
			expect(testCase.fixture_kind).toEqual(expect.any(String));
			expect(testCase.expected_filename).toEqual(expect.any(String));
			expect(['layout', 'prestructured']).toContain(testCase.expected_route);
			expect(testCase.expected_story_min).toEqual(expect.any(Number));
			expect(Array.isArray(testCase.expected_metadata_keys)).toBe(true);
		}
	});

	it('QA-03/04/05: golden fixtures ingest, route, and converge to story artifacts', async () => {
		if (!pgAvailable) return;

		const manifest = readManifest();
		for (const testCase of manifest.cases) {
			cleanState();
			resetStorage();
			const fixture = materializeFixture(testCase);
			const ingest =
				testCase.source_type === 'url' ? await runCliAsync(['ingest', fixture]) : runCli(['ingest', fixture]);
			expect(ingest.exitCode, `${testCase.id}\n${combinedOutput(ingest)}`).toBe(0);
			expect(sourceCount()).toBe('1');

			const sourceId = sourceIdForCase(testCase);
			const sourceRow = db
				.runSql(`SELECT filename, source_type::text, status FROM sources WHERE id = ${sqlLiteral(sourceId)};`)
				.split('|');
			expect(sourceRow).toEqual([testCase.expected_filename, testCase.source_type, 'ingested']);

			const formatMetadata = formatMetadataForSource(sourceId);
			for (const key of testCase.expected_metadata_keys) {
				expect(formatMetadata).toHaveProperty(key);
			}

			const extract = runCli(['extract', sourceId], { timeout: 240_000 });
			expect(extract.exitCode, `${testCase.id}\n${combinedOutput(extract)}`).toBe(0);

			if (testCase.expected_route === 'layout') {
				const segment = runCli(['segment', sourceId], { timeout: 240_000 });
				expect(segment.exitCode, `${testCase.id}\n${combinedOutput(segment)}`).toBe(0);
			}

			expect(db.runSql(`SELECT source_type::text FROM sources WHERE id = ${sqlLiteral(sourceId)};`)).toBe(
				testCase.source_type,
			);
			expect(storyCount(sourceId)).toBeGreaterThanOrEqual(testCase.expected_story_min);
			assertStoryArtifacts(sourceId, testCase.source_type);
			assertRouteArtifacts(sourceId, testCase.expected_route);
		}
	}, 1_500_000);

	it('QA-06: pipeline records segment skipped for a pre-structured golden source', () => {
		if (!pgAvailable) return;

		const textCase = readManifest().cases.find((testCase) => testCase.source_type === 'text');
		expect(textCase).toBeDefined();
		if (!textCase) return;

		const fixture = materializeFixture(textCase);
		const ingest = runCli(['ingest', fixture]);
		expect(ingest.exitCode, combinedOutput(ingest)).toBe(0);
		const sourceId = sourceIdForCase(textCase);

		const pipeline = runCli(['pipeline', 'run', '--from', 'extract', '--up-to', 'enrich', '--source-id', sourceId], {
			timeout: 240_000,
		});
		expect(pipeline.exitCode, combinedOutput(pipeline)).toBe(0);
		expect(sourceStepStatus(sourceId, 'extract')).toBe('completed');
		expect(sourceStepStatus(sourceId, 'segment')).toBe('skipped');
		expect(sourceStepStatus(sourceId, 'enrich')).toBe('completed');
		expect(db.runSql(`SELECT status FROM stories WHERE source_id = ${sqlLiteral(sourceId)};`)).toBe('enriched');
	});

	it('QA-07: cheap cross-format duplicate golden pair does not inflate sources', () => {
		if (!pgAvailable) return;

		const duplicate = readManifest().duplicate_scenario;
		const content = [
			'# Spec 97 Duplicate Report',
			'',
			'Alpha beta gamma delta epsilon zeta eta theta iota kappa.',
			'',
			'This normalized body is identical across Markdown and plain text fixtures.',
			'',
		].join('\n');
		const first = materializeDuplicateFixture(duplicate.first, content);
		const second = materializeDuplicateFixture(duplicate.second, content);

		const firstIngest = runCli(['ingest', first]);
		expect(firstIngest.exitCode, combinedOutput(firstIngest)).toBe(0);
		const existingSourceId = sourceIdForFilename(duplicate.first.expected_filename);
		const secondIngest = runCli(['ingest', second]);
		expect(secondIngest.exitCode, combinedOutput(secondIngest)).toBe(0);
		expect(combinedOutput(secondIngest)).toMatch(/duplicate/i);
		expect(combinedOutput(secondIngest)).toContain(existingSourceId);
		expect(sourceCount()).toBe('1');

		const metadata = formatMetadataForSource(existingSourceId);
		expect(db.runSql(`SELECT source_type::text FROM sources WHERE id = ${sqlLiteral(existingSourceId)};`)).toBe(
			duplicate.expected_source_type,
		);
		expect(metadata.cross_format_dedup_basis).toBe(duplicate.expected_duplicate_basis);
	});
});
