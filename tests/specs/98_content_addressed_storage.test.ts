import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
const API_DIST = resolve(API_DIR, 'dist/index.js');
const CLI_DIST = resolve(CLI_DIR, 'dist/index.js');
const EXAMPLE_CONFIG = resolve(ROOT, 'mulder.config.example.yaml');
const STORAGE_DIR = testStoragePath();
const BLOBS_STORAGE_DIR = resolve(STORAGE_DIR, 'blobs');
const RAW_STORAGE_DIR = resolve(STORAGE_DIR, 'raw');
const EXTRACTED_STORAGE_DIR = resolve(STORAGE_DIR, 'extracted');
const SEGMENTS_STORAGE_DIR = resolve(STORAGE_DIR, 'segments');

let tmpDir = '';
let pgAvailable = false;
let blobsSnapshot: StorageSnapshot | null = null;
let rawSnapshot: StorageSnapshot | null = null;
let extractedSnapshot: StorageSnapshot | null = null;
let segmentsSnapshot: StorageSnapshot | null = null;
let coreModule: typeof import('@mulder/core');
let workerModule: typeof import('@mulder/worker');
let app: { request: (input: string | Request, init?: RequestInit) => Promise<Response> };
let workerContext: WorkerRuntimeContext;

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

function runCliAsync(
	args: string[],
	opts?: { timeout?: number },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	return new Promise((resolveRun) => {
		const child = spawn('node', [CLI_DIST, ...args], {
			cwd: ROOT,
			stdio: ['ignore', 'pipe', 'pipe'],
			env: cliEnv(),
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		const timeout = setTimeout(() => {
			child.kill('SIGKILL');
		}, opts?.timeout ?? 180_000);

		child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
		child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
		child.on('close', (code) => {
			clearTimeout(timeout);
			resolveRun({
				stdout: Buffer.concat(stdout).toString('utf-8'),
				stderr: Buffer.concat(stderr).toString('utf-8'),
				exitCode: code ?? 1,
			});
		});
	});
}

function combinedOutput(result: { stdout: string; stderr: string }): string {
	return `${result.stdout}\n${result.stderr}`;
}

function sqlLiteral(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
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
			'DELETE FROM custody_steps',
			'DELETE FROM original_sources',
			'DELETE FROM archive_locations',
			'DELETE FROM acquisition_contexts',
			'DELETE FROM archives',
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

function resetStorage(): void {
	for (const snapshot of [blobsSnapshot, rawSnapshot, extractedSnapshot, segmentsSnapshot]) {
		if (snapshot) cleanStorageDirSince(snapshot);
	}
}

function writeFixture(relativePath: string, content: Buffer | string): string {
	const filePath = join(tmpDir, relativePath);
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, content);
	return filePath;
}

function sha256(content: Buffer | string): string {
	return createHash('sha256').update(content).digest('hex');
}

function sourceIdForFilename(filename: string): string {
	return db.runSql(`SELECT id FROM sources WHERE filename = ${sqlLiteral(filename)} ORDER BY created_at DESC LIMIT 1;`);
}

function sourceCountForHash(contentHash: string): number {
	return Number(db.runSql(`SELECT COUNT(*) FROM sources WHERE file_hash = ${sqlLiteral(contentHash)};`));
}

function blobCountForHash(contentHash: string): number {
	return Number(db.runSql(`SELECT COUNT(*) FROM document_blobs WHERE content_hash = ${sqlLiteral(contentHash)};`));
}

function originalFilenameOccurrences(contentHash: string, filename: string): number {
	return Number(
		db.runSql(
			`SELECT COUNT(*) FROM unnest((SELECT original_filenames FROM document_blobs WHERE content_hash = ${sqlLiteral(contentHash)})) AS name WHERE name = ${sqlLiteral(filename)};`,
		),
	);
}

function expectSuccessful(result: { stdout: string; stderr: string; exitCode: number }): void {
	expect(result.exitCode, combinedOutput(result)).toBe(0);
}

function expectedBlobPath(contentHash: string, extension: string): string {
	return coreModule.buildContentAddressedBlobPath(contentHash, extension);
}

function storageObjectPath(storagePath: string): string {
	return resolve(STORAGE_DIR, storagePath);
}

function writeStorageObject(storagePath: string, content: Buffer): void {
	const objectPath = storageObjectPath(storagePath);
	mkdirSync(dirname(objectPath), { recursive: true });
	writeFileSync(objectPath, content);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function installContentAddressedRaceTriggers(): void {
	db.runSql(`
CREATE OR REPLACE FUNCTION spec98_delay_document_blob_insert()
RETURNS trigger AS $$
BEGIN
  IF NEW.storage_path LIKE '%.md' THEN
    PERFORM pg_sleep(0.2);
  ELSE
    PERFORM pg_sleep(2.0);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION spec98_delay_markdown_source_insert()
RETURNS trigger AS $$
BEGIN
  IF NEW.storage_path LIKE '%.md' THEN
    PERFORM pg_sleep(2.0);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS spec98_delay_document_blob_insert ON document_blobs;
CREATE TRIGGER spec98_delay_document_blob_insert
BEFORE INSERT ON document_blobs
FOR EACH ROW
EXECUTE FUNCTION spec98_delay_document_blob_insert();

DROP TRIGGER IF EXISTS spec98_delay_markdown_source_insert ON sources;
CREATE TRIGGER spec98_delay_markdown_source_insert
BEFORE INSERT ON sources
FOR EACH ROW
EXECUTE FUNCTION spec98_delay_markdown_source_insert();
`);
}

function uninstallContentAddressedRaceTriggers(): void {
	db.runSql(`
DROP TRIGGER IF EXISTS spec98_delay_document_blob_insert ON document_blobs;
DROP TRIGGER IF EXISTS spec98_delay_markdown_source_insert ON sources;
DROP FUNCTION IF EXISTS spec98_delay_document_blob_insert();
DROP FUNCTION IF EXISTS spec98_delay_markdown_source_insert();
`);
}

async function apiPost(path: string, body: unknown): Promise<Response> {
	return await app.request(`http://localhost${path}`, {
		method: 'POST',
		headers: {
			Authorization: 'Bearer test-api-key',
			'Content-Type': 'application/json',
			'X-Forwarded-For': '203.0.113.98',
		},
		body: JSON.stringify(body),
	});
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
	return (await response.json()) as Record<string, unknown>;
}

function readJsonCell(sql: string): Record<string, unknown> {
	return JSON.parse(db.runSql(sql)) as Record<string, unknown>;
}

async function processOneJob() {
	return await workerModule.processNextJob(workerContext, 'spec-98-worker');
}

async function submitUpload(args: {
	filename: string;
	content: Buffer;
	contentType: string;
	startPipeline: boolean;
}): Promise<{ sourceId: string; provisionalPath: string; jobId: string }> {
	const initiate = await apiPost('/api/uploads/documents/initiate', {
		filename: args.filename,
		size_bytes: args.content.byteLength,
		content_type: args.contentType,
	});
	const initiateBody = await readJson(initiate);
	expect(initiate.status, JSON.stringify(initiateBody)).toBe(201);
	const sourceId = String((initiateBody.data as Record<string, unknown>).source_id);
	const provisionalPath = String((initiateBody.data as Record<string, unknown>).storage_path);
	writeStorageObject(provisionalPath, args.content);

	const complete = await apiPost('/api/uploads/documents/complete', {
		source_id: sourceId,
		filename: args.filename,
		storage_path: provisionalPath,
		start_pipeline: args.startPipeline,
	});
	const completeBody = await readJson(complete);
	expect(complete.status, JSON.stringify(completeBody)).toBe(202);
	const jobId = String((completeBody.data as Record<string, unknown>).job_id);

	return { sourceId, provisionalPath, jobId };
}

async function finalizeUpload(args: {
	filename: string;
	content: Buffer;
	contentType: string;
	startPipeline: boolean;
}): Promise<{ sourceId: string; provisionalPath: string; jobId: string; finalizePayload: Record<string, unknown> }> {
	const { sourceId, provisionalPath, jobId } = await submitUpload(args);

	const processed = await processOneJob();
	expect(processed.state).toBe('completed');
	const finalizePayload = readJsonCell(`SELECT payload::text FROM jobs WHERE id = ${sqlLiteral(jobId)};`);

	return { sourceId, provisionalPath, jobId, finalizePayload };
}

describe('Spec 98 - Content-addressed raw blob storage', () => {
	beforeAll(async () => {
		process.env.MULDER_CONFIG = EXAMPLE_CONFIG;
		process.env.MULDER_LOG_LEVEL = 'silent';
		process.env.NODE_ENV = 'test';

		tmpDir = mkdtempSync(join(tmpdir(), 'mulder-qa-98-'));
		blobsSnapshot = snapshotStorageDir(BLOBS_STORAGE_DIR);
		rawSnapshot = snapshotStorageDir(RAW_STORAGE_DIR);
		extractedSnapshot = snapshotStorageDir(EXTRACTED_STORAGE_DIR);
		segmentsSnapshot = snapshotStorageDir(SEGMENTS_STORAGE_DIR);

		buildPackage(CORE_DIR);
		buildPackage(PIPELINE_DIR);
		buildPackage(WORKER_DIR);
		buildPackage(API_DIR);
		buildPackage(CLI_DIR);

		coreModule = await import(pathToFileURL(CORE_DIST).href);
		workerModule = await import(pathToFileURL(WORKER_DIST).href);
		const apiModule = await import(pathToFileURL(API_DIST).href);
		app = apiModule.createApp({
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

		pgAvailable = db.isPgAvailable();
		if (!pgAvailable) {
			console.warn('SKIP: PostgreSQL not reachable at PGHOST/PGPORT.');
			return;
		}

		const migrate = runCli(['db', 'migrate', EXAMPLE_CONFIG], { timeout: 300_000 });
		expect(migrate.exitCode, combinedOutput(migrate)).toBe(0);

		const config = coreModule.loadConfig(EXAMPLE_CONFIG);
		const logger = coreModule.createLogger({ level: 'silent' });
		const cloudSqlConfig = config.gcp?.cloud_sql;
		if (!cloudSqlConfig) {
			throw new Error('Expected example config to include gcp.cloud_sql');
		}
		workerContext = {
			config,
			services: coreModule.createServiceRegistry(config, logger),
			pool: coreModule.getWorkerPool(cloudSqlConfig),
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

	it('QA-01: Content-addressed helper produces deterministic partitioned paths', () => {
		const hash = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

		expect(coreModule.buildContentAddressedBlobPath(hash, 'pdf')).toBe(`blobs/sha256/01/23/${hash}.pdf`);
		expect(coreModule.buildContentAddressedBlobPath(hash, '.pdf')).toBe(`blobs/sha256/01/23/${hash}.pdf`);
		expect(() => coreModule.buildContentAddressedBlobPath(hash.toUpperCase(), 'pdf')).toThrow(/SHA-256/i);
		expect(() => coreModule.buildContentAddressedBlobPath('abc123', 'pdf')).toThrow(/SHA-256/i);
		expect(() => coreModule.buildContentAddressedBlobPath(`${hash.slice(0, 63)}g`, 'pdf')).toThrow(/SHA-256/i);
	});

	it('QA-02: Migration creates a durable document blob registry', () => {
		if (!pgAvailable) return;

		const columns = db
			.runSql(
				"SELECT column_name, data_type, udt_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'document_blobs' ORDER BY ordinal_position;",
			)
			.split('\n')
			.filter(Boolean);
		const byName = new Map(columns.map((row) => [row.split('|')[0], row.split('|')]));

		for (const column of [
			'content_hash',
			'mulder_blob_id',
			'storage_path',
			'storage_uri',
			'mime_type',
			'file_size_bytes',
			'storage_status',
			'original_filenames',
			'first_ingested_at',
			'last_accessed_at',
			'integrity_verified_at',
			'integrity_status',
		]) {
			expect(byName.has(column), `Missing document_blobs.${column}`).toBe(true);
		}
		expect(byName.get('content_hash')?.[1]).toBe('text');
		expect(byName.get('mulder_blob_id')?.[2]).toBe('uuid');
		expect(byName.get('original_filenames')?.[1]).toBe('ARRAY');

		const keyColumns = db.runSql(
			"SELECT tc.constraint_type, kcu.column_name FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.constraint_schema = kcu.constraint_schema WHERE tc.table_name = 'document_blobs' ORDER BY tc.constraint_type, kcu.column_name;",
		);
		expect(keyColumns).toContain('PRIMARY KEY|content_hash');
		expect(keyColumns).toContain('UNIQUE|mulder_blob_id');
		expect(keyColumns).toContain('UNIQUE|storage_path');
		expect(keyColumns).toContain('UNIQUE|storage_uri');

		const checks = db.runSql(
			"SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'document_blobs'::regclass AND contype = 'c' ORDER BY conname;",
		);
		expect(checks).toContain('document_blobs_storage_status_check');
		expect(checks).toContain('document_blobs_integrity_status_check');
	});

	it('QA-03: CLI ingest stores raw bytes at the content-addressed path', () => {
		if (!pgAvailable) return;
		const content = 'Spec 98 CLI content-addressed primary ingest.\n';
		const fixture = writeFixture('qa-03/primary.txt', content);
		const contentHash = sha256(content);
		const expectedPath = expectedBlobPath(contentHash, 'txt');

		const ingest = runCli(['ingest', fixture]);
		expectSuccessful(ingest);

		const row = db.runSql(
			`SELECT s.storage_path, s.file_hash, b.content_hash, b.storage_path, b.original_filenames::text FROM sources s JOIN document_blobs b ON b.content_hash = s.file_hash WHERE s.filename = ${sqlLiteral(basename(fixture))};`,
		);
		expect(row).toBe(`${expectedPath}|${contentHash}|${contentHash}|${expectedPath}|{primary.txt}`);
		expect(blobCountForHash(contentHash)).toBe(1);
		expect(existsSync(storageObjectPath(expectedPath))).toBe(true);
	});

	it('QA-04: Exact duplicate CLI ingest does not duplicate blobs or sources', () => {
		if (!pgAvailable) return;
		const content = 'Spec 98 exact duplicate body.\n';
		const fixture = writeFixture('qa-04/same.txt', content);
		const contentHash = sha256(content);

		const first = runCli(['ingest', fixture]);
		expectSuccessful(first);
		const existingSourceId = sourceIdForFilename('same.txt');

		const second = runCli(['ingest', fixture]);
		expectSuccessful(second);
		expect(combinedOutput(second)).toMatch(/duplicate/i);
		expect(combinedOutput(second)).toContain(existingSourceId);
		expect(sourceCountForHash(contentHash)).toBe(1);
		expect(blobCountForHash(contentHash)).toBe(1);
		expect(originalFilenameOccurrences(contentHash, 'same.txt')).toBe(1);
	});

	it('QA-04b: Exact duplicate CLI ingest keeps the first blob object when the submitted extension changes', () => {
		if (!pgAvailable) return;
		const content = '# Spec 98 exact duplicate extension mismatch\n';
		const markdownFixture = writeFixture('qa-04b/original.md', content);
		const textFixture = writeFixture('qa-04b/renamed.txt', content);
		const contentHash = sha256(content);
		const markdownPath = expectedBlobPath(contentHash, 'md');
		const textPath = expectedBlobPath(contentHash, 'txt');

		const first = runCli(['ingest', markdownFixture]);
		expectSuccessful(first);
		const second = runCli(['ingest', textFixture]);
		expectSuccessful(second);

		expect(sourceCountForHash(contentHash)).toBe(1);
		expect(blobCountForHash(contentHash)).toBe(1);
		expect(db.runSql(`SELECT storage_path FROM document_blobs WHERE content_hash = ${sqlLiteral(contentHash)};`)).toBe(
			markdownPath,
		);
		expect(existsSync(storageObjectPath(markdownPath))).toBe(true);
		expect(existsSync(storageObjectPath(textPath))).toBe(false);
		expect(originalFilenameOccurrences(contentHash, 'original.md')).toBe(1);
		expect(originalFilenameOccurrences(contentHash, 'renamed.txt')).toBe(1);
	});

	it('QA-04c: Concurrent same-byte CLI ingests keep source storage aligned with the canonical blob path', async () => {
		if (!pgAvailable) return;
		const content = '# Spec 98 CLI extension race\n';
		const markdownFixture = writeFixture('qa-04c/race.md', content);
		const textFixture = writeFixture('qa-04c/race.txt', content);
		const contentHash = sha256(content);
		const markdownPath = expectedBlobPath(contentHash, 'md');
		const textPath = expectedBlobPath(contentHash, 'txt');

		installContentAddressedRaceTriggers();
		try {
			const markdownIngest = runCliAsync(['ingest', markdownFixture]);
			await sleep(100);
			const textIngest = runCliAsync(['ingest', textFixture]);
			const [markdownResult, textResult] = await Promise.all([markdownIngest, textIngest]);
			expectSuccessful(markdownResult);
			expectSuccessful(textResult);
		} finally {
			uninstallContentAddressedRaceTriggers();
		}

		expect(sourceCountForHash(contentHash)).toBe(1);
		expect(blobCountForHash(contentHash)).toBe(1);
		const blobPath = db.runSql(
			`SELECT storage_path FROM document_blobs WHERE content_hash = ${sqlLiteral(contentHash)};`,
		);
		expect([markdownPath, textPath]).toContain(blobPath);
		const alternatePath = blobPath === markdownPath ? textPath : markdownPath;
		expect(db.runSql(`SELECT storage_path FROM sources WHERE file_hash = ${sqlLiteral(contentHash)};`)).toBe(blobPath);
		expect(existsSync(storageObjectPath(blobPath))).toBe(true);
		expect(existsSync(storageObjectPath(alternatePath))).toBe(false);
		expect(originalFilenameOccurrences(contentHash, 'race.md')).toBe(1);
		expect(originalFilenameOccurrences(contentHash, 'race.txt')).toBe(1);
	});

	it('QA-05: API upload finalization canonicalizes provisional uploads into blob storage', async () => {
		if (!pgAvailable) return;
		const content = Buffer.from('Spec 98 API upload finalization.\n', 'utf-8');
		const contentHash = sha256(content);
		const expectedPath = expectedBlobPath(contentHash, 'txt');

		const finalized = await finalizeUpload({
			filename: 'api-finalize.txt',
			content,
			contentType: 'text/plain',
			startPipeline: true,
		});

		const sourceRow = readJsonCell(
			`SELECT row_to_json(source_row)::text FROM (SELECT id, filename, storage_path, file_hash, status, source_type FROM sources WHERE id = ${sqlLiteral(finalized.sourceId)}) AS source_row;`,
		);
		expect(sourceRow).toMatchObject({
			id: finalized.sourceId,
			filename: 'api-finalize.txt',
			storage_path: expectedPath,
			file_hash: contentHash,
			status: 'ingested',
			source_type: 'text',
		});
		expect(blobCountForHash(contentHash)).toBe(1);
		expect(db.runSql(`SELECT storage_path FROM document_blobs WHERE content_hash = ${sqlLiteral(contentHash)};`)).toBe(
			expectedPath,
		);
		expect(existsSync(storageObjectPath(expectedPath))).toBe(true);
		expect(existsSync(storageObjectPath(finalized.provisionalPath))).toBe(false);
		expect(Number(db.runSql("SELECT COUNT(*) FROM jobs WHERE type = 'quality' AND status = 'pending';"))).toBe(1);
		expect(Number(db.runSql("SELECT COUNT(*) FROM jobs WHERE type = 'extract' AND status = 'pending';"))).toBe(0);
		expect(finalized.finalizePayload).toMatchObject({
			sourceId: finalized.sourceId,
			result_status: 'created',
			resolved_source_id: finalized.sourceId,
		});
	});

	it('QA-06: API exact duplicate upload cleans up the provisional object', async () => {
		if (!pgAvailable) return;
		const content = Buffer.from('Spec 98 API exact duplicate upload.\n', 'utf-8');
		const contentHash = sha256(content);

		const first = await finalizeUpload({
			filename: 'first-api-copy.txt',
			content,
			contentType: 'text/plain',
			startPipeline: false,
		});
		const second = await finalizeUpload({
			filename: 'second-api-copy.txt',
			content,
			contentType: 'text/plain',
			startPipeline: true,
		});

		expect(sourceCountForHash(contentHash)).toBe(1);
		expect(blobCountForHash(contentHash)).toBe(1);
		expect(existsSync(storageObjectPath(second.provisionalPath))).toBe(false);
		expect(
			Number(
				db.runSql(
					`SELECT COUNT(*) FROM jobs WHERE type IN ('quality', 'extract') AND payload->>'sourceId' = ${sqlLiteral(second.sourceId)};`,
				),
			),
		).toBe(0);
		expect(second.finalizePayload).toMatchObject({
			sourceId: second.sourceId,
			result_status: 'duplicate',
			resolved_source_id: first.sourceId,
			duplicate_of_source_id: first.sourceId,
		});
	});

	it('QA-06c: API upload finalize retry cleans up a provisional object when the source already exists', async () => {
		if (!pgAvailable) return;
		const content = Buffer.from('Spec 98 API retry cleanup.\n', 'utf-8');

		const first = await finalizeUpload({
			filename: 'retry-cleanup.txt',
			content,
			contentType: 'text/plain',
			startPipeline: false,
		});

		writeStorageObject(first.provisionalPath, content);
		expect(existsSync(storageObjectPath(first.provisionalPath))).toBe(true);

		const retryJobId = db.runSql(
			`INSERT INTO jobs (type, payload, max_attempts) VALUES ('document_upload_finalize', ${sqlLiteral(
				JSON.stringify({
					sourceId: first.sourceId,
					filename: 'retry-cleanup.txt',
					storagePath: first.provisionalPath,
					startPipeline: true,
				}),
			)}::jsonb, 3) RETURNING id;`,
		);

		const processed = await processOneJob();
		expect(processed.state).toBe('completed');
		expect(existsSync(storageObjectPath(first.provisionalPath))).toBe(false);
		expect(
			Number(
				db.runSql(
					`SELECT COUNT(*) FROM jobs WHERE type IN ('quality', 'extract') AND payload->>'sourceId' = ${sqlLiteral(first.sourceId)};`,
				),
			),
		).toBe(0);
		expect(readJsonCell(`SELECT payload::text FROM jobs WHERE id = ${sqlLiteral(retryJobId)};`)).toMatchObject({
			sourceId: first.sourceId,
			result_status: 'created',
			resolved_source_id: first.sourceId,
		});
	});

	it('QA-06b: API exact duplicate upload keeps the first blob object when the submitted extension changes', async () => {
		if (!pgAvailable) return;
		const content = Buffer.from('# Spec 98 API duplicate extension mismatch\n', 'utf-8');
		const contentHash = sha256(content);
		const markdownPath = expectedBlobPath(contentHash, 'md');
		const textPath = expectedBlobPath(contentHash, 'txt');

		const first = await finalizeUpload({
			filename: 'first-api-copy.md',
			content,
			contentType: 'text/markdown',
			startPipeline: false,
		});
		const second = await finalizeUpload({
			filename: 'second-api-copy.txt',
			content,
			contentType: 'text/plain',
			startPipeline: true,
		});

		expect(sourceCountForHash(contentHash)).toBe(1);
		expect(blobCountForHash(contentHash)).toBe(1);
		expect(db.runSql(`SELECT storage_path FROM document_blobs WHERE content_hash = ${sqlLiteral(contentHash)};`)).toBe(
			markdownPath,
		);
		expect(existsSync(storageObjectPath(markdownPath))).toBe(true);
		expect(existsSync(storageObjectPath(textPath))).toBe(false);
		expect(existsSync(storageObjectPath(second.provisionalPath))).toBe(false);
		expect(originalFilenameOccurrences(contentHash, 'first-api-copy.md')).toBe(1);
		expect(originalFilenameOccurrences(contentHash, 'second-api-copy.txt')).toBe(1);
		expect(second.finalizePayload).toMatchObject({
			sourceId: second.sourceId,
			result_status: 'duplicate',
			resolved_source_id: first.sourceId,
			duplicate_of_source_id: first.sourceId,
		});
	});

	it('QA-06d: Concurrent upload finalization keeps source storage aligned with the canonical blob path', async () => {
		if (!pgAvailable) return;
		const content = Buffer.from('# Spec 98 API extension race\n', 'utf-8');
		const contentHash = sha256(content);
		const markdownPath = expectedBlobPath(contentHash, 'md');
		const textPath = expectedBlobPath(contentHash, 'txt');

		const first = await submitUpload({
			filename: 'api-race.md',
			content,
			contentType: 'text/markdown',
			startPipeline: false,
		});
		const second = await submitUpload({
			filename: 'api-race.txt',
			content,
			contentType: 'text/plain',
			startPipeline: false,
		});

		installContentAddressedRaceTriggers();
		try {
			const [firstProcessed, secondProcessed] = await Promise.all([processOneJob(), processOneJob()]);
			expect(firstProcessed.state).toBe('completed');
			expect(secondProcessed.state).toBe('completed');
		} finally {
			uninstallContentAddressedRaceTriggers();
		}

		const firstPayload = readJsonCell(`SELECT payload::text FROM jobs WHERE id = ${sqlLiteral(first.jobId)};`);
		const secondPayload = readJsonCell(`SELECT payload::text FROM jobs WHERE id = ${sqlLiteral(second.jobId)};`);
		const resolvedSourceId = String(firstPayload.resolved_source_id ?? secondPayload.resolved_source_id);

		expect(sourceCountForHash(contentHash)).toBe(1);
		expect(blobCountForHash(contentHash)).toBe(1);
		const blobPath = db.runSql(
			`SELECT storage_path FROM document_blobs WHERE content_hash = ${sqlLiteral(contentHash)};`,
		);
		expect([markdownPath, textPath]).toContain(blobPath);
		const alternatePath = blobPath === markdownPath ? textPath : markdownPath;
		expect(
			db.runSql(
				`SELECT storage_path FROM sources WHERE id = ${sqlLiteral(resolvedSourceId)} AND file_hash = ${sqlLiteral(contentHash)};`,
			),
		).toBe(blobPath);
		expect(existsSync(storageObjectPath(blobPath))).toBe(true);
		expect(existsSync(storageObjectPath(alternatePath))).toBe(false);
		expect(existsSync(storageObjectPath(first.provisionalPath))).toBe(false);
		expect(existsSync(storageObjectPath(second.provisionalPath))).toBe(false);
	});

	it('QA-07: Cross-format duplicate behavior remains unchanged', () => {
		if (!pgAvailable) return;
		const reportText = 'Spec 98 Cross-Format Duplicate Report\n\nAlpha beta gamma.\n';
		const reportTxt = writeFixture('qa-07/report.txt', reportText);
		const markdownContent = reportText.replaceAll('\n', '\r\n');
		const reportMd = writeFixture('qa-07/report.md', markdownContent);
		const textHash = sha256(reportText);
		const markdownHash = sha256(markdownContent);

		const first = runCli(['ingest', reportTxt]);
		expectSuccessful(first);
		const existingSourceId = sourceIdForFilename('report.txt');

		const second = runCli(['ingest', reportMd]);
		expectSuccessful(second);

		expect(combinedOutput(second)).toMatch(/duplicate/i);
		expect(combinedOutput(second)).toContain(existingSourceId);
		expect(db.runSql('SELECT COUNT(*) FROM sources;')).toBe('1');
		expect(blobCountForHash(textHash)).toBe(1);
		expect(blobCountForHash(markdownHash)).toBe(0);
		expect(existsSync(storageObjectPath(expectedBlobPath(markdownHash, 'md')))).toBe(false);
	});

	it('QA-08: Derived artifacts remain source-addressed', () => {
		if (!pgAvailable) return;
		const content = '# note\n\nSpec 98 derived artifact body.\n';
		const fixture = writeFixture('qa-08/note.txt', content);

		const ingest = runCli(['ingest', fixture]);
		expectSuccessful(ingest);
		const sourceId = sourceIdForFilename('note.txt');
		const contentHash = sha256(content);
		expect(db.runSql(`SELECT storage_path FROM sources WHERE id = ${sqlLiteral(sourceId)};`)).toBe(
			expectedBlobPath(contentHash, 'txt'),
		);

		const extract = runCli(['extract', sourceId], { timeout: 180_000 });
		expectSuccessful(extract);

		const storyRow = db.runSql(
			`SELECT id, gcs_markdown_uri, gcs_metadata_uri FROM stories WHERE source_id = ${sqlLiteral(sourceId)};`,
		);
		const [storyId, markdownUri, metadataUri] = storyRow.split('|');
		expect(markdownUri).toBe(`segments/${sourceId}/${storyId}.md`);
		expect(metadataUri).toBe(`segments/${sourceId}/${storyId}.meta.json`);
		expect(existsSync(storageObjectPath(markdownUri))).toBe(true);
		expect(existsSync(storageObjectPath(metadataUri))).toBe(true);
		expect(existsSync(resolve(EXTRACTED_STORAGE_DIR, sourceId, 'layout.json'))).toBe(false);
	});

	it('CLI-01: mulder ingest --dry-run <fixture> validates without creating rows or objects', () => {
		if (!pgAvailable) return;
		const content = 'Spec 98 dry-run fixture.\n';
		const fixture = writeFixture('cli-01/dry-run.txt', content);
		const contentHash = sha256(content);
		const expectedPath = expectedBlobPath(contentHash, 'txt');

		const dryRun = runCli(['ingest', '--dry-run', fixture]);
		expectSuccessful(dryRun);
		expect(dryRun.stdout).toMatch(/\btext\b/);
		expect(dryRun.stdout).toMatch(/\bvalidated\b/i);
		expect(sourceCountForHash(contentHash)).toBe(0);
		expect(blobCountForHash(contentHash)).toBe(0);
		expect(existsSync(storageObjectPath(expectedPath))).toBe(false);
	});

	it('CLI-02: mulder ingest <fixture> stores first exact file ingest at the blob path', () => {
		if (!pgAvailable) return;
		const content = 'Spec 98 CLI matrix first ingest.\n';
		const fixture = writeFixture('cli-02/first.txt', content);
		const contentHash = sha256(content);
		const expectedPath = expectedBlobPath(contentHash, 'txt');

		const ingest = runCli(['ingest', fixture]);
		expectSuccessful(ingest);

		expect(db.runSql(`SELECT storage_path FROM sources WHERE file_hash = ${sqlLiteral(contentHash)};`)).toBe(
			expectedPath,
		);
		expect(blobCountForHash(contentHash)).toBe(1);
		expect(existsSync(storageObjectPath(expectedPath))).toBe(true);
	});

	it('CLI-03: mulder ingest <fixture> re-ingest same bytes reports duplicate with one source and blob', () => {
		if (!pgAvailable) return;
		const content = 'Spec 98 CLI matrix duplicate ingest.\n';
		const fixture = writeFixture('cli-03/reingest.txt', content);
		const contentHash = sha256(content);

		const first = runCli(['ingest', fixture]);
		expectSuccessful(first);
		const existingSourceId = sourceIdForFilename('reingest.txt');
		const second = runCli(['ingest', fixture]);
		expectSuccessful(second);

		expect(combinedOutput(second)).toMatch(/duplicate/i);
		expect(combinedOutput(second)).toContain(existingSourceId);
		expect(sourceCountForHash(contentHash)).toBe(1);
		expect(blobCountForHash(contentHash)).toBe(1);
	});

	it('CLI-04: mulder ingest <fixture-copy-with-different-name> records the alternate filename once', () => {
		if (!pgAvailable) return;
		const content = 'Spec 98 CLI matrix alternate filename duplicate.\n';
		const firstFixture = writeFixture('cli-04/original-name.txt', content);
		const secondFixture = writeFixture('cli-04/alternate-name.txt', content);
		const contentHash = sha256(content);

		const first = runCli(['ingest', firstFixture]);
		expectSuccessful(first);
		const existingSourceId = sourceIdForFilename('original-name.txt');
		const second = runCli(['ingest', secondFixture]);
		expectSuccessful(second);

		expect(combinedOutput(second)).toMatch(/duplicate/i);
		expect(combinedOutput(second)).toContain(existingSourceId);
		expect(sourceCountForHash(contentHash)).toBe(1);
		expect(blobCountForHash(contentHash)).toBe(1);
		expect(originalFilenameOccurrences(contentHash, 'original-name.txt')).toBe(1);
		expect(originalFilenameOccurrences(contentHash, 'alternate-name.txt')).toBe(1);
	});

	describe('CLI discovery smoke', () => {
		it('mulder ingest exposes help and rejects missing required input', () => {
			const help = runCli(['ingest', '--help']);
			expectSuccessful(help);
			expect(help.stdout).toMatch(/dry-run/);

			const missingInput = runCli(['ingest']);
			expect(missingInput.exitCode).not.toBe(0);
			expect(combinedOutput(missingInput)).toMatch(/argument|missing|required/i);
		});
	});
});
