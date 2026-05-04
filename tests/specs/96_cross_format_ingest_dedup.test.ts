import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
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

const PNG_BYTES = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
	'base64',
);

let tmpDir = '';
let pgAvailable = false;
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

function writeFixture(relativePath: string, content: Buffer | string): string {
	const filePath = join(tmpDir, relativePath);
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, content);
	return filePath;
}

function sqlLiteral(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

function sourceIdForFilename(filename: string): string {
	return db.runSql(`SELECT id FROM sources WHERE filename = ${sqlLiteral(filename)} ORDER BY created_at DESC LIMIT 1;`);
}

function sourceCount(): string {
	return db.runSql('SELECT COUNT(*) FROM sources;');
}

function combinedOutput(result: { stdout: string; stderr: string }): string {
	return `${result.stdout}\n${result.stderr}`;
}

function expectSuccessfulIngest(result: { stdout: string; stderr: string; exitCode: number }): void {
	expect(result.exitCode, combinedOutput(result)).toBe(0);
}

beforeAll(() => {
	process.env.MULDER_CONFIG = EXAMPLE_CONFIG;
	process.env.MULDER_LOG_LEVEL = 'silent';
	process.env.NODE_ENV = 'test';

	tmpDir = mkdtempSync(join(tmpdir(), 'mulder-qa-96-'));
	rawSnapshot = snapshotStorageDir(RAW_STORAGE_DIR);
	extractedSnapshot = snapshotStorageDir(EXTRACTED_STORAGE_DIR);
	segmentsSnapshot = snapshotStorageDir(SEGMENTS_STORAGE_DIR);

	buildPackage(CORE_DIR);
	buildPackage(PIPELINE_DIR);
	buildPackage(CLI_DIR);

	pgAvailable = db.isPgAvailable();
	if (!pgAvailable) {
		console.warn('SKIP: PostgreSQL not reachable at PGHOST/PGPORT.');
		return;
	}

	const migrate = runCli(['db', 'migrate', EXAMPLE_CONFIG], { timeout: 300_000 });
	expect(migrate.exitCode, combinedOutput(migrate)).toBe(0);
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

describe('Spec 96 - Cross-format ingest dedup', () => {
	it('QA-01: existing exact file-hash dedup still wins', () => {
		if (!pgAvailable) return;
		const sameFile = writeFixture('qa-01/same.txt', 'Exact duplicate report body.\nSecond line.\n');

		const first = runCli(['ingest', sameFile]);
		expectSuccessfulIngest(first);
		const existingSourceId = sourceIdForFilename(basename(sameFile));

		const second = runCli(['ingest', sameFile]);
		expectSuccessfulIngest(second);
		expect(combinedOutput(second)).toMatch(/duplicate/i);
		expect(combinedOutput(second)).toContain(existingSourceId);

		const rawHashRowCount = db.runSql(
			`SELECT COUNT(*) FROM sources WHERE file_hash = (SELECT file_hash FROM sources WHERE id = ${sqlLiteral(existingSourceId)});`,
		);
		expect(rawHashRowCount).toBe('1');
		expect(sourceCount()).toBe('1');
	});

	it('QA-02: cross-format text duplicate is detected before second source creation', () => {
		if (!pgAvailable) return;
		const reportText = 'Spec 96 Field Report\n\nAlpha beta gamma.\n';
		const reportTxt = writeFixture('qa-02/report.txt', reportText);
		const reportMd = writeFixture('qa-02/report.md', reportText.replaceAll('\n', '\r\n'));

		const first = runCli(['ingest', reportTxt]);
		expectSuccessfulIngest(first);
		const existingSourceId = sourceIdForFilename('report.txt');

		const second = runCli(['ingest', reportMd]);
		expectSuccessfulIngest(second);
		expect(combinedOutput(second)).toMatch(/duplicate/i);
		expect(combinedOutput(second)).toContain(existingSourceId);

		expect(sourceCount()).toBe('1');
		expect(sourceIdForFilename('report.txt')).toBe(existingSourceId);
	});

	it('QA-03: dedup metadata is durable and deterministic', () => {
		if (!pgAvailable) return;
		const titledMarkdown = writeFixture('qa-03/titled.md', '# Durable Report Title\n\nAlpha beta gamma.\n');

		const first = runCli(['ingest', titledMarkdown]);
		expectSuccessfulIngest(first);
		const sourceId = sourceIdForFilename('titled.md');

		const metadata = JSON.parse(
			db.runSql(`SELECT format_metadata::text FROM sources WHERE id = ${sqlLiteral(sourceId)};`),
		) as Record<string, unknown>;
		expect(metadata.cross_format_dedup_key).toMatch(/^sha256:[a-f0-9]{64}$/);
		expect(metadata.cross_format_dedup_basis).toBe('text_content');
		expect(metadata.cross_format_title_key).toMatch(/^sha256:[a-f0-9]{64}$/);

		cleanState();
		resetStorage();

		const second = runCli(['ingest', titledMarkdown]);
		expectSuccessfulIngest(second);
		const secondSourceId = sourceIdForFilename('titled.md');
		const secondMetadata = JSON.parse(
			db.runSql(`SELECT format_metadata::text FROM sources WHERE id = ${sqlLiteral(secondSourceId)};`),
		) as Record<string, unknown>;
		expect(secondMetadata.cross_format_dedup_key).toBe(metadata.cross_format_dedup_key);
		expect(secondMetadata.cross_format_dedup_basis).toBe(metadata.cross_format_dedup_basis);
		expect(secondMetadata.cross_format_title_key).toBe(metadata.cross_format_title_key);
	});

	it('QA-04: title-only matches do not collapse unrelated sources', () => {
		if (!pgAvailable) return;
		const firstFile = writeFixture('qa-04/a/same-title.txt', 'Shared Incident Title\n\nFirst unrelated body.\n');
		const secondFile = writeFixture('qa-04/b/same-title.txt', 'Shared Incident Title\n\nSecond unrelated body.\n');

		const first = runCli(['ingest', firstFile]);
		expectSuccessfulIngest(first);
		const second = runCli(['ingest', secondFile]);
		expectSuccessfulIngest(second);
		expect(combinedOutput(second)).toMatch(/\bingested\b/i);
		expect(combinedOutput(second)).toMatch(/\b0 duplicates\b/i);

		expect(sourceCount()).toBe('2');
		const rows = db.runSql(
			"SELECT COUNT(DISTINCT file_hash), COUNT(DISTINCT format_metadata->>'cross_format_dedup_key') FROM sources WHERE filename = 'same-title.txt';",
		);
		expect(rows).toBe('2|2');
	});

	it('QA-05: weak or unavailable signals preserve normal ingest', () => {
		if (!pgAvailable) return;
		const imageFile = writeFixture('qa-05/pixel.png', PNG_BYTES);

		const result = runCli(['ingest', imageFile]);
		expectSuccessfulIngest(result);
		expect(combinedOutput(result)).toMatch(/\bingested\b/i);
		expect(combinedOutput(result)).toMatch(/\b0 duplicates\b/i);
		expect(sourceCount()).toBe('1');

		const metadataFlags = db.runSql(
			"SELECT source_type::text, format_metadata ? 'cross_format_dedup_key' FROM sources WHERE filename = 'pixel.png';",
		);
		expect(metadataFlags).toBe('image|f');
		expect(existsSync(resolve(STORAGE_DIR, `raw/${sourceIdForFilename('pixel.png')}/original.png`))).toBe(true);
	});

	it('QA-06: graph-level dedup remains unchanged', () => {
		const result = spawnSync('npx', ['vitest', 'run', 'tests/specs/35_graph_step.test.ts', '--reporter=verbose'], {
			cwd: ROOT,
			encoding: 'utf-8',
			timeout: 600_000,
			stdio: ['pipe', 'pipe', 'pipe'],
			env: { ...process.env, MULDER_LOG_LEVEL: 'silent', NODE_ENV: 'test', PGPASSWORD: db.TEST_PG_PASSWORD },
		});
		expect(result.status ?? 1, `${result.stdout ?? ''}\n${result.stderr ?? ''}`).toBe(0);
	}, 700_000);

	it('QA-07: M9 ingest/extract regressions remain green', () => {
		const result = spawnSync(
			'npx',
			[
				'vitest',
				'run',
				'tests/specs/85_source_type_discriminator_format_metadata.test.ts',
				'tests/specs/88_plain_text_ingestion_prestructured_path.test.ts',
				'tests/specs/89_docx_ingestion_prestructured_path.test.ts',
				'tests/specs/90_spreadsheet_ingestion_prestructured_path.test.ts',
				'tests/specs/91_email_ingestion_prestructured_path.test.ts',
				'tests/specs/92_url_ingestion_prestructured_path.test.ts',
				'tests/specs/95_format_aware_extract_routing.test.ts',
				'--reporter=verbose',
			],
			{
				cwd: ROOT,
				encoding: 'utf-8',
				timeout: 1_200_000,
				stdio: ['pipe', 'pipe', 'pipe'],
				env: { ...process.env, MULDER_LOG_LEVEL: 'silent', NODE_ENV: 'test', PGPASSWORD: db.TEST_PG_PASSWORD },
			},
		);
		expect(result.status ?? 1, `${result.stdout ?? ''}\n${result.stderr ?? ''}`).toBe(0);
	}, 1_300_000);
});

describe('Spec 96 CLI matrix - mulder ingest duplicate behavior', () => {
	it('CLI-01: mulder ingest same.txt twice reports exact hash duplicate with one source row', () => {
		if (!pgAvailable) return;
		const sameFile = writeFixture('cli-01/same.txt', 'CLI exact duplicate body.\n');

		const first = runCli(['ingest', sameFile]);
		expectSuccessfulIngest(first);
		const existingSourceId = sourceIdForFilename('same.txt');
		const second = runCli(['ingest', sameFile]);
		expectSuccessfulIngest(second);

		expect(combinedOutput(second)).toMatch(/duplicate/i);
		expect(combinedOutput(second)).toContain(existingSourceId);
		expect(sourceCount()).toBe('1');
	});

	it('CLI-02: mulder ingest report.txt then report.md reports cross-format duplicate with one source row', () => {
		if (!pgAvailable) return;
		const body = 'CLI Cross Format Report\n\nThe normalized body is the same.\n';
		const txtFile = writeFixture('cli-02/report.txt', body);
		const mdFile = writeFixture('cli-02/report.md', body.replaceAll('\n', '\r\n'));

		const first = runCli(['ingest', txtFile]);
		expectSuccessfulIngest(first);
		const existingSourceId = sourceIdForFilename('report.txt');
		const second = runCli(['ingest', mdFile]);
		expectSuccessfulIngest(second);

		expect(combinedOutput(second)).toMatch(/duplicate/i);
		expect(combinedOutput(second)).toContain(existingSourceId);
		expect(sourceCount()).toBe('1');
	});

	it('CLI-03: mulder ingest same-title files with different bodies creates both source rows', () => {
		if (!pgAvailable) return;
		const firstFile = writeFixture('cli-03/a/same-title-a.txt', 'CLI Shared Title\n\nFirst body.\n');
		const secondFile = writeFixture('cli-03/b/same-title-b.txt', 'CLI Shared Title\n\nSecond body.\n');

		const first = runCli(['ingest', firstFile]);
		expectSuccessfulIngest(first);
		const second = runCli(['ingest', secondFile]);
		expectSuccessfulIngest(second);

		expect(combinedOutput(second)).toMatch(/\bingested\b/i);
		expect(combinedOutput(second)).toMatch(/\b0 duplicates\b/i);
		expect(sourceCount()).toBe('2');
	});
});
