import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as db from '../lib/db.js';
import { cleanStorageDirSince, type StorageSnapshot, snapshotStorageDir, testStoragePath } from '../lib/storage.js';

const ROOT = resolve(import.meta.dirname, '../..');
const CLI = resolve(ROOT, 'apps/cli/dist/index.js');
const EXAMPLE_CONFIG = resolve(ROOT, 'mulder.config.example.yaml');
const DB_MODULE = resolve(ROOT, 'packages/core/dist/database/index.js');
const FIXTURE_DIR = resolve(ROOT, 'fixtures/raw');
const NATIVE_TEXT_PDF = resolve(FIXTURE_DIR, 'native-text-sample.pdf');
const STORAGE_RAW_DIR = testStoragePath('raw');

const SOURCE_TYPES = ['pdf', 'image', 'text', 'docx', 'spreadsheet', 'email', 'url'] as const;
const DB_CONFIG_JSON = JSON.stringify({
	instance_name: 'mulder-db',
	database: 'mulder',
	tier: 'db-custom-2-8192',
	host: 'localhost',
	port: 5432,
	user: 'mulder',
});

let tmpDir: string;
let storageRawSnapshot: StorageSnapshot;

function runCli(args: string[], opts?: { timeout?: number }): { stdout: string; stderr: string; exitCode: number } {
	const result = spawnSync('node', [CLI, ...args], {
		cwd: ROOT,
		encoding: 'utf-8',
		timeout: opts?.timeout ?? 60_000,
		stdio: ['pipe', 'pipe', 'pipe'],
		env: { ...process.env, PGPASSWORD: db.TEST_PG_PASSWORD },
	});
	return {
		stdout: result.stdout ?? '',
		stderr: result.stderr ?? '',
		exitCode: result.status ?? 1,
	};
}

function runScript(scriptContent: string): { stdout: string; stderr: string; exitCode: number } {
	const scriptPath = join(tmpDir, `helper-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);
	writeFileSync(scriptPath, scriptContent, 'utf-8');

	const result = spawnSync('node', [scriptPath], {
		cwd: ROOT,
		encoding: 'utf-8',
		timeout: 60_000,
		stdio: ['pipe', 'pipe', 'pipe'],
		env: { ...process.env, PGPASSWORD: db.TEST_PG_PASSWORD },
	});
	return {
		stdout: result.stdout ?? '',
		stderr: result.stderr ?? '',
		exitCode: result.status ?? 1,
	};
}

function cleanSourceData(): void {
	db.runSql('DELETE FROM source_steps; DELETE FROM sources;');
}

function currentStorageEntries(): Set<string> {
	if (!existsSync(STORAGE_RAW_DIR)) {
		return new Set();
	}
	return new Set(readdirSync(STORAGE_RAW_DIR));
}

function expectNoStorageUpload(before: Set<string>): void {
	const after = currentStorageEntries();
	const added = [...after].filter((entry) => !before.has(entry));
	expect(added).toEqual([]);
}

describe('Spec 85 — Source Type Discriminator + Format Metadata', () => {
	let pgAvailable: boolean;

	beforeAll(() => {
		pgAvailable = db.isPgAvailable();
		if (!pgAvailable) {
			console.warn('SKIP: PostgreSQL not reachable at PGHOST/PGPORT.');
			return;
		}

		tmpDir = mkdtempSync(join(tmpdir(), 'mulder-qa-85-'));
		mkdirSync(tmpDir, { recursive: true });
		storageRawSnapshot = snapshotStorageDir(STORAGE_RAW_DIR);

		const { exitCode, stdout, stderr } = runCli(['db', 'migrate', EXAMPLE_CONFIG]);
		if (exitCode !== 0) {
			throw new Error(`Migration failed: ${stdout} ${stderr}`);
		}
	});

	afterAll(() => {
		if (tmpDir) {
			rmSync(tmpDir, { recursive: true, force: true });
		}
		if (pgAvailable) {
			try {
				cleanSourceData();
			} catch {
				// Ignore cleanup errors.
			}
		}
		if (storageRawSnapshot) {
			cleanStorageDirSince(storageRawSnapshot);
		}
	});

	it('QA-01: migration exposes constrained source type and format metadata', () => {
		if (!pgAvailable) return;

		cleanSourceData();

		const columns = db.runSql(
			"SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = 'sources' AND column_name IN ('source_type', 'format_metadata') ORDER BY column_name;",
		);
		expect(columns).toContain('format_metadata|NO');
		expect(columns).toContain('source_type|NO');

		for (const sourceType of SOURCE_TYPES) {
			db.runSql(
				`INSERT INTO sources (filename, storage_path, file_hash, source_type) VALUES ('qa85-${sourceType}', 'raw/qa85-${sourceType}', 'qa85-hash-${sourceType}', '${sourceType}');`,
			);
		}

		const count = db.runSql("SELECT COUNT(*) FROM sources WHERE file_hash LIKE 'qa85-hash-%';");
		expect(count).toBe(String(SOURCE_TYPES.length));

		const invalidInsert = db.runSqlSafe(
			"INSERT INTO sources (filename, storage_path, file_hash, source_type) VALUES ('qa85-invalid', 'raw/qa85-invalid', 'qa85-hash-invalid', 'video');",
		);
		expect(invalidInsert).toBeNull();
	});

	it('QA-02: inserted rows default to pdf with empty format metadata', () => {
		if (!pgAvailable) return;

		cleanSourceData();

		db.runSql(
			"INSERT INTO sources (filename, storage_path, file_hash) VALUES ('qa85-default.pdf', 'raw/qa85-default.pdf', 'qa85-default-hash');",
		);

		const row = db.runSql(
			"SELECT source_type::text, format_metadata::text FROM sources WHERE file_hash = 'qa85-default-hash';",
		);
		expect(row).toBe('pdf|{}');
	});

	it('QA-03: PDF ingest prints and persists source type plus format metadata', () => {
		if (!pgAvailable) return;

		cleanSourceData();

		const result = runCli(['ingest', NATIVE_TEXT_PDF], { timeout: 120_000 });
		expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
		expect(result.stdout).toContain('Type');
		expect(result.stdout).toMatch(/\bpdf\b/);

		const row = db.runSql(
			"SELECT source_type::text AS source_type, format_metadata <> '{}'::jsonb AS has_format_metadata, metadata <> '{}'::jsonb AS has_metadata, has_native_text, native_text_ratio > 0 AS has_native_ratio FROM sources WHERE filename = 'native-text-sample.pdf';",
		);
		expect(row).toBe('pdf|t|t|t|t');
	});

	it('QA-04: image magic bytes override a misleading pdf extension', () => {
		if (!pgAvailable) return;

		cleanSourceData();
		const beforeStorage = currentStorageEntries();
		const imageRenamedPdf = join(tmpDir, 'image-renamed.pdf');
		writeFileSync(imageRenamedPdf, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]));

		const result = runCli(['ingest', '--dry-run', imageRenamedPdf]);
		expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
		expect(`${result.stdout}\n${result.stderr}`).toMatch(/\bimage\b/i);
		expect(db.runSql('SELECT COUNT(*) FROM sources;')).toBe('0');
		expectNoStorageUpload(beforeStorage);
	});

	it('QA-05: supported text files ingest as text while unsupported readable extensions stay rejected', () => {
		if (!pgAvailable) return;

		cleanSourceData();
		const note = join(tmpDir, 'note.txt');
		writeFileSync(note, 'A plain text note for the M9 text path.\n', 'utf-8');

		const result = runCli(['ingest', note]);
		expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
		expect(result.stdout).toMatch(/\btext\b/i);
		expect(db.runSql("SELECT source_type::text FROM sources WHERE filename = 'note.txt';")).toBe('text');

		const logFile = join(tmpDir, 'note.log');
		writeFileSync(logFile, 'A readable log file is not a supported text ingest extension.\n', 'utf-8');
		const beforeStorage = currentStorageEntries();

		const logResult = runCli(['ingest', logFile]);
		expect(logResult.exitCode).not.toBe(0);
		expect(`${logResult.stdout}\n${logResult.stderr}`).toMatch(
			/INGEST_UNSUPPORTED_SOURCE_TYPE|unsupported source type/i,
		);
		expect(`${logResult.stdout}\n${logResult.stderr}`).toMatch(/\btext\b/i);
		expect(db.runSql('SELECT COUNT(*) FROM sources;')).toBe('1');
		expectNoStorageUpload(beforeStorage);
	});

	it('QA-06: public source repository API round trips source type and format metadata', () => {
		if (!pgAvailable) return;

		cleanSourceData();

		const { stdout, stderr, exitCode } = runScript(`
			import { closeAllPools, createSource, findSourceByHash, getWorkerPool } from '${DB_MODULE}';

			const pool = getWorkerPool(${DB_CONFIG_JSON});
			try {
				const created = await createSource(pool, {
					filename: 'qa85-repo.pdf',
					storagePath: 'raw/qa85-repo.pdf',
					fileHash: 'qa85-repo-hash',
					sourceType: 'pdf',
					formatMetadata: { pdf_version: '1.7', encrypted: false },
					metadata: { pdf_version: '1.7', encrypted: false },
					pageCount: 3,
					hasNativeText: true,
					nativeTextRatio: 1,
				});
				const found = await findSourceByHash(pool, created.fileHash);
				process.stdout.write(JSON.stringify({
					sourceType: found.sourceType,
					formatMetadata: found.formatMetadata,
					pageCount: found.pageCount,
					hasNativeText: found.hasNativeText,
					nativeTextRatio: found.nativeTextRatio,
				}));
			} finally {
				await closeAllPools();
			}
		`);

		expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
		const parsed = JSON.parse(stdout) as {
			sourceType: string;
			formatMetadata: Record<string, unknown>;
			pageCount: number;
			hasNativeText: boolean;
			nativeTextRatio: number;
		};
		expect(parsed.sourceType).toBe('pdf');
		expect(parsed.formatMetadata).toEqual({ pdf_version: '1.7', encrypted: false });
		expect(parsed.pageCount).toBe(3);
		expect(parsed.hasNativeText).toBe(true);
		expect(parsed.nativeTextRatio).toBe(1);
	});

	it('QA-07: duplicate PDF output preserves type and stores a single source row', () => {
		if (!pgAvailable) return;

		cleanSourceData();

		const first = runCli(['ingest', NATIVE_TEXT_PDF], { timeout: 120_000 });
		expect(first.exitCode, `${first.stdout}\n${first.stderr}`).toBe(0);

		const second = runCli(['ingest', NATIVE_TEXT_PDF], { timeout: 120_000 });
		expect(second.exitCode, `${second.stdout}\n${second.stderr}`).toBe(0);
		expect(second.stdout).toMatch(/\bpdf\b/);
		expect(`${second.stdout}\n${second.stderr}`).toMatch(/duplicate/i);

		const row = db.runSql(
			"SELECT source_type::text, COUNT(*) FROM sources WHERE file_hash = (SELECT file_hash FROM sources WHERE filename = 'native-text-sample.pdf' LIMIT 1) GROUP BY source_type;",
		);
		expect(row).toBe('pdf|1');
	});

	it('QA-08: dry-run PDF validation prints type without creating rows or uploads', () => {
		if (!pgAvailable) return;

		cleanSourceData();
		const beforeStorage = currentStorageEntries();

		const result = runCli(['ingest', '--dry-run', NATIVE_TEXT_PDF], { timeout: 120_000 });
		expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
		expect(result.stdout).toContain('Type');
		expect(result.stdout).toMatch(/\bpdf\b/);
		expect(db.runSql('SELECT COUNT(*) FROM sources;')).toBe('0');
		expectNoStorageUpload(beforeStorage);
	});
});
