import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { WorkerRuntimeContext } from '@mulder/worker';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as db from '../lib/db.js';
import { cleanStorageDirSince, type StorageSnapshot, snapshotStorageDir, testStoragePath } from '../lib/storage.js';

const ROOT = resolve(import.meta.dirname, '../..');
const CORE_DIR = resolve(ROOT, 'packages/core');
const PIPELINE_DIR = resolve(ROOT, 'packages/pipeline');
const WORKER_DIR = resolve(ROOT, 'packages/worker');
const API_DIR = resolve(ROOT, 'apps/api');
const CLI_DIR = resolve(ROOT, 'apps/cli');
const CORE_DIST = resolve(CORE_DIR, 'dist/index.js');
const WORKER_DIST = resolve(WORKER_DIR, 'dist/index.js');
const API_APP_DIST = resolve(API_DIR, 'dist/app.js');
const CLI_DIST = resolve(CLI_DIR, 'dist/index.js');
const EXAMPLE_CONFIG = resolve(ROOT, 'mulder.config.example.yaml');
const FIXTURE_PDF = resolve(ROOT, 'fixtures/raw/native-text-sample.pdf');
const STORAGE_DIR = testStoragePath();
const BLOBS_STORAGE_DIR = resolve(STORAGE_DIR, 'blobs');
const RAW_STORAGE_DIR = resolve(STORAGE_DIR, 'raw');
const EXTRACTED_STORAGE_DIR = resolve(STORAGE_DIR, 'extracted');
const SEGMENTS_STORAGE_DIR = resolve(STORAGE_DIR, 'segments');

const PNG_BYTES = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
	'base64',
);

type ApiApp = { request: (input: string | Request, init?: RequestInit) => Promise<Response> };

let tmpDir: string;
let txtFile: string;
let mdFile: string;
let markdownFile: string;
let coreModule: typeof import('@mulder/core');
let workerModule: typeof import('@mulder/worker');
let workerContext: WorkerRuntimeContext;
let app: ApiApp;
let pgAvailable = false;
let blobsSnapshot: StorageSnapshot | null = null;
let rawSnapshot: StorageSnapshot | null = null;
let extractedSnapshot: StorageSnapshot | null = null;
let segmentsSnapshot: StorageSnapshot | null = null;

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

function runCli(args: string[], opts?: { timeout?: number }): { stdout: string; stderr: string; exitCode: number } {
	const result = spawnSync('node', [CLI_DIST, ...args], {
		cwd: ROOT,
		encoding: 'utf-8',
		timeout: opts?.timeout ?? 180_000,
		stdio: ['pipe', 'pipe', 'pipe'],
		env: {
			...process.env,
			MULDER_CONFIG: EXAMPLE_CONFIG,
			MULDER_LOG_LEVEL: 'silent',
			NODE_ENV: 'test',
			PGPASSWORD: db.TEST_PG_PASSWORD,
		},
	});
	return {
		stdout: result.stdout ?? '',
		stderr: result.stderr ?? '',
		exitCode: result.status ?? 1,
	};
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
			'DELETE FROM document_blobs',
		].join('; '),
	);
}

function sqlLiteral(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

function sourceIdForFilename(filename: string): string {
	return db.runSql(`SELECT id FROM sources WHERE filename = ${sqlLiteral(filename)} ORDER BY created_at DESC LIMIT 1;`);
}

function resetStorage(): void {
	for (const snapshot of [blobsSnapshot, rawSnapshot, extractedSnapshot, segmentsSnapshot]) {
		if (snapshot) {
			cleanStorageDirSince(snapshot);
		}
	}
}

async function loadApiApp(): Promise<ApiApp> {
	const module = await import(pathToFileURL(API_APP_DIST).href);
	return module.createApp({
		config: {
			port: 8080,
			auth: {
				api_keys: [{ name: 'cli', key: 'test-api-key' }],
				browser: {
					enabled: true,
					cookie_name: 'mulder_session',
					session_secret: 'test-session-secret',
					session_ttl_hours: 168,
					invitation_ttl_hours: 168,
					cookie_secure: false,
					same_site: 'Lax',
				},
			},
			rate_limiting: { enabled: true },
		},
	});
}

async function apiPost(path: string, body: unknown): Promise<Response> {
	return await app.request(`http://localhost${path}`, {
		method: 'POST',
		headers: {
			Authorization: 'Bearer test-api-key',
			'Content-Type': 'application/json',
			'X-Forwarded-For': '203.0.113.88',
		},
		body: JSON.stringify(body),
	});
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
	return (await response.json()) as Record<string, unknown>;
}

function writeUploadedObject(storagePath: string, content: Buffer): void {
	const fullPath = resolve(STORAGE_DIR, storagePath);
	mkdirSync(dirname(fullPath), { recursive: true });
	writeFileSync(fullPath, content);
}

async function processOneJob() {
	return await workerModule.processNextJob(workerContext, 'spec-88-worker');
}

describe('Spec 88 — Plain Text Ingestion on the Pre-Structured Path', () => {
	beforeAll(async () => {
		pgAvailable = db.isPgAvailable();
		if (!pgAvailable) {
			console.warn('SKIP: PostgreSQL not reachable at PGHOST/PGPORT.');
			return;
		}

		process.env.MULDER_CONFIG = EXAMPLE_CONFIG;
		process.env.MULDER_LOG_LEVEL = 'silent';
		process.env.NODE_ENV = 'test';

		tmpDir = mkdtempSync(join(tmpdir(), 'mulder-qa-88-'));
		txtFile = join(tmpDir, 'note.txt');
		mdFile = join(tmpDir, 'brief.md');
		markdownFile = join(tmpDir, 'memo.markdown');
		writeFileSync(txtFile, 'Plain text sighting note.\nSecond line.\n', 'utf-8');
		writeFileSync(mdFile, '# Briefing\n\nMarkdown body stays **Markdown**.\n', 'utf-8');
		writeFileSync(markdownFile, '# Memorandum\n\nExtended markdown extension.\n', 'utf-8');

		blobsSnapshot = snapshotStorageDir(BLOBS_STORAGE_DIR);
		rawSnapshot = snapshotStorageDir(RAW_STORAGE_DIR);
		extractedSnapshot = snapshotStorageDir(EXTRACTED_STORAGE_DIR);
		segmentsSnapshot = snapshotStorageDir(SEGMENTS_STORAGE_DIR);

		buildPackage(CORE_DIR);
		buildPackage(PIPELINE_DIR);
		buildPackage(WORKER_DIR);
		buildPackage(API_DIR);
		buildPackage(CLI_DIR);

		const migrate = runCli(['db', 'migrate', EXAMPLE_CONFIG], { timeout: 300_000 });
		expect(migrate.exitCode, `${migrate.stdout}\n${migrate.stderr}`).toBe(0);

		coreModule = await import(pathToFileURL(CORE_DIST).href);
		workerModule = await import(pathToFileURL(WORKER_DIST).href);
		app = await loadApiApp();

		const config = coreModule.loadConfig(EXAMPLE_CONFIG);
		const cloudSql = config.gcp?.cloud_sql;
		if (!cloudSql) {
			throw new Error('Expected example config to include gcp.cloud_sql');
		}
		const logger = coreModule.createLogger({ level: 'silent' });
		workerContext = {
			config,
			services: coreModule.createServiceRegistry(config, logger),
			pool: coreModule.getWorkerPool(cloudSql),
			logger,
		};
	}, 600_000);

	beforeEach(() => {
		if (!pgAvailable) return;
		cleanState();
		resetStorage();
	});

	afterAll(() => {
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
	});

	it('QA-01: CLI dry-run accepts text sources without persistence', () => {
		if (!pgAvailable) return;

		for (const textFile of [txtFile, mdFile, markdownFile]) {
			const result = runCli(['ingest', '--dry-run', textFile]);
			expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
			expect(result.stdout).toContain('Type');
			expect(result.stdout).toMatch(/\btext\b/);
			expect(result.stdout).toMatch(/\b0\b/);
		}
		expect(db.runSql('SELECT COUNT(*) FROM sources;')).toBe('0');
	});

	it('QA-02 and QA-03: CLI text ingest persists canonical metadata', () => {
		if (!pgAvailable) return;

		const txt = runCli(['ingest', txtFile]);
		expect(txt.exitCode, `${txt.stdout}\n${txt.stderr}`).toBe(0);
		const txtSourceId = sourceIdForFilename(basename(txtFile));
		const txtRow = db
			.runSql(
				`SELECT source_type::text AS source_type, page_count, has_native_text, native_text_ratio, storage_path, format_metadata->>'media_type' AS media_type, format_metadata->>'encoding' AS encoding, format_metadata->>'line_count' AS line_count FROM sources WHERE id = ${sqlLiteral(txtSourceId)};`,
			)
			.split('|');
		expect(txtRow.slice(0, 4)).toEqual(['text', '0', 'f', '0']);
		expect(txtRow[4]).toMatch(/^blobs\/sha256\/[a-f0-9]{2}\/[a-f0-9]{2}\/[a-f0-9]{64}\.txt$/);
		expect(txtRow.slice(5)).toEqual(['text/plain', 'utf-8', '2']);
		expect(existsSync(resolve(STORAGE_DIR, txtRow[4]))).toBe(true);

		const md = runCli(['ingest', markdownFile]);
		expect(md.exitCode, `${md.stdout}\n${md.stderr}`).toBe(0);
		const mdSourceId = sourceIdForFilename(basename(markdownFile));
		const mdRow = db
			.runSql(
				`SELECT source_type::text AS source_type, storage_path, format_metadata->>'media_type' AS media_type FROM sources WHERE id = ${sqlLiteral(mdSourceId)};`,
			)
			.split('|');
		expect(mdRow[0]).toBe('text');
		expect(mdRow[1]).toMatch(/^blobs\/sha256\/[a-f0-9]{2}\/[a-f0-9]{2}\/[a-f0-9]{64}\.md$/);
		expect(mdRow[2]).toBe('text/markdown');
	});

	it('QA-04 and QA-05: directory discovery includes text and magic bytes stay authoritative', () => {
		if (!pgAvailable) return;

		const mixedDir = join(tmpDir, 'mixed-dir');
		mkdirSync(mixedDir, { recursive: true });
		writeFileSync(join(mixedDir, 'scan.png'), PNG_BYTES);
		writeFileSync(join(mixedDir, 'native-text-sample.pdf'), readFileSync(FIXTURE_PDF));
		writeFileSync(join(mixedDir, 'note.txt'), 'Directory note.\n', 'utf-8');
		writeFileSync(join(mixedDir, 'brief.md'), '# Directory brief\n', 'utf-8');

		const directory = runCli(['ingest', '--dry-run', mixedDir], { timeout: 180_000 });
		expect(directory.exitCode, `${directory.stdout}\n${directory.stderr}`).toBe(0);
		expect(directory.stdout).toMatch(/native-text-sample\.pdf[\s\S]*\bpdf\b/);
		expect(directory.stdout).toMatch(/scan\.png[\s\S]*\bimage\b/);
		expect(directory.stdout).toMatch(/note\.txt[\s\S]*\btext\b/);
		expect(directory.stdout).toMatch(/brief\.md[\s\S]*\btext\b/);

		const pdfRenamedText = join(tmpDir, 'pdf-renamed.txt');
		const pngRenamedText = join(tmpDir, 'png-renamed.txt');
		writeFileSync(pdfRenamedText, readFileSync(FIXTURE_PDF));
		writeFileSync(pngRenamedText, PNG_BYTES);

		const pdfResult = runCli(['ingest', '--dry-run', pdfRenamedText], { timeout: 180_000 });
		expect(pdfResult.exitCode, `${pdfResult.stdout}\n${pdfResult.stderr}`).toBe(0);
		expect(pdfResult.stdout).toMatch(/\bpdf\b/);

		const imageResult = runCli(['ingest', '--dry-run', pngRenamedText]);
		expect(imageResult.exitCode, `${imageResult.stdout}\n${imageResult.stderr}`).toBe(0);
		expect(imageResult.stdout).toMatch(/\bimage\b/);
	});

	it('QA-06: text extract creates a pre-structured story without layout artifacts', () => {
		if (!pgAvailable) return;

		const ingest = runCli(['ingest', txtFile]);
		expect(ingest.exitCode, `${ingest.stdout}\n${ingest.stderr}`).toBe(0);
		const sourceId = sourceIdForFilename(basename(txtFile));

		const extract = runCli(['extract', sourceId], { timeout: 180_000 });
		expect(extract.exitCode, `${extract.stdout}\n${extract.stderr}`).toBe(0);
		expect(extract.stdout).toMatch(/\btext\b/);

		expect(db.runSql(`SELECT status FROM sources WHERE id = ${sqlLiteral(sourceId)};`)).toBe('extracted');
		expect(
			db.runSql(`SELECT status FROM source_steps WHERE source_id = ${sqlLiteral(sourceId)} AND step_name = 'extract';`),
		).toBe('completed');
		expect(db.runSql(`SELECT COUNT(*) FROM stories WHERE source_id = ${sqlLiteral(sourceId)};`)).toBe('1');
		expect(existsSync(resolve(STORAGE_DIR, `extracted/${sourceId}/layout.json`))).toBe(false);

		const storyRow = db.runSql(
			`SELECT id, gcs_markdown_uri, gcs_metadata_uri, page_start IS NULL AS page_start_null, page_end IS NULL AS page_end_null, extraction_confidence FROM stories WHERE source_id = ${sqlLiteral(sourceId)};`,
		);
		const [storyId, markdownUri, metadataUri, pageStartNull, pageEndNull, confidence] = storyRow.split('|');
		expect(markdownUri).toBe(`segments/${sourceId}/${storyId}.md`);
		expect(metadataUri).toBe(`segments/${sourceId}/${storyId}.meta.json`);
		expect(pageStartNull).toBe('t');
		expect(pageEndNull).toBe('t');
		expect(confidence).toBe('1');
		expect(readFileSync(resolve(STORAGE_DIR, markdownUri), 'utf-8')).toMatch(/^# note/m);
		expect(JSON.parse(readFileSync(resolve(STORAGE_DIR, metadataUri), 'utf-8'))).toMatchObject({
			id: storyId,
			document_id: sourceId,
			source_type: 'text',
			is_markdown: false,
		});
	});

	it('QA-06 regression: text extract rejects UTF-8 control-byte payloads after the initial read sample', () => {
		if (!pgAvailable) return;

		const sourceId = randomUUID();
		const storagePath = `raw/${sourceId}/original.txt`;
		const readablePrefix = `${'Plain text line.\n'.repeat(300)}Still looks readable before the binary byte.`;
		writeUploadedObject(storagePath, Buffer.concat([Buffer.from(readablePrefix, 'utf-8'), Buffer.from([0x00])]));
		db.runSql(
			`INSERT INTO sources (id, filename, storage_path, file_hash, page_count, has_native_text, native_text_ratio, status, reliability_score, tags, metadata, source_type, format_metadata)
			 VALUES (${sqlLiteral(sourceId)}, 'binary-valid-utf8.txt', ${sqlLiteral(storagePath)}, ${sqlLiteral(sourceId.replaceAll('-', ''))}, 0, false, 0, 'ingested', NULL, ARRAY[]::text[], '{}'::jsonb, 'text', '{"media_type":"text/plain","encoding":"utf-8"}'::jsonb);`,
		);

		const extract = runCli(['extract', sourceId], { timeout: 180_000 });
		expect(extract.exitCode).not.toBe(0);
		expect(`${extract.stdout}\n${extract.stderr}`).toMatch(/not readable UTF-8/i);
		expect(db.runSql(`SELECT status FROM sources WHERE id = ${sqlLiteral(sourceId)};`)).toBe('ingested');
		expect(db.runSql(`SELECT COUNT(*) FROM stories WHERE source_id = ${sqlLiteral(sourceId)};`)).toBe('0');
		expect(
			db.runSql(
				`SELECT COUNT(*) FROM source_steps WHERE source_id = ${sqlLiteral(sourceId)} AND step_name = 'extract';`,
			),
		).toBe('0');
	});

	it('QA-07: pipeline run can resume one text source by --source-id and skip segment', () => {
		if (!pgAvailable) return;

		const ingest = runCli(['ingest', txtFile]);
		expect(ingest.exitCode, `${ingest.stdout}\n${ingest.stderr}`).toBe(0);
		const sourceId = sourceIdForFilename(basename(txtFile));

		const result = runCli(['pipeline', 'run', '--from', 'extract', '--up-to', 'enrich', '--source-id', sourceId], {
			timeout: 240_000,
		});
		expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
		expect(`${result.stdout}\n${result.stderr}`).toMatch(/Pipeline complete/i);

		expect(
			db.runSql(`SELECT status FROM source_steps WHERE source_id = ${sqlLiteral(sourceId)} AND step_name = 'extract';`),
		).toBe('completed');
		expect(
			db.runSql(`SELECT status FROM source_steps WHERE source_id = ${sqlLiteral(sourceId)} AND step_name = 'segment';`),
		).toBe('skipped');
		expect(
			db.runSql(`SELECT status FROM source_steps WHERE source_id = ${sqlLiteral(sourceId)} AND step_name = 'enrich';`),
		).toBe('completed');
		expect(db.runSql(`SELECT status FROM stories WHERE source_id = ${sqlLiteral(sourceId)};`)).toBe('enriched');
		expect(
			db.runSql(`SELECT COUNT(*) FROM jobs WHERE type = 'segment' AND payload->>'sourceId' = ${sqlLiteral(sourceId)};`),
		).toBe('0');
	});

	it('QA-08: API upload accepts Markdown media types and queues extract', async () => {
		if (!pgAvailable) return;

		const content = Buffer.from(
			[
				'# Uploaded Note',
				'',
				'Alpha beta gamma delta epsilon zeta eta theta iota kappa.',
				'This uploaded Markdown body is long enough for cross-format duplicate metadata.',
				'',
			].join('\n'),
			'utf-8',
		);
		const initiate = await apiPost('/api/uploads/documents/initiate', {
			filename: 'note.md',
			size_bytes: content.byteLength,
			content_type: 'text/markdown',
		});
		expect(initiate.status).toBe(201);
		const initiateBody = await readJson(initiate);
		const sourceId = String((initiateBody.data as Record<string, unknown>).source_id);
		const storagePath = String((initiateBody.data as Record<string, unknown>).storage_path);
		expect(storagePath).toBe(`raw/${sourceId}/original.md`);
		writeUploadedObject(storagePath, content);

		const complete = await apiPost('/api/uploads/documents/complete', {
			source_id: sourceId,
			filename: 'note.md',
			storage_path: storagePath,
			start_pipeline: true,
		});
		expect(complete.status).toBe(202);

		const processed = await processOneJob();
		expect(processed.state).toBe('completed');
		const sourceRow = db
			.runSql(
				`SELECT source_type::text AS source_type, storage_path, format_metadata->>'media_type' AS media_type, format_metadata->>'cross_format_dedup_basis' AS dedup_basis, format_metadata->>'cross_format_dedup_key' LIKE 'sha256:%' AS has_dedup_key FROM sources WHERE id = ${sqlLiteral(sourceId)};`,
			)
			.split('|');
		expect(sourceRow[0]).toBe('text');
		expect(sourceRow[1]).toMatch(/^blobs\/sha256\/[a-f0-9]{2}\/[a-f0-9]{2}\/[a-f0-9]{64}\.md$/);
		expect(sourceRow.slice(2)).toEqual(['text/markdown', 'text_content', 't']);
		expect(
			db.runSql(
				`SELECT COUNT(*) FROM jobs WHERE type = 'quality' AND status = 'pending' AND payload->>'sourceId' = ${sqlLiteral(sourceId)};`,
			),
		).toBe('1');
		expect(
			db.runSql(
				`SELECT COUNT(*) FROM jobs WHERE type = 'extract' AND status = 'pending' AND payload->>'sourceId' = ${sqlLiteral(sourceId)};`,
			),
		).toBe('0');
	});

	it('QA-08 regression: API upload finalization reports cross-format text duplicates', async () => {
		if (!pgAvailable) return;

		const sharedBody = [
			'Cross Format Upload Report',
			'',
			'Alpha beta gamma delta epsilon zeta eta theta iota kappa.',
			'This normalized body is shared across CLI ingest and browser upload finalization.',
			'',
		].join('\n');
		const cliTextFile = join(tmpDir, 'cross-format-upload-report.txt');
		writeFileSync(cliTextFile, sharedBody, 'utf-8');

		const first = runCli(['ingest', cliTextFile]);
		expect(first.exitCode, `${first.stdout}\n${first.stderr}`).toBe(0);
		const existingSourceId = sourceIdForFilename('cross-format-upload-report.txt');
		expect(
			db.runSql(
				`SELECT format_metadata->>'cross_format_dedup_basis' FROM sources WHERE id = ${sqlLiteral(existingSourceId)};`,
			),
		).toBe('text_content');

		const uploadContent = Buffer.from(sharedBody.replace('Cross Format Upload Report', '# Cross Format Upload Report'));
		const initiate = await apiPost('/api/uploads/documents/initiate', {
			filename: 'cross-format-upload-report.md',
			size_bytes: uploadContent.byteLength,
			content_type: 'text/markdown',
		});
		expect(initiate.status).toBe(201);
		const initiateBody = await readJson(initiate);
		const provisionalSourceId = String((initiateBody.data as Record<string, unknown>).source_id);
		const storagePath = String((initiateBody.data as Record<string, unknown>).storage_path);
		writeUploadedObject(storagePath, uploadContent);

		const complete = await apiPost('/api/uploads/documents/complete', {
			source_id: provisionalSourceId,
			filename: 'cross-format-upload-report.md',
			storage_path: storagePath,
			start_pipeline: true,
		});
		expect(complete.status).toBe(202);
		const completeBody = await readJson(complete);
		const jobId = String((completeBody.data as Record<string, unknown>).job_id);

		const processed = await processOneJob();
		expect(processed.state).toBe('completed');
		expect(db.runSql('SELECT COUNT(*) FROM sources;')).toBe('1');
		expect(existsSync(resolve(STORAGE_DIR, storagePath))).toBe(false);
		expect(
			db.runSql(
				`SELECT COUNT(*) FROM jobs WHERE type IN ('quality', 'extract') AND payload->>'sourceId' = ${sqlLiteral(provisionalSourceId)};`,
			),
		).toBe('0');

		const finalizePayload = JSON.parse(
			db.runSql(`SELECT payload::text FROM jobs WHERE id = ${sqlLiteral(jobId)};`),
		) as Record<string, unknown>;
		expect(finalizePayload).toMatchObject({
			sourceId: provisionalSourceId,
			result_status: 'duplicate',
			resolved_source_id: existingSourceId,
			duplicate_of_source_id: existingSourceId,
		});
	});

	it('QA-09: duplicate text ingest returns the existing text source', () => {
		if (!pgAvailable) return;

		const first = runCli(['ingest', txtFile]);
		expect(first.exitCode, `${first.stdout}\n${first.stderr}`).toBe(0);
		const second = runCli(['ingest', txtFile]);
		expect(second.exitCode, `${second.stdout}\n${second.stderr}`).toBe(0);
		expect(`${second.stdout}\n${second.stderr}`).toMatch(/duplicate/i);

		const row = db.runSql(
			"SELECT source_type::text, COUNT(*) FROM sources WHERE file_hash = (SELECT file_hash FROM sources WHERE filename = 'note.txt' LIMIT 1) GROUP BY source_type;",
		);
		expect(row).toBe('text|1');
	});
});
