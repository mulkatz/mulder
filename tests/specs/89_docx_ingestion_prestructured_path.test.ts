import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const DOCX_MEDIA_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const PNG_BYTES = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
	'base64',
);

type ApiApp = { request: (input: string | Request, init?: RequestInit) => Promise<Response> };

let tmpDir: string;
let briefDocx: string;
let fakeDocx: string;
let coreModule: typeof import('@mulder/core');
let workerModule: typeof import('@mulder/worker');
let workerContext: WorkerRuntimeContext;
let app: ApiApp;
let pgAvailable = false;
let blobsSnapshot: StorageSnapshot | null = null;
let rawSnapshot: StorageSnapshot | null = null;
let extractedSnapshot: StorageSnapshot | null = null;
let segmentsSnapshot: StorageSnapshot | null = null;

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
	let c = n;
	for (let k = 0; k < 8; k += 1) {
		c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	}
	CRC_TABLE[n] = c >>> 0;
}

function crc32(buffer: Buffer): number {
	let crc = 0xffffffff;
	for (const byte of buffer) {
		crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function createZip(entries: Array<{ name: string; data: Buffer | string }>): Buffer {
	const localParts: Buffer[] = [];
	const centralParts: Buffer[] = [];
	let offset = 0;

	for (const entry of entries) {
		const name = Buffer.from(entry.name, 'utf-8');
		const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf-8');
		const checksum = crc32(data);
		const localHeader = Buffer.alloc(30);
		localHeader.writeUInt32LE(0x04034b50, 0);
		localHeader.writeUInt16LE(20, 4);
		localHeader.writeUInt16LE(0, 6);
		localHeader.writeUInt16LE(0, 8);
		localHeader.writeUInt16LE(0, 10);
		localHeader.writeUInt16LE(0x21, 12);
		localHeader.writeUInt32LE(checksum, 14);
		localHeader.writeUInt32LE(data.length, 18);
		localHeader.writeUInt32LE(data.length, 22);
		localHeader.writeUInt16LE(name.length, 26);
		localHeader.writeUInt16LE(0, 28);
		localParts.push(localHeader, name, data);

		const centralHeader = Buffer.alloc(46);
		centralHeader.writeUInt32LE(0x02014b50, 0);
		centralHeader.writeUInt16LE(20, 4);
		centralHeader.writeUInt16LE(20, 6);
		centralHeader.writeUInt16LE(0, 8);
		centralHeader.writeUInt16LE(0, 10);
		centralHeader.writeUInt16LE(0, 12);
		centralHeader.writeUInt16LE(0x21, 14);
		centralHeader.writeUInt32LE(checksum, 16);
		centralHeader.writeUInt32LE(data.length, 20);
		centralHeader.writeUInt32LE(data.length, 24);
		centralHeader.writeUInt16LE(name.length, 28);
		centralHeader.writeUInt16LE(0, 30);
		centralHeader.writeUInt16LE(0, 32);
		centralHeader.writeUInt16LE(0, 34);
		centralHeader.writeUInt16LE(0, 36);
		centralHeader.writeUInt32LE(0, 38);
		centralHeader.writeUInt32LE(offset, 42);
		centralParts.push(centralHeader, name);

		offset += localHeader.length + name.length + data.length;
	}

	const centralDirectory = Buffer.concat(centralParts);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(0, 4);
	end.writeUInt16LE(0, 6);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(centralDirectory.length, 12);
	end.writeUInt32LE(offset, 16);
	end.writeUInt16LE(0, 20);

	return Buffer.concat([...localParts, centralDirectory, end]);
}

function xmlEscape(value: string): string {
	return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function createDocxBuffer(title: string, body: string): Buffer {
	const heading = xmlEscape(title);
	const paragraph = xmlEscape(body);
	const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${heading ? `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>${heading}</w:t></w:r></w:p>` : ''}
    ${paragraph ? `<w:p><w:r><w:t>${paragraph}</w:t></w:r></w:p>` : ''}
    <w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>
  </w:body>
</w:document>`;
	return createZip([
		{
			name: '[Content_Types].xml',
			data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>`,
		},
		{
			name: '_rels/.rels',
			data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>`,
		},
		{
			name: 'docProps/core.xml',
			data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <dc:title>${heading || 'Untitled'}</dc:title>
</cp:coreProperties>`,
		},
		{
			name: 'word/_rels/document.xml.rels',
			data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
		},
		{
			name: 'word/styles.xml',
			data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>
</w:styles>`,
		},
		{ name: 'word/document.xml', data: documentXml },
	]);
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
			'X-Forwarded-For': '203.0.113.89',
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
	return await workerModule.processNextJob(workerContext, 'spec-89-worker');
}

function insertDocxSource(sourceId: string, storagePath: string, status = 'ingested'): void {
	db.runSql(
		`INSERT INTO sources (id, filename, storage_path, file_hash, page_count, has_native_text, native_text_ratio, status, reliability_score, tags, metadata, source_type, format_metadata)
		 VALUES (${sqlLiteral(sourceId)}, 'corrupt.docx', ${sqlLiteral(storagePath)}, ${sqlLiteral(sourceId.replaceAll('-', ''))}, 0, false, 0, ${sqlLiteral(status)}, NULL, ARRAY[]::text[], '{}'::jsonb, 'docx', ${sqlLiteral(
				JSON.stringify({
					media_type: DOCX_MEDIA_TYPE,
					original_extension: 'docx',
					byte_size: 23,
					office_format: 'docx',
					container: 'office_open_xml',
					extraction_engine: 'mammoth',
				}),
			)}::jsonb);`,
	);
}

beforeAll(async () => {
	pgAvailable = db.isPgAvailable();
	if (!pgAvailable) {
		console.warn('SKIP: PostgreSQL not reachable at PGHOST/PGPORT.');
		return;
	}

	process.env.MULDER_CONFIG = EXAMPLE_CONFIG;
	process.env.MULDER_LOG_LEVEL = 'silent';
	process.env.NODE_ENV = 'test';

	tmpDir = mkdtempSync(join(tmpdir(), 'mulder-qa-89-'));
	briefDocx = join(tmpDir, 'brief.docx');
	fakeDocx = join(tmpDir, 'fake.docx');
	writeFileSync(
		briefDocx,
		createDocxBuffer(
			'Incident Brief',
			'Dev Test Person visited Dev Test Location for a deterministic DOCX extraction check.',
		),
	);
	writeFileSync(fakeDocx, createZip([{ name: 'not-word/readme.txt', data: 'This ZIP is not an Office document.' }]));

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

describe('Spec 89 — DOCX Ingestion on the Pre-Structured Path', () => {
	it('QA-01: CLI dry-run accepts DOCX sources without persistence', () => {
		if (!pgAvailable || !rawSnapshot) return;

		const result = runCli(['ingest', '--dry-run', briefDocx]);
		expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
		expect(result.stdout).toContain('Type');
		expect(result.stdout).toMatch(/\bdocx\b/);
		expect(result.stdout).toMatch(/\bPages\b/);
		expect(result.stdout).toMatch(/\b0\b/);
		expect(db.runSql('SELECT COUNT(*) FROM sources;')).toBe('0');
		expect(addedStorageEntries(rawSnapshot)).toEqual([]);
	});

	it('QA-02: CLI DOCX ingest persists Office metadata', () => {
		if (!pgAvailable) return;

		const result = runCli(['ingest', briefDocx]);
		expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
		expect(result.stdout).toMatch(/\bdocx\b/);

		const sourceId = sourceIdForFilename(basename(briefDocx));
		const row = db
			.runSql(
				`SELECT source_type::text, page_count, has_native_text, native_text_ratio, storage_path, format_metadata->>'media_type' AS media_type, format_metadata->>'original_extension' AS original_extension, format_metadata->>'byte_size' AS byte_size, format_metadata->>'office_format' AS office_format, format_metadata->>'container' AS container, format_metadata->>'extraction_engine' AS extraction_engine FROM sources WHERE id = ${sqlLiteral(sourceId)};`,
			)
			.split('|');
		expect(row).toEqual([
			'docx',
			'0',
			'f',
			'0',
			expect.stringMatching(/^blobs\/sha256\/[a-f0-9]{2}\/[a-f0-9]{2}\/[a-f0-9]{64}\.docx$/),
			DOCX_MEDIA_TYPE,
			'docx',
			String(readFileSync(briefDocx).byteLength),
			'docx',
			'office_open_xml',
			'mammoth',
		]);
		expect(existsSync(resolve(STORAGE_DIR, row[4]))).toBe(true);
	});

	it('QA-03: DOCX detection rejects arbitrary ZIP files', () => {
		if (!pgAvailable) return;

		const result = runCli(['ingest', '--dry-run', fakeDocx]);
		expect(result.exitCode).not.toBe(0);
		expect(`${result.stdout}\n${result.stderr}`).toMatch(/unsupported|invalid|docx|word\/document\.xml/i);
		expect(db.runSql('SELECT COUNT(*) FROM sources;')).toBe('0');
	});

	it('QA-04: directory ingest discovers PDFs, images, text, and DOCX files', () => {
		if (!pgAvailable) return;

		const mixedDir = join(tmpDir, `mixed-${randomUUID()}`);
		mkdirSync(mixedDir, { recursive: true });
		writeFileSync(join(mixedDir, 'sample.pdf'), readFileSync(FIXTURE_PDF));
		writeFileSync(join(mixedDir, 'scan.png'), PNG_BYTES);
		writeFileSync(join(mixedDir, 'note.txt'), 'Plain text note.\n', 'utf-8');
		writeFileSync(join(mixedDir, 'brief.md'), '# Markdown note\n', 'utf-8');
		writeFileSync(join(mixedDir, 'brief.docx'), readFileSync(briefDocx));

		const result = runCli(['ingest', '--dry-run', mixedDir], { timeout: 180_000 });
		expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
		expect(result.stdout).toMatch(/sample\.pdf[\s\S]*\bpdf\b/);
		expect(result.stdout).toMatch(/scan\.png[\s\S]*\bimage\b/);
		expect(result.stdout).toMatch(/note\.txt[\s\S]*\btext\b/);
		expect(result.stdout).toMatch(/brief\.md[\s\S]*\btext\b/);
		expect(result.stdout).toMatch(/brief\.docx[\s\S]*\bdocx\b/);
	});

	it('QA-05: magic bytes remain authoritative', () => {
		if (!pgAvailable) return;

		const pdfRenamedDocx = join(tmpDir, `pdf-renamed-${randomUUID()}.docx`);
		const pngRenamedDocx = join(tmpDir, `png-renamed-${randomUUID()}.docx`);
		writeFileSync(pdfRenamedDocx, readFileSync(FIXTURE_PDF));
		writeFileSync(pngRenamedDocx, PNG_BYTES);

		const pdfResult = runCli(['ingest', '--dry-run', pdfRenamedDocx], { timeout: 180_000 });
		expect(pdfResult.exitCode, `${pdfResult.stdout}\n${pdfResult.stderr}`).toBe(0);
		expect(pdfResult.stdout).toMatch(/\bpdf\b/);

		const imageResult = runCli(['ingest', '--dry-run', pngRenamedDocx]);
		expect(imageResult.exitCode, `${imageResult.stdout}\n${imageResult.stderr}`).toBe(0);
		expect(imageResult.stdout).toMatch(/\bimage\b/);
	});

	it('QA-06: DOCX extract creates a pre-structured story', () => {
		if (!pgAvailable) return;

		const ingest = runCli(['ingest', briefDocx]);
		expect(ingest.exitCode, `${ingest.stdout}\n${ingest.stderr}`).toBe(0);
		const sourceId = sourceIdForFilename(basename(briefDocx));

		const extract = runCli(['extract', sourceId], { timeout: 180_000 });
		expect(extract.exitCode, `${extract.stdout}\n${extract.stderr}`).toBe(0);
		expect(db.runSql(`SELECT status FROM sources WHERE id = ${sqlLiteral(sourceId)};`)).toBe('extracted');
		expect(
			db.runSql(`SELECT status FROM source_steps WHERE source_id = ${sqlLiteral(sourceId)} AND step_name = 'extract';`),
		).toBe('completed');
		expect(db.runSql(`SELECT COUNT(*) FROM stories WHERE source_id = ${sqlLiteral(sourceId)};`)).toBe('1');
		expect(existsSync(resolve(STORAGE_DIR, `extracted/${sourceId}/layout.json`))).toBe(false);

		const storyRow = db.runSql(
			`SELECT id, gcs_markdown_uri, gcs_metadata_uri FROM stories WHERE source_id = ${sqlLiteral(sourceId)};`,
		);
		const [storyId, markdownUri, metadataUri] = storyRow.split('|');
		expect(markdownUri).toBe(`segments/${sourceId}/${storyId}.md`);
		expect(metadataUri).toBe(`segments/${sourceId}/${storyId}.meta.json`);
		expect(existsSync(resolve(STORAGE_DIR, markdownUri))).toBe(true);
		expect(existsSync(resolve(STORAGE_DIR, metadataUri))).toBe(true);
		const markdown = readFileSync(resolve(STORAGE_DIR, markdownUri), 'utf-8');
		expect(markdown).toMatch(/Incident Brief/);
		expect(markdown).toMatch(/Dev Test Person/);
	});

	it('QA-07: extract rejects empty or unreadable DOCX output', () => {
		if (!pgAvailable) return;

		const sourceId = randomUUID();
		const storagePath = `raw/${sourceId}/original.docx`;
		writeUploadedObject(storagePath, Buffer.from('not a valid office document', 'utf-8'));
		insertDocxSource(sourceId, storagePath);

		const extract = runCli(['extract', sourceId], { timeout: 180_000 });
		expect(extract.exitCode).not.toBe(0);
		expect(`${extract.stdout}\n${extract.stderr}`).toMatch(/extract/i);
		expect(`${extract.stdout}\n${extract.stderr}`).toMatch(/docx|office|zip|invalid|corrupt|unreadable/i);
		expect(db.runSql(`SELECT status = 'extracted' FROM sources WHERE id = ${sqlLiteral(sourceId)};`)).toBe('f');
		expect(db.runSql(`SELECT COUNT(*) FROM stories WHERE source_id = ${sqlLiteral(sourceId)};`)).toBe('0');
	});

	it('QA-08: pipeline skips segment for DOCX after extract', () => {
		if (!pgAvailable) return;

		const ingest = runCli(['ingest', briefDocx]);
		expect(ingest.exitCode, `${ingest.stdout}\n${ingest.stderr}`).toBe(0);
		const sourceId = sourceIdForFilename(basename(briefDocx));

		const result = runCli(['pipeline', 'run', '--from', 'extract', '--up-to', 'enrich', '--source-id', sourceId], {
			timeout: 240_000,
		});
		expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
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
		expect(existsSync(resolve(STORAGE_DIR, `extracted/${sourceId}/layout.json`))).toBe(false);
		expect(
			db.runSql(`SELECT COUNT(*) FROM jobs WHERE type = 'segment' AND payload->>'sourceId' = ${sqlLiteral(sourceId)};`),
		).toBe('0');
	});

	it('QA-09: API upload accepts DOCX media type', async () => {
		if (!pgAvailable) return;

		const content = readFileSync(briefDocx);
		const initiate = await apiPost('/api/uploads/documents/initiate', {
			filename: 'brief.docx',
			size_bytes: content.byteLength,
			content_type: DOCX_MEDIA_TYPE,
		});
		expect(initiate.status).toBe(201);
		const initiateBody = await readJson(initiate);
		const sourceId = String((initiateBody.data as Record<string, unknown>).source_id);
		const storagePath = String((initiateBody.data as Record<string, unknown>).storage_path);
		expect(storagePath).toBe(`raw/${sourceId}/original.docx`);
		writeUploadedObject(storagePath, content);

		const complete = await apiPost('/api/uploads/documents/complete', {
			source_id: sourceId,
			filename: 'brief.docx',
			storage_path: storagePath,
			start_pipeline: true,
		});
		expect(complete.status).toBe(202);

		const processed = await processOneJob();
		expect(processed.state).toBe('completed');
		const sourceRow = db
			.runSql(
				`SELECT source_type::text, storage_path, format_metadata->>'media_type' AS media_type, format_metadata->>'original_extension' AS original_extension, format_metadata->>'byte_size' AS byte_size, format_metadata->>'office_format' AS office_format, format_metadata->>'container' AS container, format_metadata->>'extraction_engine' AS extraction_engine FROM sources WHERE id = ${sqlLiteral(sourceId)};`,
			)
			.split('|');
		expect(sourceRow).toEqual([
			'docx',
			expect.stringMatching(/^blobs\/sha256\/[a-f0-9]{2}\/[a-f0-9]{2}\/[a-f0-9]{64}\.docx$/),
			DOCX_MEDIA_TYPE,
			'docx',
			String(content.byteLength),
			'docx',
			'office_open_xml',
			'mammoth',
		]);
		expect(
			db.runSql(
				`SELECT COUNT(*) FROM jobs WHERE type = 'extract' AND status = 'pending' AND payload->>'sourceId' = ${sqlLiteral(sourceId)};`,
			),
		).toBe('1');
	});

	it('QA-10: duplicate DOCX ingest returns the existing source', () => {
		if (!pgAvailable) return;

		const first = runCli(['ingest', briefDocx]);
		expect(first.exitCode, `${first.stdout}\n${first.stderr}`).toBe(0);
		const second = runCli(['ingest', briefDocx]);
		expect(second.exitCode, `${second.stdout}\n${second.stderr}`).toBe(0);
		expect(`${second.stdout}\n${second.stderr}`).toMatch(/duplicate/i);

		const row = db.runSql(
			`SELECT source_type::text, COUNT(*) FROM sources WHERE file_hash = (SELECT file_hash FROM sources WHERE filename = ${sqlLiteral(
				basename(briefDocx),
			)} LIMIT 1) GROUP BY source_type;`,
		);
		expect(row).toBe('docx|1');
	});

	it('QA-11: existing PDF, image, and text behavior remains compatible', () => {
		if (!pgAvailable) return;

		const txtFile = join(tmpDir, `compat-${randomUUID()}.txt`);
		writeFileSync(txtFile, 'Compatibility text note.\n', 'utf-8');

		const pdfResult = runCli(['ingest', '--dry-run', FIXTURE_PDF], { timeout: 180_000 });
		expect(pdfResult.exitCode, `${pdfResult.stdout}\n${pdfResult.stderr}`).toBe(0);
		expect(pdfResult.stdout).toMatch(/\bpdf\b/);

		const pngFile = join(tmpDir, `compat-${randomUUID()}.png`);
		writeFileSync(pngFile, PNG_BYTES);
		const imageResult = runCli(['ingest', '--dry-run', pngFile]);
		expect(imageResult.exitCode, `${imageResult.stdout}\n${imageResult.stderr}`).toBe(0);
		expect(imageResult.stdout).toMatch(/\bimage\b/);

		const textResult = runCli(['ingest', '--dry-run', txtFile]);
		expect(textResult.exitCode, `${textResult.stdout}\n${textResult.stderr}`).toBe(0);
		expect(textResult.stdout).toMatch(/\btext\b/);
	});
});

describe('Spec 89 — CLI Test Matrix', () => {
	it('CLI-MATRIX-01: ingest --dry-run accepts a valid DOCX without persistence', () => {
		if (!pgAvailable) return;

		const result = runCli(['ingest', '--dry-run', briefDocx]);
		expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
		expect(result.stdout).toMatch(/\bdocx\b/);
		expect(result.stdout).toMatch(/\b0\b/);
		expect(db.runSql('SELECT COUNT(*) FROM sources;')).toBe('0');
	});

	it('CLI-MATRIX-02: ingest persists a valid DOCX with canonical raw storage', () => {
		if (!pgAvailable) return;

		const result = runCli(['ingest', briefDocx]);
		expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
		const sourceId = sourceIdForFilename(basename(briefDocx));
		const row = db
			.runSql(`SELECT source_type::text, storage_path FROM sources WHERE id = ${sqlLiteral(sourceId)};`)
			.split('|');
		expect(row[0]).toBe('docx');
		expect(row[1]).toMatch(/^blobs\/sha256\/[a-f0-9]{2}\/[a-f0-9]{2}\/[a-f0-9]{64}\.docx$/);
	});

	it('CLI-MATRIX-03: ingest --dry-run rejects an arbitrary ZIP renamed to DOCX', () => {
		if (!pgAvailable) return;

		const result = runCli(['ingest', '--dry-run', fakeDocx]);
		expect(result.exitCode).not.toBe(0);
		expect(`${result.stdout}\n${result.stderr}`).toMatch(/unsupported|invalid|docx/i);
		expect(db.runSql('SELECT COUNT(*) FROM sources;')).toBe('0');
	});

	it('CLI-MATRIX-04: ingest --dry-run discovers mixed PDF, image, text, Markdown, and DOCX inputs', () => {
		if (!pgAvailable) return;

		const mixedDir = join(tmpDir, `matrix-mixed-${randomUUID()}`);
		mkdirSync(mixedDir, { recursive: true });
		writeFileSync(join(mixedDir, 'sample.pdf'), readFileSync(FIXTURE_PDF));
		writeFileSync(join(mixedDir, 'scan.png'), PNG_BYTES);
		writeFileSync(join(mixedDir, 'note.txt'), 'Plain text note.\n', 'utf-8');
		writeFileSync(join(mixedDir, 'brief.md'), '# Markdown note\n', 'utf-8');
		writeFileSync(join(mixedDir, 'brief.docx'), readFileSync(briefDocx));

		const result = runCli(['ingest', '--dry-run', mixedDir], { timeout: 180_000 });
		expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
		for (const sourceType of ['pdf', 'image', 'text', 'docx']) {
			expect(result.stdout).toMatch(new RegExp(`\\b${sourceType}\\b`));
		}
	});

	it('CLI-MATRIX-05: extract creates one DOCX Markdown story without layout JSON', () => {
		if (!pgAvailable) return;

		const ingest = runCli(['ingest', briefDocx]);
		expect(ingest.exitCode, `${ingest.stdout}\n${ingest.stderr}`).toBe(0);
		const sourceId = sourceIdForFilename(basename(briefDocx));

		const extract = runCli(['extract', sourceId], { timeout: 180_000 });
		expect(extract.exitCode, `${extract.stdout}\n${extract.stderr}`).toBe(0);
		expect(db.runSql(`SELECT COUNT(*) FROM stories WHERE source_id = ${sqlLiteral(sourceId)};`)).toBe('1');
		expect(existsSync(resolve(STORAGE_DIR, `extracted/${sourceId}/layout.json`))).toBe(false);
	});

	it('CLI-MATRIX-06: pipeline run skips segment and enriches the DOCX story', () => {
		if (!pgAvailable) return;

		const ingest = runCli(['ingest', briefDocx]);
		expect(ingest.exitCode, `${ingest.stdout}\n${ingest.stderr}`).toBe(0);
		const sourceId = sourceIdForFilename(basename(briefDocx));

		const result = runCli(['pipeline', 'run', '--from', 'extract', '--up-to', 'enrich', '--source-id', sourceId], {
			timeout: 240_000,
		});
		expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
		expect(
			db.runSql(`SELECT status FROM source_steps WHERE source_id = ${sqlLiteral(sourceId)} AND step_name = 'segment';`),
		).toBe('skipped');
		expect(db.runSql(`SELECT status FROM stories WHERE source_id = ${sqlLiteral(sourceId)};`)).toBe('enriched');
	});
});

describe('Spec 89 — CLI Smoke Coverage', () => {
	it('CLI-SMOKE-01: ingest help exposes mechanical dry-run coverage', () => {
		if (!pgAvailable) return;

		const result = runCli(['ingest', '--help']);
		expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
		expect(`${result.stdout}\n${result.stderr}`).toMatch(/dry-run/);
	});

	it('CLI-SMOKE-02: ingest without an input fails before any source is created', () => {
		if (!pgAvailable) return;

		const result = runCli(['ingest']);
		expect(result.exitCode).not.toBe(0);
		expect(db.runSql('SELECT COUNT(*) FROM sources;')).toBe('0');
	});

	it('CLI-SMOKE-03: ingest --json dry-run accepts DOCX when the flag is available', () => {
		if (!pgAvailable) return;

		const help = runCli(['ingest', '--help']);
		expect(help.exitCode, `${help.stdout}\n${help.stderr}`).toBe(0);
		if (!`${help.stdout}\n${help.stderr}`.includes('--json')) {
			return;
		}

		const result = runCli(['ingest', '--dry-run', '--json', briefDocx]);
		expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
		expect(`${result.stdout}\n${result.stderr}`).toMatch(/\bdocx\b/);
		expect(db.runSql('SELECT COUNT(*) FROM sources;')).toBe('0');
	});

	it('CLI-SMOKE-04: ingest --cost-estimate dry-run remains cost-free for DOCX when available', () => {
		if (!pgAvailable) return;

		const help = runCli(['ingest', '--help']);
		expect(help.exitCode, `${help.stdout}\n${help.stderr}`).toBe(0);
		if (!`${help.stdout}\n${help.stderr}`.includes('--cost-estimate')) {
			return;
		}

		const result = runCli(['ingest', '--dry-run', '--cost-estimate', briefDocx]);
		expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
		expect(`${result.stdout}\n${result.stderr}`).toMatch(/Pages:\s*0/);
		expect(`${result.stdout}\n${result.stderr}`).toMatch(/Total estimated:\s*~\$0\.00/);
		expect(db.runSql('SELECT COUNT(*) FROM sources;')).toBe('0');
	});
});
