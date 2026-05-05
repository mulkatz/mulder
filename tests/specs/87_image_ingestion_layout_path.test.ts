import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DocumentUploadFinalizeJobPayload, WorkerJobEnvelope, WorkerRuntimeContext } from '@mulder/worker';
import type { Pool, PoolClient } from 'pg';
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
const PIPELINE_DIST = resolve(PIPELINE_DIR, 'dist/index.js');
const WORKER_DIST = resolve(WORKER_DIR, 'dist/index.js');
const API_APP_DIST = resolve(API_DIR, 'dist/app.js');
const CLI_DIST = resolve(CLI_DIR, 'dist/index.js');
const EXAMPLE_CONFIG = resolve(ROOT, 'mulder.config.example.yaml');
const FIXTURE_PDF = resolve(ROOT, 'fixtures/raw/native-text-sample.pdf');
const STORAGE_DIR = testStoragePath();
const BLOBS_STORAGE_DIR = resolve(STORAGE_DIR, 'blobs');
const RAW_STORAGE_DIR = resolve(STORAGE_DIR, 'raw');
const EXTRACTED_STORAGE_DIR = resolve(STORAGE_DIR, 'extracted');

const PNG_BYTES = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
	'base64',
);
const JPEG_BYTES = Buffer.from([
	0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
	0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x01, 0x00, 0x01, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11,
	0x01, 0xff, 0xda, 0x00, 0x0c, 0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3f, 0x00, 0x00, 0xff, 0xd9,
]);
const TIFF_BYTES = Buffer.from([
	0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x01, 0x04, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
	0x00, 0x00, 0x00, 0x01, 0x01, 0x04, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
]);

type ApiApp = { request: (input: string | Request, init?: RequestInit) => Promise<Response> };
type PlanPipelineSteps = (input: { sourceType: 'image' }) => {
	executableSteps: string[];
	skippedSteps: string[];
};

let tmpDir: string;
let pngFile: string;
let jpegFile: string;
let tiffFile: string;
let coreModule: typeof import('@mulder/core');
let workerModule: typeof import('@mulder/worker');
let workerContext: WorkerRuntimeContext;
let app: ApiApp;
let planPipelineSteps: PlanPipelineSteps;
let pgAvailable = false;
let blobsSnapshot: StorageSnapshot | null = null;
let rawSnapshot: StorageSnapshot | null = null;
let extractedSnapshot: StorageSnapshot | null = null;

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
	if (!blobsSnapshot || !rawSnapshot || !extractedSnapshot) {
		return;
	}
	cleanStorageDirSince(blobsSnapshot);
	cleanStorageDirSince(rawSnapshot);
	cleanStorageDirSince(extractedSnapshot);
}

function addedStorageEntries(snapshot: StorageSnapshot): string[] {
	if (!existsSync(snapshot.dir)) {
		return [];
	}
	return readdirSync(snapshot.dir)
		.filter((entry) => !snapshot.entries.has(entry))
		.sort();
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
			'X-Forwarded-For': '203.0.113.87',
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

function expectedBlobPath(content: Buffer, extension: string): string {
	const contentHash = createHash('sha256').update(content).digest('hex');
	return coreModule.buildContentAddressedBlobPath(contentHash, extension);
}

async function processOneJob() {
	return await workerModule.processNextJob(workerContext, 'spec-87-worker');
}

async function dispatchFinalizeJob(payload: DocumentUploadFinalizeJobPayload, pool: Pool = workerContext.pool) {
	const job: WorkerJobEnvelope<'document_upload_finalize'> = {
		id: randomUUID(),
		type: 'document_upload_finalize',
		payload,
		status: 'running',
		attempts: 1,
		maxAttempts: 3,
		errorLog: null,
		workerId: 'spec-87-worker',
		createdAt: new Date(),
		startedAt: new Date(),
		finishedAt: null,
	};
	return await workerModule.dispatchJob(job, {
		config: workerContext.config,
		services: workerContext.services,
		pool,
		workerId: 'spec-87-worker',
		logger: workerContext.logger,
	});
}

function withFailingFinalizeCommit(pool: Pool): Pool {
	let shouldFailCommit = true;
	return new Proxy(pool, {
		get(target, property, receiver) {
			if (property === 'connect') {
				return async (): Promise<PoolClient> => {
					const client = await target.connect();
					return new Proxy(client, {
						get(clientTarget, clientProperty, clientReceiver) {
							if (clientProperty === 'query') {
								return async (queryText: unknown, values?: unknown): Promise<unknown> => {
									if (
										shouldFailCommit &&
										typeof queryText === 'string' &&
										queryText.trim().toUpperCase() === 'COMMIT'
									) {
										shouldFailCommit = false;
										throw new Error('simulated finalize commit failure');
									}
									if (values === undefined) {
										return await clientTarget.query(queryText as never);
									}
									return await clientTarget.query(queryText as never, values as never);
								};
							}
							const value = Reflect.get(clientTarget, clientProperty, clientReceiver) as unknown;
							return typeof value === 'function' ? value.bind(clientTarget) : value;
						},
					}) as PoolClient;
				};
			}
			const value = Reflect.get(target, property, receiver) as unknown;
			return typeof value === 'function' ? value.bind(target) : value;
		},
	});
}

describe('Spec 87 — Image Ingestion on the Layout Extraction Path', () => {
	beforeAll(async () => {
		pgAvailable = db.isPgAvailable();
		if (!pgAvailable) {
			console.warn('SKIP: PostgreSQL not reachable at PGHOST/PGPORT.');
			return;
		}
		process.env.MULDER_CONFIG = EXAMPLE_CONFIG;
		process.env.MULDER_LOG_LEVEL = 'silent';
		process.env.NODE_ENV = 'test';

		tmpDir = mkdtempSync(join(tmpdir(), 'mulder-qa-87-'));
		pngFile = join(tmpDir, 'scan.png');
		jpegFile = join(tmpDir, 'scan.jpg');
		tiffFile = join(tmpDir, 'scan.tiff');
		writeFileSync(pngFile, PNG_BYTES);
		writeFileSync(jpegFile, JPEG_BYTES);
		writeFileSync(tiffFile, TIFF_BYTES);
		blobsSnapshot = snapshotStorageDir(BLOBS_STORAGE_DIR);
		rawSnapshot = snapshotStorageDir(RAW_STORAGE_DIR);
		extractedSnapshot = snapshotStorageDir(EXTRACTED_STORAGE_DIR);

		buildPackage(CORE_DIR);
		buildPackage(PIPELINE_DIR);
		buildPackage(WORKER_DIR);
		buildPackage(API_DIR);
		buildPackage(CLI_DIR);

		const migrate = runCli(['db', 'migrate', EXAMPLE_CONFIG], { timeout: 300_000 });
		expect(migrate.exitCode, `${migrate.stdout}\n${migrate.stderr}`).toBe(0);

		coreModule = await import(pathToFileURL(CORE_DIST).href);
		workerModule = await import(pathToFileURL(WORKER_DIST).href);
		const pipelineModule = (await import(pathToFileURL(PIPELINE_DIST).href)) as {
			planPipelineSteps: PlanPipelineSteps;
		};
		planPipelineSteps = pipelineModule.planPipelineSteps;
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
			cleanState();
			resetStorage();
		} catch {
			// Ignore cleanup failures.
		}
		if (tmpDir) {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it('QA-01: CLI dry-run accepts image sources without persistence', () => {
		if (!pgAvailable || !rawSnapshot) return;

		for (const imageFile of [pngFile, jpegFile, tiffFile]) {
			const result = runCli(['ingest', '--dry-run', imageFile]);
			expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
			expect(result.stdout).toContain('Type');
			expect(result.stdout).toMatch(/\bimage\b/);
			expect(result.stdout).toMatch(/\b1\b/);
		}
		expect(db.runSql('SELECT COUNT(*) FROM sources;')).toBe('0');
		expect(addedStorageEntries(rawSnapshot)).toEqual([]);
	});

	it('QA-02: CLI image ingest persists image metadata', () => {
		if (!pgAvailable) return;

		const result = runCli(['ingest', pngFile]);
		expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);

		const sourceId = sourceIdForFilename(basename(pngFile));
		const storagePath = expectedBlobPath(PNG_BYTES, 'png');
		const row = db.runSql(
			`SELECT source_type::text, page_count, has_native_text, native_text_ratio, storage_path, format_metadata->>'media_type' FROM sources WHERE id = ${sqlLiteral(sourceId)};`,
		);
		expect(row).toBe(`image|1|f|0|${storagePath}|image/png`);
		expect(existsSync(resolve(STORAGE_DIR, storagePath))).toBe(true);
	});

	it('QA-03: directory ingest discovers PDFs and images', () => {
		if (!pgAvailable) return;

		const mixedDir = join(tmpDir, 'mixed-dir');
		mkdirSync(mixedDir, { recursive: true });
		writeFileSync(join(mixedDir, 'scan.png'), PNG_BYTES);
		writeFileSync(join(mixedDir, 'native-text-sample.pdf'), readFileSync(FIXTURE_PDF));

		const result = runCli(['ingest', '--dry-run', mixedDir], { timeout: 180_000 });
		expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
		expect(result.stdout).toMatch(/native-text-sample\.pdf[\s\S]*\bpdf\b/);
		expect(result.stdout).toMatch(/scan\.png[\s\S]*\bimage\b/);
	});

	it('QA-04: magic bytes remain authoritative', () => {
		if (!pgAvailable) return;

		const pngRenamedPdf = join(tmpDir, 'png-renamed.pdf');
		const pdfRenamedPng = join(tmpDir, 'pdf-renamed.png');
		writeFileSync(pngRenamedPdf, PNG_BYTES);
		writeFileSync(pdfRenamedPng, readFileSync(FIXTURE_PDF));

		const imageResult = runCli(['ingest', '--dry-run', pngRenamedPdf]);
		expect(imageResult.exitCode, `${imageResult.stdout}\n${imageResult.stderr}`).toBe(0);
		expect(imageResult.stdout).toMatch(/\bimage\b/);

		const pdfResult = runCli(['ingest', '--dry-run', pdfRenamedPng], { timeout: 180_000 });
		expect(pdfResult.exitCode, `${pdfResult.stdout}\n${pdfResult.stderr}`).toBe(0);
		expect(pdfResult.stdout).toMatch(/\bpdf\b/);
	});

	it('QA-05: duplicate image ingest returns the existing source', () => {
		if (!pgAvailable) return;

		const first = runCli(['ingest', pngFile]);
		expect(first.exitCode, `${first.stdout}\n${first.stderr}`).toBe(0);
		const second = runCli(['ingest', pngFile]);
		expect(second.exitCode, `${second.stdout}\n${second.stderr}`).toBe(0);
		expect(`${second.stdout}\n${second.stderr}`).toMatch(/duplicate/i);

		const row = db.runSql(
			"SELECT source_type::text, COUNT(*) FROM sources WHERE file_hash = (SELECT file_hash FROM sources WHERE filename = 'scan.png' LIMIT 1) GROUP BY source_type;",
		);
		expect(row).toBe('image|1');
	});

	it('QA-06: image extract writes layout artifacts and keeps layout path', () => {
		if (!pgAvailable) return;

		const ingest = runCli(['ingest', pngFile]);
		expect(ingest.exitCode, `${ingest.stdout}\n${ingest.stderr}`).toBe(0);
		const sourceId = sourceIdForFilename(basename(pngFile));

		const extract = runCli(['extract', sourceId], { timeout: 180_000 });
		expect(extract.exitCode, `${extract.stdout}\n${extract.stderr}`).toBe(0);
		expect(db.runSql(`SELECT status FROM sources WHERE id = ${sqlLiteral(sourceId)};`)).toBe('extracted');

		const layoutPath = resolve(STORAGE_DIR, `extracted/${sourceId}/layout.json`);
		const pagePath = resolve(STORAGE_DIR, `extracted/${sourceId}/pages/page-001.png`);
		expect(existsSync(layoutPath)).toBe(true);
		expect(existsSync(pagePath)).toBe(true);
		const layout = JSON.parse(readFileSync(layoutPath, 'utf-8')) as { pageCount: number; pages: unknown[] };
		expect(layout.pageCount).toBeGreaterThanOrEqual(1);
		expect(layout.pages.length).toBeGreaterThanOrEqual(1);

		const plan = planPipelineSteps({ sourceType: 'image' });
		expect(plan.executableSteps).toContain('segment');
		expect(plan.skippedSteps).not.toContain('segment');
	});

	it('QA-07: API upload accepts image media types', async () => {
		if (!pgAvailable) return;

		const initiate = await apiPost('/api/uploads/documents/initiate', {
			filename: 'scan.png',
			size_bytes: PNG_BYTES.byteLength,
			content_type: 'image/png',
		});
		expect(initiate.status).toBe(201);
		const initiateBody = await readJson(initiate);
		const sourceId = String((initiateBody.data as Record<string, unknown>).source_id);
		const storagePath = String((initiateBody.data as Record<string, unknown>).storage_path);
		expect(storagePath).toBe(`raw/${sourceId}/original.png`);
		writeUploadedObject(storagePath, PNG_BYTES);

		const complete = await apiPost('/api/uploads/documents/complete', {
			source_id: sourceId,
			filename: 'scan.png',
			storage_path: storagePath,
			start_pipeline: true,
		});
		expect(complete.status).toBe(202);

		const processed = await processOneJob();
		expect(processed.state).toBe('completed');
		const sourceRow = db.runSql(
			`SELECT source_type::text, page_count, has_native_text, native_text_ratio, format_metadata->>'media_type' FROM sources WHERE id = ${sqlLiteral(sourceId)};`,
		);
		expect(sourceRow).toBe('image|1|f|0|image/png');
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

	it('QA-07b: upload finalization canonicalizes storage paths from detected bytes', async () => {
		if (!pgAvailable) return;

		const initiate = await apiPost('/api/uploads/documents/initiate', {
			filename: 'declared.pdf',
			size_bytes: PNG_BYTES.byteLength,
			content_type: 'application/pdf',
		});
		expect(initiate.status).toBe(201);
		const initiateBody = await readJson(initiate);
		const sourceId = String((initiateBody.data as Record<string, unknown>).source_id);
		const declaredStoragePath = String((initiateBody.data as Record<string, unknown>).storage_path);
		expect(declaredStoragePath).toBe(`raw/${sourceId}/original.pdf`);
		writeUploadedObject(declaredStoragePath, PNG_BYTES);

		const complete = await apiPost('/api/uploads/documents/complete', {
			source_id: sourceId,
			filename: 'declared.pdf',
			storage_path: declaredStoragePath,
			start_pipeline: false,
		});
		expect(complete.status).toBe(202);

		const processed = await processOneJob();
		expect(processed.state).toBe('completed');
		const storagePath = expectedBlobPath(PNG_BYTES, 'png');
		const sourceRow = db.runSql(
			`SELECT source_type::text, storage_path, format_metadata->>'media_type' FROM sources WHERE id = ${sqlLiteral(sourceId)};`,
		);
		expect(sourceRow).toBe(`image|${storagePath}|image/png`);
		expect(existsSync(resolve(STORAGE_DIR, storagePath))).toBe(true);
		expect(existsSync(resolve(STORAGE_DIR, declaredStoragePath))).toBe(false);
	});

	it('QA-07c: canonicalization keeps retry payload object until persistence succeeds', async () => {
		if (!pgAvailable) return;

		const sourceId = randomUUID();
		const declaredStoragePath = `raw/${sourceId}/original.pdf`;
		writeUploadedObject(declaredStoragePath, PNG_BYTES);
		const payload: DocumentUploadFinalizeJobPayload = {
			sourceId,
			filename: 'declared.pdf',
			storagePath: declaredStoragePath,
			startPipeline: false,
		};

		await expect(dispatchFinalizeJob(payload, withFailingFinalizeCommit(workerContext.pool))).rejects.toThrow(
			/simulated finalize commit failure/,
		);
		expect(db.runSql(`SELECT COUNT(*) FROM sources WHERE id = ${sqlLiteral(sourceId)};`)).toBe('0');
		expect(existsSync(resolve(STORAGE_DIR, declaredStoragePath))).toBe(true);
		const storagePath = expectedBlobPath(PNG_BYTES, 'png');
		expect(existsSync(resolve(STORAGE_DIR, storagePath))).toBe(true);

		const retryResult = await dispatchFinalizeJob(payload);
		expect(retryResult).toMatchObject({
			result_status: 'created',
			resolved_source_id: sourceId,
		});
		const sourceRow = db.runSql(
			`SELECT source_type::text, storage_path, format_metadata->>'media_type' FROM sources WHERE id = ${sqlLiteral(sourceId)};`,
		);
		expect(sourceRow).toBe(`image|${storagePath}|image/png`);
		expect(existsSync(resolve(STORAGE_DIR, storagePath))).toBe(true);
	});

	it('QA-08: unsupported formats still fail before persistence', () => {
		if (!pgAvailable) return;

		const docxFile = join(tmpDir, 'note.docx');
		writeFileSync(docxFile, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]));
		const result = runCli(['ingest', docxFile]);
		expect(result.exitCode).not.toBe(0);
		expect(`${result.stdout}\n${result.stderr}`).toMatch(
			/unsupported (?:source type|or unknown source format)|INGEST_(?:UNSUPPORTED|UNKNOWN)_SOURCE_TYPE/i,
		);
		expect(db.runSql('SELECT COUNT(*) FROM sources;')).toBe('0');
	});
});
