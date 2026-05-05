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
const CSV_MEDIA_TYPE = 'text/csv';
const XLSX_MEDIA_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const PNG_BYTES = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
	'base64',
);

type ApiApp = { request: (input: string | Request, init?: RequestInit) => Promise<Response> };

let tmpDir: string;
let csvFile: string;
let xlsxFile: string;
let largeCsvFile: string;
let invalidCsvFile: string;
let binaryCsvFile: string;
let fakeXlsxFile: string;
let briefDocx: string;
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
	return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function columnName(index: number): string {
	let name = '';
	let value = index + 1;
	while (value > 0) {
		const remainder = (value - 1) % 26;
		name = String.fromCharCode(65 + remainder) + name;
		value = Math.floor((value - 1) / 26);
	}
	return name;
}

function worksheetXml(rows: string[][]): string {
	const xmlRows = rows
		.map((row, rowIndex) => {
			const rowNumber = rowIndex + 1;
			const cells = row
				.map((value, columnIndex) => {
					const ref = `${columnName(columnIndex)}${rowNumber}`;
					return `<c r="${ref}" t="inlineStr"><is><t>${xmlEscape(value)}</t></is></c>`;
				})
				.join('');
			return `<row r="${rowNumber}">${cells}</row>`;
		})
		.join('');
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${xmlRows}</sheetData></worksheet>`;
}

function createXlsxBuffer(sheets: Array<{ name: string; rows: string[][] }>): Buffer {
	const sheetOverrides = sheets
		.map(
			(_sheet, index) =>
				`<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
		)
		.join('');
	const workbookSheets = sheets
		.map((sheet, index) => `<sheet name="${xmlEscape(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`)
		.join('');
	const workbookRels = sheets
		.map(
			(_sheet, index) =>
				`<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`,
		)
		.join('');
	return createZip([
		{
			name: '[Content_Types].xml',
			data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  ${sheetOverrides}
</Types>`,
		},
		{
			name: '_rels/.rels',
			data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`,
		},
		{
			name: 'xl/workbook.xml',
			data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${workbookSheets}</sheets></workbook>`,
		},
		{
			name: 'xl/_rels/workbook.xml.rels',
			data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${workbookRels}</Relationships>`,
		},
		...sheets.map((sheet, index) => ({
			name: `xl/worksheets/sheet${index + 1}.xml`,
			data: worksheetXml(sheet.rows),
		})),
	]);
}

function createDocxBuffer(title: string, body: string): Buffer {
	const heading = xmlEscape(title);
	const paragraph = xmlEscape(body);
	return createZip([
		{
			name: '[Content_Types].xml',
			data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
		},
		{
			name: '_rels/.rels',
			data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
		},
		{
			name: 'word/document.xml',
			data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${heading}</w:t></w:r></w:p><w:p><w:r><w:t>${paragraph}</w:t></w:r></w:p></w:body></w:document>`,
		},
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
			'X-Forwarded-For': '203.0.113.90',
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
	return await workerModule.processNextJob(workerContext, 'spec-90-worker');
}

function storyMarkdownForSource(sourceId: string): string {
	const row = db.runSql(
		`SELECT gcs_markdown_uri FROM stories WHERE source_id = ${sqlLiteral(sourceId)} ORDER BY title LIMIT 1;`,
	);
	return readFileSync(resolve(STORAGE_DIR, row), 'utf-8');
}

function storyMetadataForSource(sourceId: string): Record<string, unknown> {
	const row = db.runSql(
		`SELECT gcs_metadata_uri FROM stories WHERE source_id = ${sqlLiteral(sourceId)} ORDER BY title LIMIT 1;`,
	);
	return JSON.parse(readFileSync(resolve(STORAGE_DIR, row), 'utf-8')) as Record<string, unknown>;
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

	tmpDir = mkdtempSync(join(tmpdir(), 'mulder-qa-90-'));
	csvFile = join(tmpDir, 'table.csv');
	xlsxFile = join(tmpDir, 'book.xlsx');
	largeCsvFile = join(tmpDir, 'large-table.csv');
	invalidCsvFile = join(tmpDir, 'bad.csv');
	binaryCsvFile = join(tmpDir, 'binary.csv');
	fakeXlsxFile = join(tmpDir, 'fake.xlsx');
	briefDocx = join(tmpDir, 'brief.docx');

	writeFileSync(
		csvFile,
		[
			'name,date,city,email,url,invoice_id',
			'Ada Lovelace,2026-04-30,London,ada@example.com,https://example.com/case/1,INV-1001',
			'Grace Hopper,2026-05-01,Arlington,grace@example.com,https://example.com/case/2,INV-1002',
		].join('\n'),
		'utf-8',
	);
	writeFileSync(
		xlsxFile,
		createXlsxBuffer([
			{
				name: 'People',
				rows: [
					['name', 'email', 'city'],
					['Ada Lovelace', 'ada@example.com', 'London'],
				],
			},
			{
				name: 'Organizations',
				rows: [
					['company', 'url', 'reference'],
					['Mulder Labs', 'https://example.com/org', 'ORG-1'],
				],
			},
			{ name: 'Empty', rows: [] },
		]),
	);
	writeFileSync(
		largeCsvFile,
		[
			'name,email,city',
			...Array.from(
				{ length: 205 },
				(_value, index) => `Person ${index + 1},p${index + 1}@example.com,City ${index + 1}`,
			),
		].join('\n'),
		'utf-8',
	);
	writeFileSync(invalidCsvFile, 'just one undelimited line\nsecond undelimited line\n', 'utf-8');
	writeFileSync(binaryCsvFile, Buffer.from([0xff, 0x00, 0x80, 0x81, 0x82]));
	writeFileSync(
		fakeXlsxFile,
		createZip([{ name: 'not-spreadsheet/readme.txt', data: 'This ZIP is not an XLSX workbook.' }]),
	);
	writeFileSync(briefDocx, createDocxBuffer('Brief', 'DOCX magic byte compatibility check.'));

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

describe('Spec 90 — Spreadsheet Ingestion on the Pre-Structured Path', () => {
	it('QA-01: CLI dry-run accepts CSV sources without persistence', () => {
		if (!pgAvailable) return;

		const result = runCli(['ingest', '--dry-run', csvFile]);
		expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
		expect(result.stdout).toContain('Type');
		expect(result.stdout).toMatch(/\bspreadsheet\b/);
		expect(result.stdout).toMatch(/\bPages\b/);
		expect(result.stdout).toMatch(/\b0\b/);
		expect(db.runSql('SELECT COUNT(*) FROM sources;')).toBe('0');
	});

	it('QA-02: CLI dry-run accepts XLSX sources without persistence', () => {
		if (!pgAvailable) return;

		const result = runCli(['ingest', '--dry-run', xlsxFile]);
		expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
		expect(result.stdout).toContain('Type');
		expect(result.stdout).toMatch(/\bspreadsheet\b/);
		expect(result.stdout).toMatch(/\bPages\b/);
		expect(result.stdout).toMatch(/\b0\b/);
		expect(db.runSql('SELECT COUNT(*) FROM sources;')).toBe('0');
	});

	it('QA-03: CLI spreadsheet ingest persists tabular metadata', () => {
		if (!pgAvailable) return;

		const csv = runCli(['ingest', csvFile]);
		expect(csv.exitCode, `${csv.stdout}\n${csv.stderr}`).toBe(0);
		const csvSourceId = sourceIdForFilename(basename(csvFile));
		const csvRow = db
			.runSql(
				`SELECT source_type::text, page_count, has_native_text, native_text_ratio, storage_path, format_metadata->>'media_type', format_metadata->>'original_extension', format_metadata->>'tabular_format', format_metadata->>'container', format_metadata->>'encoding', format_metadata->>'delimiter' FROM sources WHERE id = ${sqlLiteral(csvSourceId)};`,
			)
			.split('|');
		expect(csvRow).toEqual([
			'spreadsheet',
			'0',
			'f',
			'0',
			expect.stringMatching(/^blobs\/sha256\/[a-f0-9]{2}\/[a-f0-9]{2}\/[a-f0-9]{64}\.csv$/),
			CSV_MEDIA_TYPE,
			'csv',
			'csv',
			'delimited_text',
			'utf-8',
			',',
		]);
		expect(existsSync(resolve(STORAGE_DIR, csvRow[4]))).toBe(true);

		const xlsx = runCli(['ingest', xlsxFile]);
		expect(xlsx.exitCode, `${xlsx.stdout}\n${xlsx.stderr}`).toBe(0);
		const xlsxSourceId = sourceIdForFilename(basename(xlsxFile));
		const xlsxRow = db
			.runSql(
				`SELECT source_type::text, page_count, has_native_text, native_text_ratio, storage_path, format_metadata->>'media_type', format_metadata->>'original_extension', format_metadata->>'tabular_format', format_metadata->>'container', format_metadata ? 'parser_engine', format_metadata ? 'sheet_count', format_metadata ? 'sheet_names', format_metadata ? 'table_summaries' FROM sources WHERE id = ${sqlLiteral(xlsxSourceId)};`,
			)
			.split('|');
		expect(xlsxRow).toEqual([
			'spreadsheet',
			'0',
			'f',
			'0',
			expect.stringMatching(/^blobs\/sha256\/[a-f0-9]{2}\/[a-f0-9]{2}\/[a-f0-9]{64}\.xlsx$/),
			XLSX_MEDIA_TYPE,
			'xlsx',
			'xlsx',
			'office_open_xml',
			't',
			't',
			't',
			't',
		]);
		expect(existsSync(resolve(STORAGE_DIR, xlsxRow[4]))).toBe(true);
	});

	it('QA-04: Spreadsheet detection rejects arbitrary ZIP files', () => {
		if (!pgAvailable) return;

		const result = runCli(['ingest', '--dry-run', fakeXlsxFile]);
		expect(result.exitCode).not.toBe(0);
		expect(`${result.stdout}\n${result.stderr}`).toMatch(/unsupported|invalid|spreadsheet|xlsx|workbook/i);
		expect(db.runSql('SELECT COUNT(*) FROM sources;')).toBe('0');
	});

	it('QA-05: CSV detection rejects unreadable or shape-invalid CSV files', () => {
		if (!pgAvailable) return;

		for (const badFile of [invalidCsvFile, binaryCsvFile]) {
			const result = runCli(['ingest', '--dry-run', badFile]);
			expect(result.exitCode).not.toBe(0);
			expect(`${result.stdout}\n${result.stderr}`).toMatch(/unsupported|invalid|spreadsheet|csv|delimited|UTF-8/i);
			expect(db.runSql('SELECT COUNT(*) FROM sources;')).toBe('0');
		}
	});

	it('QA-06: Directory ingest discovers PDFs, images, text, DOCX, and spreadsheets', () => {
		if (!pgAvailable) return;

		const mixedDir = join(tmpDir, `mixed-${randomUUID()}`);
		mkdirSync(mixedDir, { recursive: true });
		writeFileSync(join(mixedDir, 'sample.pdf'), readFileSync(FIXTURE_PDF));
		writeFileSync(join(mixedDir, 'scan.png'), PNG_BYTES);
		writeFileSync(join(mixedDir, 'note.txt'), 'Plain text note.\n', 'utf-8');
		writeFileSync(join(mixedDir, 'brief.docx'), readFileSync(briefDocx));
		writeFileSync(join(mixedDir, 'table.csv'), readFileSync(csvFile));
		writeFileSync(join(mixedDir, 'book.xlsx'), readFileSync(xlsxFile));

		const result = runCli(['ingest', '--dry-run', mixedDir], { timeout: 180_000 });
		expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
		expect(result.stdout).toMatch(/sample\.pdf[\s\S]*\bpdf\b/);
		expect(result.stdout).toMatch(/scan\.png[\s\S]*\bimage\b/);
		expect(result.stdout).toMatch(/note\.txt[\s\S]*\btext\b/);
		expect(result.stdout).toMatch(/brief\.docx[\s\S]*\bdocx\b/);
		expect(result.stdout).toMatch(/table\.csv[\s\S]*\bspreadsheet\b/);
		expect(result.stdout).toMatch(/book\.xlsx[\s\S]*\bspreadsheet\b/);
	});

	it('QA-07: Magic bytes remain authoritative', () => {
		if (!pgAvailable) return;

		const pdfRenamedCsv = join(tmpDir, `pdf-renamed-${randomUUID()}.csv`);
		const pngRenamedXlsx = join(tmpDir, `png-renamed-${randomUUID()}.xlsx`);
		const docxRenamedCsv = join(tmpDir, `docx-renamed-${randomUUID()}.csv`);
		writeFileSync(pdfRenamedCsv, readFileSync(FIXTURE_PDF));
		writeFileSync(pngRenamedXlsx, PNG_BYTES);
		writeFileSync(docxRenamedCsv, readFileSync(briefDocx));

		const pdfResult = runCli(['ingest', '--dry-run', pdfRenamedCsv], { timeout: 180_000 });
		expect(pdfResult.exitCode, `${pdfResult.stdout}\n${pdfResult.stderr}`).toBe(0);
		expect(pdfResult.stdout).toMatch(/\bpdf\b/);

		const imageResult = runCli(['ingest', '--dry-run', pngRenamedXlsx]);
		expect(imageResult.exitCode, `${imageResult.stdout}\n${imageResult.stderr}`).toBe(0);
		expect(imageResult.stdout).toMatch(/\bimage\b/);

		const docxResult = runCli(['ingest', '--dry-run', docxRenamedCsv]);
		expect(docxResult.exitCode, `${docxResult.stdout}\n${docxResult.stderr}`).toBe(0);
		expect(docxResult.stdout).toMatch(/\bdocx\b/);
	});

	it('QA-08: CSV extract creates a pre-structured table story', () => {
		if (!pgAvailable) return;

		const ingest = runCli(['ingest', csvFile]);
		expect(ingest.exitCode, `${ingest.stdout}\n${ingest.stderr}`).toBe(0);
		const sourceId = sourceIdForFilename(basename(csvFile));

		const extract = runCli(['extract', sourceId], { timeout: 180_000 });
		expect(extract.exitCode, `${extract.stdout}\n${extract.stderr}`).toBe(0);
		expect(db.runSql(`SELECT status FROM sources WHERE id = ${sqlLiteral(sourceId)};`)).toBe('extracted');
		expect(
			db.runSql(`SELECT status FROM source_steps WHERE source_id = ${sqlLiteral(sourceId)} AND step_name = 'extract';`),
		).toBe('completed');
		expect(db.runSql(`SELECT COUNT(*) FROM stories WHERE source_id = ${sqlLiteral(sourceId)};`)).toBe('1');
		expect(existsSync(resolve(STORAGE_DIR, `extracted/${sourceId}/layout.json`))).toBe(false);
		const markdown = storyMarkdownForSource(sourceId);
		expect(markdown).toMatch(/\| name \| date \| city \| email \| url \| invoice_id \|/i);
		expect(markdown).toMatch(/Ada Lovelace/);
	});

	it('QA-09: XLSX extract creates one story per non-empty sheet', () => {
		if (!pgAvailable) return;

		const ingest = runCli(['ingest', xlsxFile]);
		expect(ingest.exitCode, `${ingest.stdout}\n${ingest.stderr}`).toBe(0);
		const sourceId = sourceIdForFilename(basename(xlsxFile));

		const extract = runCli(['extract', sourceId], { timeout: 180_000 });
		expect(extract.exitCode, `${extract.stdout}\n${extract.stderr}`).toBe(0);
		expect(db.runSql(`SELECT status FROM sources WHERE id = ${sqlLiteral(sourceId)};`)).toBe('extracted');
		expect(db.runSql(`SELECT COUNT(*) FROM stories WHERE source_id = ${sqlLiteral(sourceId)};`)).toBe('2');
		const sheets = db.runSql(
			`SELECT string_agg(metadata->>'sheet_name', ',' ORDER BY metadata->>'sheet_name') FROM stories WHERE source_id = ${sqlLiteral(sourceId)};`,
		);
		expect(sheets).toBe('Organizations,People');
		expect(sheets).not.toMatch(/Empty/);
	});

	it('QA-10: Large spreadsheet extract chunks by row groups', () => {
		if (!pgAvailable) return;

		const ingest = runCli(['ingest', largeCsvFile]);
		expect(ingest.exitCode, `${ingest.stdout}\n${ingest.stderr}`).toBe(0);
		const sourceId = sourceIdForFilename(basename(largeCsvFile));

		const extract = runCli(['extract', sourceId], { timeout: 180_000 });
		expect(extract.exitCode, `${extract.stdout}\n${extract.stderr}`).toBe(0);
		const storyCount = Number(db.runSql(`SELECT COUNT(*) FROM stories WHERE source_id = ${sqlLiteral(sourceId)};`));
		expect(storyCount).toBeGreaterThan(1);
		const rowRanges = db.runSql(
			`SELECT string_agg((metadata->>'row_start') || '-' || (metadata->>'row_end'), ',' ORDER BY (metadata->>'row_start')::int) FROM stories WHERE source_id = ${sqlLiteral(sourceId)};`,
		);
		expect(rowRanges).toBe('1-200,201-205');
		const oversizedStories = db.runSql(
			`SELECT COUNT(*) FROM stories WHERE source_id = ${sqlLiteral(sourceId)} AND ((metadata->>'row_end')::int - (metadata->>'row_start')::int + 1) > 200;`,
		);
		expect(oversizedStories).toBe('0');
	});

	it('QA-11: Row-level entity hints are exposed to enrich', () => {
		if (!pgAvailable) return;

		const ingest = runCli(['ingest', csvFile]);
		expect(ingest.exitCode, `${ingest.stdout}\n${ingest.stderr}`).toBe(0);
		const sourceId = sourceIdForFilename(basename(csvFile));

		const extract = runCli(['extract', sourceId], { timeout: 180_000 });
		expect(extract.exitCode, `${extract.stdout}\n${extract.stderr}`).toBe(0);
		const metadata = storyMetadataForSource(sourceId);
		const hints = metadata.entity_hints;
		expect(Array.isArray(hints)).toBe(true);
		expect(JSON.stringify(hints)).toMatch(/Ada Lovelace/);
		expect(JSON.stringify(hints)).toMatch(/ada@example\.com/);
		expect(JSON.stringify(hints)).toMatch(/https:\/\/example\.com\/case\/1/);
		expect(JSON.stringify(hints)).toMatch(/INV-1001/);
		const markdown = storyMarkdownForSource(sourceId);
		expect(markdown).toMatch(/## Row Entity Hints/);
		expect(markdown).toMatch(/Ada Lovelace/);
		expect(markdown).toMatch(/ada@example\.com/);
	});

	it('QA-12: Pipeline skips segment for spreadsheets after extract', () => {
		if (!pgAvailable) return;

		const ingest = runCli(['ingest', csvFile]);
		expect(ingest.exitCode, `${ingest.stdout}\n${ingest.stderr}`).toBe(0);
		const sourceId = sourceIdForFilename(basename(csvFile));

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

	it('QA-13: API upload accepts spreadsheet media types', async () => {
		if (!pgAvailable) return;

		for (const [filename, mediaType, content, extension] of [
			['table.csv', CSV_MEDIA_TYPE, readFileSync(csvFile), 'csv'],
			['book.xlsx', XLSX_MEDIA_TYPE, readFileSync(xlsxFile), 'xlsx'],
		] as const) {
			const initiate = await apiPost('/api/uploads/documents/initiate', {
				filename,
				size_bytes: content.byteLength,
				content_type: mediaType,
			});
			expect(initiate.status).toBe(201);
			const initiateBody = await readJson(initiate);
			const sourceId = String((initiateBody.data as Record<string, unknown>).source_id);
			const storagePath = String((initiateBody.data as Record<string, unknown>).storage_path);
			expect(storagePath).toBe(`raw/${sourceId}/original.${extension}`);
			writeUploadedObject(storagePath, content);

			const complete = await apiPost('/api/uploads/documents/complete', {
				source_id: sourceId,
				filename,
				storage_path: storagePath,
				start_pipeline: true,
			});
			expect(complete.status).toBe(202);

			const processed = await processOneJob();
			expect(processed.state).toBe('completed');
			const sourceRow = db
				.runSql(
					`SELECT source_type::text, storage_path, format_metadata->>'media_type', format_metadata->>'tabular_format' FROM sources WHERE id = ${sqlLiteral(sourceId)};`,
				)
				.split('|');
			expect(sourceRow[0]).toBe('spreadsheet');
			expect(sourceRow[1]).toMatch(new RegExp(`^blobs/sha256/[a-f0-9]{2}/[a-f0-9]{2}/[a-f0-9]{64}\\.${extension}$`));
			expect(sourceRow.slice(2)).toEqual([mediaType, extension]);
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
			cleanState();
			resetStorage();
		}
	});

	it('QA-14: Duplicate spreadsheet ingest returns the existing source', () => {
		if (!pgAvailable) return;

		const first = runCli(['ingest', csvFile]);
		expect(first.exitCode, `${first.stdout}\n${first.stderr}`).toBe(0);
		const second = runCli(['ingest', csvFile]);
		expect(second.exitCode, `${second.stdout}\n${second.stderr}`).toBe(0);
		expect(`${second.stdout}\n${second.stderr}`).toMatch(/duplicate/i);
		expect(db.runSql(`SELECT COUNT(*) FROM sources WHERE filename = ${sqlLiteral(basename(csvFile))};`)).toBe('1');
		expect(db.runSql(`SELECT source_type::text FROM sources WHERE filename = ${sqlLiteral(basename(csvFile))};`)).toBe(
			'spreadsheet',
		);
	});

	it('QA-15: Existing PDF, image, text, and DOCX behavior remains green', () => {
		if (!pgAvailable) return;

		const pdfResult = runCli(['ingest', '--dry-run', FIXTURE_PDF], { timeout: 180_000 });
		expect(pdfResult.exitCode, `${pdfResult.stdout}\n${pdfResult.stderr}`).toBe(0);
		expect(pdfResult.stdout).toMatch(/\bpdf\b/);

		const imageFile = join(tmpDir, `scan-${randomUUID()}.png`);
		writeFileSync(imageFile, PNG_BYTES);
		const imageResult = runCli(['ingest', '--dry-run', imageFile]);
		expect(imageResult.exitCode, `${imageResult.stdout}\n${imageResult.stderr}`).toBe(0);
		expect(imageResult.stdout).toMatch(/\bimage\b/);

		const textFile = join(tmpDir, `note-${randomUUID()}.txt`);
		writeFileSync(textFile, 'Plain text remains supported.\n', 'utf-8');
		const textResult = runCli(['ingest', '--dry-run', textFile]);
		expect(textResult.exitCode, `${textResult.stdout}\n${textResult.stderr}`).toBe(0);
		expect(textResult.stdout).toMatch(/\btext\b/);

		const docxResult = runCli(['ingest', '--dry-run', briefDocx]);
		expect(docxResult.exitCode, `${docxResult.stdout}\n${docxResult.stderr}`).toBe(0);
		expect(docxResult.stdout).toMatch(/\bdocx\b/);
	});
});

describe('Spec 90 — CLI Test Matrix', () => {
	it('CLI-MATRIX-01: ingest --dry-run accepts a valid CSV without persistence', () => {
		if (!pgAvailable) return;

		const result = runCli(['ingest', '--dry-run', csvFile]);
		expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
		expect(result.stdout).toMatch(/\bspreadsheet\b/);
		expect(result.stdout).toMatch(/\b0\b/);
		expect(db.runSql('SELECT COUNT(*) FROM sources;')).toBe('0');
	});

	it('CLI-MATRIX-02: ingest --dry-run accepts a valid XLSX without persistence', () => {
		if (!pgAvailable) return;

		const result = runCli(['ingest', '--dry-run', xlsxFile]);
		expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
		expect(result.stdout).toMatch(/\bspreadsheet\b/);
		expect(result.stdout).toMatch(/\b0\b/);
		expect(db.runSql('SELECT COUNT(*) FROM sources;')).toBe('0');
	});

	it('CLI-MATRIX-03: ingest persists a valid CSV with canonical raw storage', () => {
		if (!pgAvailable) return;

		const result = runCli(['ingest', csvFile]);
		expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
		const sourceId = sourceIdForFilename(basename(csvFile));
		const row = db
			.runSql(`SELECT source_type::text, storage_path FROM sources WHERE id = ${sqlLiteral(sourceId)};`)
			.split('|');
		expect(row[0]).toBe('spreadsheet');
		expect(row[1]).toMatch(/^blobs\/sha256\/[a-f0-9]{2}\/[a-f0-9]{2}\/[a-f0-9]{64}\.csv$/);
	});

	it('CLI-MATRIX-04: ingest persists a valid XLSX with canonical raw storage', () => {
		if (!pgAvailable) return;

		const result = runCli(['ingest', xlsxFile]);
		expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
		const sourceId = sourceIdForFilename(basename(xlsxFile));
		const row = db
			.runSql(`SELECT source_type::text, storage_path FROM sources WHERE id = ${sqlLiteral(sourceId)};`)
			.split('|');
		expect(row[0]).toBe('spreadsheet');
		expect(row[1]).toMatch(/^blobs\/sha256\/[a-f0-9]{2}\/[a-f0-9]{2}\/[a-f0-9]{64}\.xlsx$/);
	});

	it('CLI-MATRIX-05: ingest --dry-run rejects an arbitrary ZIP renamed to XLSX', () => {
		if (!pgAvailable) return;

		const result = runCli(['ingest', '--dry-run', fakeXlsxFile]);
		expect(result.exitCode).not.toBe(0);
		expect(`${result.stdout}\n${result.stderr}`).toMatch(/unsupported|invalid|spreadsheet|xlsx|workbook/i);
	});

	it('CLI-MATRIX-06: ingest --dry-run rejects an invalid CSV', () => {
		if (!pgAvailable) return;

		const result = runCli(['ingest', '--dry-run', invalidCsvFile]);
		expect(result.exitCode).not.toBe(0);
		expect(`${result.stdout}\n${result.stderr}`).toMatch(/unsupported|invalid|spreadsheet|csv|delimited/i);
	});

	it('CLI-MATRIX-07: ingest --dry-run discovers mixed PDF, image, text, DOCX, CSV, and XLSX inputs', () => {
		if (!pgAvailable) return;

		const mixedDir = join(tmpDir, `matrix-mixed-${randomUUID()}`);
		mkdirSync(mixedDir, { recursive: true });
		writeFileSync(join(mixedDir, 'sample.pdf'), readFileSync(FIXTURE_PDF));
		writeFileSync(join(mixedDir, 'scan.png'), PNG_BYTES);
		writeFileSync(join(mixedDir, 'note.txt'), 'Plain text note.\n', 'utf-8');
		writeFileSync(join(mixedDir, 'brief.docx'), readFileSync(briefDocx));
		writeFileSync(join(mixedDir, 'table.csv'), readFileSync(csvFile));
		writeFileSync(join(mixedDir, 'book.xlsx'), readFileSync(xlsxFile));

		const result = runCli(['ingest', '--dry-run', mixedDir], { timeout: 180_000 });
		expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
		expect(result.stdout).toMatch(/sample\.pdf[\s\S]*\bpdf\b/);
		expect(result.stdout).toMatch(/scan\.png[\s\S]*\bimage\b/);
		expect(result.stdout).toMatch(/note\.txt[\s\S]*\btext\b/);
		expect(result.stdout).toMatch(/brief\.docx[\s\S]*\bdocx\b/);
		expect(result.stdout).toMatch(/table\.csv[\s\S]*\bspreadsheet\b/);
		expect(result.stdout).toMatch(/book\.xlsx[\s\S]*\bspreadsheet\b/);
	});

	it('CLI-MATRIX-08: extract creates spreadsheet Markdown stories without layout JSON', () => {
		if (!pgAvailable) return;

		const ingest = runCli(['ingest', csvFile]);
		expect(ingest.exitCode, `${ingest.stdout}\n${ingest.stderr}`).toBe(0);
		const sourceId = sourceIdForFilename(basename(csvFile));
		const extract = runCli(['extract', sourceId], { timeout: 180_000 });
		expect(extract.exitCode, `${extract.stdout}\n${extract.stderr}`).toBe(0);
		expect(db.runSql(`SELECT COUNT(*) FROM stories WHERE source_id = ${sqlLiteral(sourceId)};`)).toBe('1');
		expect(storyMarkdownForSource(sourceId)).toMatch(/\| name \| date \| city \| email \| url \| invoice_id \|/i);
		expect(existsSync(resolve(STORAGE_DIR, `extracted/${sourceId}/layout.json`))).toBe(false);
	});

	it('CLI-MATRIX-09: pipeline run skips segment and enriches spreadsheet stories', () => {
		if (!pgAvailable) return;

		const ingest = runCli(['ingest', csvFile]);
		expect(ingest.exitCode, `${ingest.stdout}\n${ingest.stderr}`).toBe(0);
		const sourceId = sourceIdForFilename(basename(csvFile));
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

describe('Spec 90 — CLI Smoke Coverage', () => {
	it('CLI-SMOKE-01: ingest help exposes mechanical dry-run coverage', () => {
		const result = runCli(['ingest', '--help']);
		expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
		expect(`${result.stdout}\n${result.stderr}`).toMatch(/dry-run/);
	});

	it('CLI-SMOKE-02: ingest without an input fails before any source is created', () => {
		if (!pgAvailable) return;

		const result = runCli(['ingest']);
		expect(result.exitCode).not.toBe(0);
		expect(`${result.stdout}\n${result.stderr}`).toMatch(/argument|input|missing|required/i);
		expect(db.runSql('SELECT COUNT(*) FROM sources;')).toBe('0');
	});

	it('CLI-SMOKE-03: ingest --json dry-run accepts CSV when the flag is available', () => {
		if (!pgAvailable) return;

		const help = runCli(['ingest', '--help']);
		if (!`${help.stdout}\n${help.stderr}`.includes('--json')) {
			return;
		}
		const result = runCli(['ingest', '--dry-run', '--json', csvFile]);
		expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
		expect(result.stdout).toMatch(/spreadsheet/);
		expect(db.runSql('SELECT COUNT(*) FROM sources;')).toBe('0');
	});

	it('CLI-SMOKE-04: ingest --cost-estimate dry-run remains cost-free for spreadsheets when available', () => {
		if (!pgAvailable) return;

		const help = runCli(['ingest', '--help']);
		if (!`${help.stdout}\n${help.stderr}`.includes('--cost-estimate')) {
			return;
		}
		const result = runCli(['ingest', '--dry-run', '--cost-estimate', csvFile]);
		expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
		expect(`${result.stdout}\n${result.stderr}`).toMatch(/\$0\.00|0 scanned|0 pages|zero/i);
	});
});
