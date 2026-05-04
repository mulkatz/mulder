import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as db from '../lib/db.js';
import { cleanStorageDirSince, type StorageSnapshot, snapshotStorageDir } from '../lib/storage.js';

const ROOT = resolve(import.meta.dirname, '../..');
const CORE_DIR = resolve(ROOT, 'packages/core');
const PIPELINE_DIR = resolve(ROOT, 'packages/pipeline');
const CLI_DIR = resolve(ROOT, 'apps/cli');
const PIPELINE_DIST = resolve(PIPELINE_DIR, 'dist/index.js');
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

type ResolveExtractRoute = (sourceType: string) => {
	sourceType: string;
	kind: 'layout' | 'prestructured';
	fallbackOnlySupported: boolean;
};

interface PipelinePublicApi {
	resolveExtractRoute: ResolveExtractRoute;
	EXTRACT_SOURCE_TYPES: readonly string[];
}

let tmpDir = '';
let imageFile = '';
let pipelineModule: PipelinePublicApi;
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

function sqlLiteral(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

function writeStoredObject(storagePath: string, content: Buffer | string): void {
	const fullPath = resolve(STORAGE_DIR, storagePath);
	mkdirSync(dirname(fullPath), { recursive: true });
	writeFileSync(fullPath, content);
}

function sourceIdForFilename(filename: string): string {
	return db.runSql(`SELECT id FROM sources WHERE filename = ${sqlLiteral(filename)} ORDER BY created_at DESC LIMIT 1;`);
}

function seedTextSource(filename = 'misleading.pdf'): string {
	const sourceId = randomUUID();
	const storagePath = `raw/${sourceId}/original.txt`;
	const body = '# Routed Text Source\n\nThis source_type=text row must not enter the PDF layout path.\n';
	writeStoredObject(storagePath, body);
	const formatMetadata = {
		media_type: 'text/plain',
		encoding: 'utf-8',
		line_count: 3,
	};
	db.runSql(
		`INSERT INTO sources (id, filename, storage_path, file_hash, page_count, has_native_text, native_text_ratio, status, reliability_score, tags, metadata, source_type, format_metadata)
		 VALUES (${sqlLiteral(sourceId)}, ${sqlLiteral(filename)}, ${sqlLiteral(storagePath)}, ${sqlLiteral(`spec-95-${sourceId}`)}, 0, false, 0, 'ingested', NULL, ARRAY[]::text[], '{}'::jsonb, 'text', ${sqlLiteral(JSON.stringify(formatMetadata))}::jsonb);`,
	);
	return sourceId;
}

function sourceStepStatus(sourceId: string, stepName: string): string {
	return db.runSql(
		`SELECT COALESCE((SELECT status::text FROM source_steps WHERE source_id = ${sqlLiteral(sourceId)} AND step_name = ${sqlLiteral(stepName)}), 'missing');`,
	);
}

beforeAll(async () => {
	process.env.MULDER_CONFIG = EXAMPLE_CONFIG;
	process.env.MULDER_LOG_LEVEL = 'silent';
	process.env.NODE_ENV = 'test';

	tmpDir = mkdtempSync(join(tmpdir(), 'mulder-qa-95-'));
	imageFile = join(tmpDir, 'scan.png');
	writeFileSync(imageFile, PNG_BYTES);

	rawSnapshot = snapshotStorageDir(RAW_STORAGE_DIR);
	extractedSnapshot = snapshotStorageDir(EXTRACTED_STORAGE_DIR);
	segmentsSnapshot = snapshotStorageDir(SEGMENTS_STORAGE_DIR);

	buildPackage(CORE_DIR);
	buildPackage(PIPELINE_DIR);
	buildPackage(CLI_DIR);
	pipelineModule = (await import(pathToFileURL(PIPELINE_DIST).href)) as PipelinePublicApi;

	pgAvailable = db.isPgAvailable();
	if (pgAvailable) {
		const migrate = runCli(['db', 'migrate', EXAMPLE_CONFIG], { timeout: 300_000 });
		expect(migrate.exitCode, `${migrate.stdout}\n${migrate.stderr}`).toBe(0);
	}
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

describe('Spec 95 - Format-aware extract routing', () => {
	it('QA-01: public routing helper reports every M9 source type', () => {
		expect([...pipelineModule.EXTRACT_SOURCE_TYPES].sort()).toEqual(
			['docx', 'email', 'image', 'pdf', 'spreadsheet', 'text', 'url'].sort(),
		);

		for (const sourceType of ['pdf', 'image']) {
			expect(pipelineModule.resolveExtractRoute(sourceType)).toMatchObject({
				sourceType,
				kind: 'layout',
				fallbackOnlySupported: true,
			});
		}

		for (const sourceType of ['text', 'docx', 'spreadsheet', 'email', 'url']) {
			expect(pipelineModule.resolveExtractRoute(sourceType)).toMatchObject({
				sourceType,
				kind: 'prestructured',
				fallbackOnlySupported: false,
			});
		}
	});

	it('QA-02: fallback-only is rejected for pre-structured sources without artifacts', () => {
		if (!pgAvailable) return;
		const sourceId = seedTextSource();

		const result = runCli(['extract', sourceId, '--fallback-only']);
		expect(result.exitCode, `${result.stdout}\n${result.stderr}`).not.toBe(0);
		expect(`${result.stdout}\n${result.stderr}`).toMatch(/does not support vision fallback/i);

		expect(db.runSql(`SELECT COUNT(*) FROM stories WHERE source_id = ${sqlLiteral(sourceId)};`)).toBe('0');
		expect(sourceStepStatus(sourceId, 'extract')).toBe('missing');
		expect(existsSync(resolve(STORAGE_DIR, `extracted/${sourceId}/layout.json`))).toBe(false);
	});

	it('QA-02 regression: pre-structured --force --fallback-only fails before cleanup', () => {
		if (!pgAvailable) return;
		const sourceId = seedTextSource('force-fallback-note.txt');
		const extract = runCli(['extract', sourceId]);
		expect(extract.exitCode, `${extract.stdout}\n${extract.stderr}`).toBe(0);

		const storyRow = db.runSql(
			`SELECT id, gcs_markdown_uri, gcs_metadata_uri FROM stories WHERE source_id = ${sqlLiteral(sourceId)} LIMIT 1;`,
		);
		const [storyId, markdownUri, metadataUri] = storyRow.split('|');
		const markdownBefore = readFileSync(resolve(STORAGE_DIR, markdownUri), 'utf-8');

		const result = runCli(['extract', sourceId, '--force', '--fallback-only']);
		expect(result.exitCode, `${result.stdout}\n${result.stderr}`).not.toBe(0);
		expect(`${result.stdout}\n${result.stderr}`).toMatch(/does not support vision fallback/i);

		expect(db.runSql(`SELECT status FROM sources WHERE id = ${sqlLiteral(sourceId)};`)).toBe('extracted');
		expect(sourceStepStatus(sourceId, 'extract')).toBe('completed');
		expect(db.runSql(`SELECT COUNT(*) FROM stories WHERE source_id = ${sqlLiteral(sourceId)};`)).toBe('1');
		expect(
			db.runSql(`SELECT id FROM stories WHERE source_id = ${sqlLiteral(sourceId)} ORDER BY created_at DESC LIMIT 1;`),
		).toBe(storyId);
		expect(existsSync(resolve(STORAGE_DIR, markdownUri))).toBe(true);
		expect(existsSync(resolve(STORAGE_DIR, metadataUri))).toBe(true);
		expect(readFileSync(resolve(STORAGE_DIR, markdownUri), 'utf-8')).toBe(markdownBefore);
		expect(existsSync(resolve(STORAGE_DIR, `extracted/${sourceId}/layout.json`))).toBe(false);
	});

	it('QA-03: source_type controls text extraction even when the filename is misleading', () => {
		if (!pgAvailable) return;
		const sourceId = seedTextSource('misleading.pdf');

		const result = runCli(['extract', sourceId]);
		expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);

		expect(db.runSql(`SELECT status FROM sources WHERE id = ${sqlLiteral(sourceId)};`)).toBe('extracted');
		expect(sourceStepStatus(sourceId, 'extract')).toBe('completed');
		expect(db.runSql(`SELECT COUNT(*) FROM stories WHERE source_id = ${sqlLiteral(sourceId)};`)).toBe('1');
		expect(existsSync(resolve(STORAGE_DIR, `extracted/${sourceId}/layout.json`))).toBe(false);
		expect(existsSync(resolve(STORAGE_DIR, `extracted/${sourceId}/pages/page-001.png`))).toBe(false);

		const storyRow = db.runSql(
			`SELECT id, gcs_markdown_uri, gcs_metadata_uri FROM stories WHERE source_id = ${sqlLiteral(sourceId)} LIMIT 1;`,
		);
		const [storyId, markdownUri, metadataUri] = storyRow.split('|');
		expect(markdownUri).toBe(`segments/${sourceId}/${storyId}.md`);
		expect(metadataUri).toBe(`segments/${sourceId}/${storyId}.meta.json`);
		expect(readFileSync(resolve(STORAGE_DIR, markdownUri), 'utf-8')).toContain('Routed Text Source');
		expect(JSON.parse(readFileSync(resolve(STORAGE_DIR, metadataUri), 'utf-8'))).toMatchObject({
			document_id: sourceId,
			source_type: 'text',
		});
	});

	it('QA-04: layout sources stay on the layout path', () => {
		if (!pgAvailable) return;
		const ingest = runCli(['ingest', imageFile]);
		expect(ingest.exitCode, `${ingest.stdout}\n${ingest.stderr}`).toBe(0);
		const sourceId = sourceIdForFilename(basename(imageFile));

		const extract = runCli(['extract', sourceId], { timeout: 180_000 });
		expect(extract.exitCode, `${extract.stdout}\n${extract.stderr}`).toBe(0);

		expect(db.runSql(`SELECT source_type::text, status FROM sources WHERE id = ${sqlLiteral(sourceId)};`)).toBe(
			'image|extracted',
		);
		expect(existsSync(resolve(STORAGE_DIR, `extracted/${sourceId}/layout.json`))).toBe(true);
		expect(existsSync(resolve(STORAGE_DIR, `extracted/${sourceId}/pages/page-001.png`))).toBe(true);
		expect(sourceStepStatus(sourceId, 'segment')).toBe('missing');
	});

	it('QA-05: extract --all dispatches mixed layout and pre-structured sources independently', () => {
		if (!pgAvailable) return;
		const textSourceId = seedTextSource('mixed-note.pdf');
		const imageIngest = runCli(['ingest', imageFile]);
		expect(imageIngest.exitCode, `${imageIngest.stdout}\n${imageIngest.stderr}`).toBe(0);
		const imageSourceId = sourceIdForFilename(basename(imageFile));

		const extractAll = runCli(['extract', '--all'], { timeout: 240_000 });
		expect(extractAll.exitCode, `${extractAll.stdout}\n${extractAll.stderr}`).toBe(0);

		expect(db.runSql(`SELECT status FROM sources WHERE id = ${sqlLiteral(textSourceId)};`)).toBe('extracted');
		expect(db.runSql(`SELECT status FROM sources WHERE id = ${sqlLiteral(imageSourceId)};`)).toBe('extracted');
		expect(db.runSql(`SELECT COUNT(*) FROM stories WHERE source_id = ${sqlLiteral(textSourceId)};`)).toBe('1');
		expect(existsSync(resolve(STORAGE_DIR, `extracted/${textSourceId}/layout.json`))).toBe(false);
		expect(existsSync(resolve(STORAGE_DIR, `extracted/${imageSourceId}/layout.json`))).toBe(true);
	});
});
